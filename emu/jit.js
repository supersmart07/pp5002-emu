// Block translator for the ARM7 cores. A run of ARM-mode instructions that executes often is compiled once into
// a JavaScript function, so the hot loops of the firmware (MP3 synthesis, text drawing) stop paying for fetching
// and decoding every instruction every time.
//
// Blocks are exact stand-ins for the interpreter (arm7.js), so emulation stays bit-identical:
//   - a block runs only when the whole block fits in the core's remaining instruction budget;
//   - it ends after any access that is not plain RAM (I/O can raise interrupts or put a core to sleep), after
//     anything handed back to the interpreter that changed the PC, and at every branch;
//   - writing to memory that holds translated code throws all translations away (and ends the running block).
// Instructions with rare or awkward semantics (PSR access, LDM/STM, halfwords, SWI, coprocessor/trap opcodes,
// writes to r15 other than branches) are executed by calling the interpreter's own code for that instruction.
'use strict';

const JIT_HOT = 500;        // executions before a block is translated
const JIT_MAX = 32;         // instructions per block
const JIT_NONE = -0x7FFFFFFF;

class ArmJit {
  // Blocks pay off on V8 (Chromium-based browsers: about twice the speed of the interpreter), but on
  // JavaScriptCore the thousands of small generated functions stay in its baseline tier and run slower than the
  // interpreter, so other engines keep interpreting. ARM_JIT (a global set before the emulator starts) overrides.
  static enabledByDefault() {
    if (typeof ARM_JIT !== 'undefined') return !!ARM_JIT;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /Chrome\/|Chromium\//.test(ua) && !/CriOS|Firefox/.test(ua);
  }

  constructor(sys) {
    this.sys = sys;
    this.sdIdx = new Int32Array(0x100000);           // logical 0..4 MB (SDRAM), per word: >0 block id, <=0 -count
    this.irIdx = new Int32Array(IRAM_SIZE >> 2);     // logical 0x40000000.. (IRAM)
    this.sdCode = sys.sdCode;                        // per physical word: 1 = part of a translated block
    this.irCode = sys.irCode;
    this.fns = [null]; this.lens = [0];
    this.gen = 0;                                    // bumped on every flush; blocks compare it after writes
    this.flushes = 0; this.compiled = 0;
    this.failed = null;                              // set when the page forbids generated code (CSP without eval)
  }

  flush() {
    if (this.fns.length > 1) {
      this.sdIdx.fill(0); this.irIdx.fill(0); this.sdCode.fill(0); this.irCode.fill(0);
      this.fns = [null]; this.lens = [0];
    }
    this.gen++; this.flushes++;
  }

  // block id for the instruction at logical address pc (ARM state), or 0 to interpret it
  lookup(pc) {
    if (this.failed !== null) return 0;
    let tab, key;
    if ((pc >>> 22) === 0) { tab = this.sdIdx; key = pc >>> 2; }
    else if ((pc >>> 20) === 0x400 && (pc & 0xFFFFF) < IRAM_SIZE) { tab = this.irIdx; key = (pc & 0x1FFFF) >>> 2; }
    else return 0;
    const v = tab[key];
    if (v > 0) return v;
    if (v === JIT_NONE) return 0;
    if (v > -JIT_HOT) { tab[key] = v - 1; return 0; }
    const id = this.compile(pc);
    tab[key] = id > 0 ? id : JIT_NONE;
    return id > 0 ? id : 0;
  }

  compile(pc0) {
    const sys = this.sys, p0 = pc0 >>> 20, k0 = sys.pageKind[p0];
    if (k0 !== 1 && k0 !== 2) return 0;
    const body = [];
    let pc = pc0, n = 0, ended = false;
    while (n < JIT_MAX && !ended && (pc >>> 20) === p0) {
      let op;
      if (k0 === 1) { const o = (sys.pageOff[p0] + (pc & 0xFFFFF)) & SDRAM_MASK; op = sys.sd32[o >>> 2]; this.sdCode[o >>> 2] = 1; }
      else { const o = pc & 0x1FFFF; if (o >= IRAM_SIZE) break; op = sys.ir32[o >>> 2]; this.irCode[o >>> 2] = 1; }
      n++;
      const t = this.translate(op, pc, n);
      body.push(t.code);
      ended = t.end;
      pc = (pc + 4) | 0;
    }
    if (n === 0) return 0;
    // fall-through exit (also reached after a last instruction that did not branch, e.g. a trap that fell through)
    body.push(`r[15] = ${(pc + 4) | 0}; cpu.pc = ${pc}; return ${n};`);
    const src = `'use strict'; return function block_${(pc0 >>> 0).toString(16)}(cpu) {\n` +
      `const r = cpu.r, bus = cpu.bus, jit = cpu.jit;\nlet v = 0, a = 0, b = 0, o = 0, p = 0, s = 0;\n${body.join('\n')}\n};`;
    let fn;
    try {
      fn = new Function('sd32', 'sdCode', 'ir32', 'irCode', 'kind', 'pageOff', 'G', src)(
        sys.sd32, this.sdCode, sys.ir32, this.irCode, sys.pageKind, sys.pageOff, this.gen);
    } catch (e) {                                    // e.g. a Content-Security-Policy without 'unsafe-eval'
      this.failed = String(e && e.message || e);
      this.flush();
      return 0;
    }
    this.fns.push(fn); this.lens.push(n); this.compiled++;
    return this.fns.length - 1;
  }

  // JS for one instruction. k = instructions executed once this one has run (the value a block returns).
  translate(op, pc, k) {
    const cond = op >>> 28, pc8 = (pc + 8) | 0, next = (pc + 4) | 0;
    // after anything that may have touched I/O or run interpreter code: stop if the interpreter would act now
    const check = `if (cpu.pc !== ${next} || cpu.halted || jit.gen !== G || (cpu.fiq && cpu.F === 0) || (cpu.irq && cpu.I === 0)) { r[15] = ${pc8}; return ${k}; }`;
    const fallback = (end) => ({ code: guard(cond, `r[15] = ${pc8}; cpu.pc = ${next}; cpu.arm(${op | 0}, ${pc}); ${check}`), end });
    if (cond === 0xF) return { code: '', end: false };              // never executes on ARMv4
    const top = (op >>> 25) & 7;
    const reg = (n, val) => n === 15 ? `${val}` : `r[${n}]`;

    if (top === 5) {                                                 // B / BL
      const target = (pc8 + ((op << 8) >> 6)) | 0;
      const link = op & 0x01000000 ? `r[14] = ${next}; ` : '';
      if (cond === 0xE) return { code: `${link}r[15] = ${pc8}; cpu.pc = ${target}; return ${k};`, end: true };
      return { code: `if (${condExpr(cond)}) { ${link}r[15] = ${pc8}; cpu.pc = ${target}; return ${k}; }\nr[15] = ${pc8}; cpu.pc = ${next}; return ${k};`, end: true };
    }

    if (top === 0 || top === 1) {
      if ((op & 0x0FFFFFF0) === 0x012FFF10) return fallback(cond === 0xE);   // BX
      if (top === 0 && (op & 0x90) === 0x90) {
        const rdM = (op >>> 16) & 15, rnM = (op >>> 12) & 15, rsM = (op >>> 8) & 15, rmM = op & 15;
        if ((op & 0x0FC000F0) === 0x00000090 && rdM !== 15 && rnM !== 15 && rsM !== 15 && rmM !== 15) {   // MUL / MLA
          let c = `v = Math.imul(r[${rmM}], r[${rsM}])${op & 0x00200000 ? ` + r[${rnM}] | 0` : ''}; r[${rdM}] = v;`;
          if (op & 0x00100000) c += ' cpu.N = v >>> 31; cpu.Z = v === 0 ? 1 : 0;';
          return { code: guard(cond, c), end: false };
        }
        if ((op & 0x0F8000F0) === 0x00800090 && rdM !== 15 && rnM !== 15 && rsM !== 15 && rmM !== 15)     // UMULL..SMLAL
          return { code: guard(cond, `cpu.armMulLong(${op | 0});`), end: false };
        return fallback(false);                                     // SWP, halfword transfers
      }
      const opcode = (op >>> 21) & 15, S = (op >>> 20) & 1, rn = (op >>> 16) & 15, rd = (op >>> 12) & 15;
      if (!S && opcode >= 8 && opcode <= 11) return fallback(false); // MRS / MSR
      if (rd === 15) return fallback(cond === 0xE);                 // writes the PC (or restores CPSR)
      const regShift = top === 0 && (op & 0x10) !== 0;
      const needSc = S && (opcode <= 1 || (opcode >= 8 && opcode <= 9) || opcode >= 12);
      let pre = '', bx, sc = 'cpu.C';
      if (top === 1) {
        const rot = ((op >>> 8) & 15) << 1, imm = op & 0xFF;
        const val = rot ? ((imm >>> rot) | (imm << (32 - rot))) | 0 : imm;
        bx = `${val}`;
        if (rot) sc = `${val >>> 31}`;
      } else if (regShift) {
        pre = `r[15] = ${pc8}; b = cpu.shiftReg(${op | 0}); `;     // also sets cpu.sc
        bx = 'b'; sc = 'cpu.sc';
      } else {
        const s = shiftImmCode(op, reg(op & 15, pc8), needSc);
        pre = s.pre; bx = s.val; if (needSc) sc = s.sc;
      }
      const ax = rn === 15 ? `${regShift ? (pc + 12) | 0 : pc8}` : `r[${rn}]`;
      const logic = (expr) => S ? `v = ${expr}; cpu.N = v >>> 31; cpu.Z = v === 0 ? 1 : 0; cpu.C = ${sc};` : `v = ${expr};`;
      let c;
      switch (opcode) {
        case 0x0: c = logic(`${ax} & ${bx}`); break;
        case 0x1: c = logic(`${ax} ^ ${bx}`); break;
        case 0x2: c = S ? `v = cpu.add(${ax}, ~(${bx}), 1, true);` : `v = (${ax} - ${bx}) | 0;`; break;
        case 0x3: c = S ? `v = cpu.add(${bx}, ~(${ax}), 1, true);` : `v = (${bx} - ${ax}) | 0;`; break;
        case 0x4: c = S ? `v = cpu.add(${ax}, ${bx}, 0, true);` : `v = (${ax} + ${bx}) | 0;`; break;
        case 0x5: c = S ? `v = cpu.add(${ax}, ${bx}, cpu.C, true);` : `v = (${ax} + ${bx} + cpu.C) | 0;`; break;
        case 0x6: c = S ? `v = cpu.add(${ax}, ~(${bx}), cpu.C, true);` : `v = (${ax} + ~(${bx}) + cpu.C) | 0;`; break;
        case 0x7: c = S ? `v = cpu.add(${bx}, ~(${ax}), cpu.C, true);` : `v = (${bx} + ~(${ax}) + cpu.C) | 0;`; break;
        case 0x8: c = `v = ${ax} & ${bx}; cpu.N = v >>> 31; cpu.Z = v === 0 ? 1 : 0; cpu.C = ${sc};`; break;
        case 0x9: c = `v = ${ax} ^ ${bx}; cpu.N = v >>> 31; cpu.Z = v === 0 ? 1 : 0; cpu.C = ${sc};`; break;
        case 0xA: c = `cpu.add(${ax}, ~(${bx}), 1, true);`; break;
        case 0xB: c = `cpu.add(${ax}, ${bx}, 0, true);`; break;
        case 0xC: c = logic(`${ax} | ${bx}`); break;
        case 0xD: c = logic(`${bx}`); break;
        case 0xE: c = logic(`${ax} & ~(${bx})`); break;
        default: c = logic(`~(${bx})`); break;
      }
      if (opcode < 8 || opcode > 11) c += ` r[${rd}] = v;`;
      return { code: guard(cond, pre + c), end: false };
    }

    if (top === 2 || top === 3) {                                    // LDR / STR / LDRB / STRB
      if (top === 3 && (op & 0x10)) return fallback(cond === 0xE);  // undefined: hint traps live here
      const P = (op >>> 24) & 1, U = (op >>> 23) & 1, B = (op >>> 22) & 1, W = (op >>> 21) & 1, L = (op >>> 20) & 1;
      const rn = (op >>> 16) & 15, rd = (op >>> 12) & 15;
      if (L && rd === 15) return fallback(cond === 0xE);
      let pre = '', off;
      if (top === 2) off = `${op & 0xFFF}`;
      else { const s = shiftImmCode(op, reg(op & 15, pc8), false); pre = s.pre; off = s.val; }
      const base = reg(rn, pc8);
      const wbx = U ? `(${base} + ${off}) | 0` : `(${base} - ${off}) | 0`;
      let c = pre + `b = ${wbx}; a = ${P ? 'b' : base}; `;
      const writeback = (!P || W) && rn !== 15 ? `r[${rn}] = b; ` : '';
      // s: 0 = SDRAM, 1 = IRAM, 2 = through the bus (I/O and anything else; may need to stop afterwards)
      const where = `p = a >>> 20; s = kind[p] === 1 ? 0 : (kind[p] === 2 && (a & 0x1FFFF) < ${IRAM_SIZE}) ? 1 : 2; `;
      const sdIdx = `((pageOff[p] + (a & 0xFFFFF)) & ${SDRAM_MASK}) >>> 2`, irIdx = `(a & 0x1FFFF) >>> 2`;
      const after = `if (s === 2) ${ioExit(pc8, k)}`;
      if (L && B) c += `v = bus.read8(a); ${writeback}r[${rd}] = v; ${ioExit(pc8, k)}`;
      else if (L) c += where + `v = s === 0 ? sd32[${sdIdx}] : s === 1 ? ir32[${irIdx}] : bus.read32(a & ~3); ` +
        `if (a & 3) v = (v >>> ((a & 3) << 3)) | (v << (32 - ((a & 3) << 3))); ${writeback}r[${rd}] = v; ${after}`;
      else {
        const val = rd === 15 ? `${(pc + 12) | 0}` : `r[${rd}]`;
        if (B) c += `bus.write8(a, ${val} & 0xFF); ${writeback}${ioExit(pc8, k)}`;
        else c += `v = ${val}; ` + where +
          `if (s === 0) { o = ${sdIdx}; sd32[o] = v; ${writeback}if (sdCode[o] !== 0) { jit.flush(); r[15] = ${pc8}; cpu.pc = ${next}; return ${k}; } } ` +
          `else if (s === 1) { o = ${irIdx}; ir32[o] = v; ${writeback}if (irCode[o] !== 0) { jit.flush(); r[15] = ${pc8}; cpu.pc = ${next}; return ${k}; } } ` +
          `else { bus.write32(a & ~3, v); ${writeback}${ioExit(pc8, k)} }`;
      }
      return { code: guard(cond, c), end: false };
    }

    // LDM/STM, coprocessor, SWI and undefined opcodes: the interpreter runs them
    if (top === 4) return fallback(cond === 0xE && (op & 0x00108000) === 0x00108000);   // LDM with r15 ends here
    return fallback(cond === 0xE);
  }
}

// interrupt / sleep / flush check after a bus access, for blocks that continue to the next instruction
function ioExit(pc8, k) {
  return `if (cpu.halted || jit.gen !== G || (cpu.fiq && cpu.F === 0) || (cpu.irq && cpu.I === 0)) { r[15] = ${pc8}; cpu.pc = ${(pc8 - 4) | 0}; return ${k}; }`;
}

function guard(cond, code) { return cond === 0xE ? code : `if (${condExpr(cond)}) { ${code} }`; }

function condExpr(c) {
  return ['cpu.Z === 1', 'cpu.Z === 0', 'cpu.C === 1', 'cpu.C === 0', 'cpu.N === 1', 'cpu.N === 0', 'cpu.V === 1', 'cpu.V === 0',
    '(cpu.C === 1 && cpu.Z === 0)', '(cpu.C === 0 || cpu.Z === 1)', 'cpu.N === cpu.V', 'cpu.N !== cpu.V',
    '(cpu.Z === 0 && cpu.N === cpu.V)', '(cpu.Z === 1 || cpu.N !== cpu.V)', 'true', 'false'][c];
}

// operand-2 shift by an immediate amount, with the shifter carry when asked (matches ARM7.shiftImm)
function shiftImmCode(op, src, wantSc) {
  const type = (op >>> 5) & 3, amt = (op >>> 7) & 31;
  const pre = `o = ${src}; `;
  switch (type) {
    case 0: return amt === 0 ? { pre, val: 'o', sc: 'cpu.C' } : { pre, val: `(o << ${amt})`, sc: `((o >>> ${32 - amt}) & 1)` };
    case 1: return amt === 0 ? { pre, val: '0', sc: '(o >>> 31)' } : { pre, val: `((o >>> ${amt}) | 0)`, sc: `((o >>> ${amt - 1}) & 1)` };
    case 2: return amt === 0 ? { pre, val: '(o >> 31)', sc: '(o >>> 31)' } : { pre, val: `(o >> ${amt})`, sc: `((o >>> ${amt - 1}) & 1)` };
    default: return amt === 0 ? { pre, val: '((cpu.C << 31) | (o >>> 1))', sc: '(o & 1)' }
      : { pre, val: `((o >>> ${amt}) | (o << ${32 - amt}))`, sc: `((o >>> ${amt - 1}) & 1)` };
  }
}

if (typeof module !== 'undefined') module.exports = { ArmJit };

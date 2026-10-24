// ARM7TDMI interpreter (ARMv4T: ARM + Thumb). No MMU, no coprocessors.
// The bus provides read8/16/32 and write8/16/32.
// Registers and instruction words are kept as signed 32-bit integers (Int32Array, `| 0`): JS engines run
// int32 bit operations on fast paths, while unsigned values above 2^31 would turn into doubles.
'use strict';

const MODE_USR = 0x10, MODE_FIQ = 0x11, MODE_IRQ = 0x12, MODE_SVC = 0x13,
      MODE_ABT = 0x17, MODE_UND = 0x1B, MODE_SYS = 0x1F;

class ARM7 {
  constructor(bus, name) {
    this.bus = bus;
    this.name = name || 'cpu';
    this.r = new Int32Array(16);
    // banked registers: r8-r14 for usr/sys and fiq, r13-r14 for the other modes, spsr per mode
    this.bankUsr = new Int32Array(7);
    this.bankFiq = new Int32Array(7);
    this.bank = { [MODE_IRQ]: new Int32Array(2), [MODE_SVC]: new Int32Array(2), [MODE_ABT]: new Int32Array(2), [MODE_UND]: new Int32Array(2) };
    this.spsr = { [MODE_FIQ]: 0, [MODE_IRQ]: 0, [MODE_SVC]: 0, [MODE_ABT]: 0, [MODE_UND]: 0 };
    this.N = 0; this.Z = 0; this.C = 0; this.V = 0;
    this.I = 1; this.F = 1; this.T = 0; this.mode = MODE_SVC;
    this.pc = 0;            // next instruction; advanced before an instruction executes, so branches just overwrite it
    this.sc = 0;            // shifter carry out
    // SDRAM fast path for fetches and word loads/stores when the bus exposes its page table (PP5002)
    this.pageKind = bus.pageKind; this.pageOff = bus.pageOff; this.sd32 = bus.sd32;
    this.irq = false;       // levels of the interrupt lines, driven by the system
    this.fiq = false;
    this.halted = false;
    this.cycles = 0;
    this.onUndefined = null; // hook(cpu, instr, addr) -> true if handled
    this.breakpoints = null; // debug: Map(address -> fn(cpu)), checked before each instruction
    this.jit = null;         // block translator (jit.js), shared by both cores; null = interpret everything
  }

  // ---------- save / restore (plain structured-cloneable objects) ----------
  save() {
    const bank = {}; for (const m in this.bank) bank[m] = this.bank[m].slice();
    return { r: this.r.slice(), bankUsr: this.bankUsr.slice(), bankFiq: this.bankFiq.slice(), bank, spsr: { ...this.spsr },
      N: this.N, Z: this.Z, C: this.C, V: this.V, I: this.I, F: this.F, T: this.T, mode: this.mode,
      pc: this.pc, halted: this.halted, wakeAt: this.wakeAt, cycles: this.cycles };
  }
  load(o) {
    this.r.set(o.r); this.bankUsr.set(o.bankUsr); this.bankFiq.set(o.bankFiq);
    for (const m in o.bank) this.bank[m].set(o.bank[m]);
    Object.assign(this.spsr, o.spsr);
    ({ N: this.N, Z: this.Z, C: this.C, V: this.V, I: this.I, F: this.F, T: this.T, mode: this.mode, pc: this.pc, halted: this.halted, wakeAt: this.wakeAt, cycles: this.cycles } = o);
  }

  reset(pc) {
    this.mode = MODE_SVC; this.I = 1; this.F = 1; this.T = 0;
    this.pc = pc | 0; this.halted = false;
  }

  // ---------- status registers ----------
  getCPSR() {
    return (this.N << 31) | (this.Z << 30) | (this.C << 29) | (this.V << 28) |
      (this.I << 7) | (this.F << 6) | (this.T << 5) | this.mode;
  }
  setCPSR(v) {
    this.N = (v >>> 31) & 1; this.Z = (v >>> 30) & 1; this.C = (v >>> 29) & 1; this.V = (v >>> 28) & 1;
    this.I = (v >>> 7) & 1; this.F = (v >>> 6) & 1; this.T = (v >>> 5) & 1;
    this.switchMode(v & 0x1F);
  }
  getSPSR() { const s = this.spsr[this.mode]; return s === undefined ? this.getCPSR() : s; }
  setSPSR(v) { if (this.spsr[this.mode] !== undefined) this.spsr[this.mode] = v | 0; }

  switchMode(m) {
    const old = this.mode;
    if (m === old) return;
    const r = this.r;
    if (old === MODE_FIQ) { for (let i = 0; i < 7; i++) this.bankFiq[i] = r[8 + i]; }
    else {
      if (old === MODE_USR || old === MODE_SYS) { this.bankUsr[5] = r[13]; this.bankUsr[6] = r[14]; }
      else { const b = this.bank[old]; if (b) { b[0] = r[13]; b[1] = r[14]; } }
      if (m === MODE_FIQ) for (let i = 0; i < 5; i++) this.bankUsr[i] = r[8 + i];
    }
    if (m === MODE_FIQ) { for (let i = 0; i < 7; i++) r[8 + i] = this.bankFiq[i]; }
    else {
      if (old === MODE_FIQ) for (let i = 0; i < 5; i++) r[8 + i] = this.bankUsr[i];
      if (m === MODE_USR || m === MODE_SYS) { r[13] = this.bankUsr[5]; r[14] = this.bankUsr[6]; }
      else { const b = this.bank[m]; if (b) { r[13] = b[0]; r[14] = b[1]; } }
    }
    this.mode = m;
  }

  // user-bank register access for LDM/STM with the S bit
  getUserReg(n) {
    if (n < 8 || n === 15 || this.mode === MODE_USR || this.mode === MODE_SYS) return this.r[n];
    if (this.mode === MODE_FIQ) return this.bankUsr[n - 8];
    if (n < 13) return this.r[n];
    return this.bankUsr[n - 8];
  }
  setUserReg(n, v) {
    if (n < 8 || n === 15 || this.mode === MODE_USR || this.mode === MODE_SYS) { this.r[n] = v; return; }
    if (this.mode === MODE_FIQ) { this.bankUsr[n - 8] = v; return; }
    if (n < 13) { this.r[n] = v; return; }
    this.bankUsr[n - 8] = v;
  }

  exception(mode, vector, lr) {
    const cpsr = this.getCPSR();
    this.switchMode(mode);
    this.spsr[mode] = cpsr;
    this.r[14] = lr;
    this.T = 0; this.I = 1;
    if (mode === MODE_FIQ || vector === 0) this.F = 1;
    this.pc = vector;
  }

  condPass(c) {
    switch (c) {
      case 0x0: return this.Z === 1;
      case 0x1: return this.Z === 0;
      case 0x2: return this.C === 1;
      case 0x3: return this.C === 0;
      case 0x4: return this.N === 1;
      case 0x5: return this.N === 0;
      case 0x6: return this.V === 1;
      case 0x7: return this.V === 0;
      case 0x8: return this.C === 1 && this.Z === 0;
      case 0x9: return this.C === 0 || this.Z === 1;
      case 0xA: return this.N === this.V;
      case 0xB: return this.N !== this.V;
      case 0xC: return this.Z === 0 && this.N === this.V;
      case 0xD: return this.Z === 1 || this.N !== this.V;
      case 0xE: return true;
      default: return false; // 0xF: never on ARMv4
    }
  }

  // ---------- arithmetic helpers (int32 in, int32 out) ----------
  add(a, b, c, s) {
    const res = (a + b + c) | 0;
    if (s) {
      this.N = res >>> 31; this.Z = res === 0 ? 1 : 0;
      this.C = ((a >>> 0) + (b >>> 0) + c) > 0xFFFFFFFF ? 1 : 0;
      this.V = ((~(a ^ b) & (a ^ res)) >>> 31);
    }
    return res;
  }
  sub(a, b, c, s) { return this.add(a, ~b, c, s); }
  logicFlags(res, carry) { this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; this.C = carry; }

  // ---------- execution ----------
  // Runs n instructions (fewer if the core halts). With the block translator, ARM code runs as compiled blocks
  // whenever a whole block fits in what is left of n; everything else goes through the interpreter.
  run(n) {
    const jit = this.jit;
    if (jit === null || this.breakpoints !== null) return this.interpret(n);
    let i = 0;
    while (i < n) {
      if (this.halted) break;
      if (this.fiq && !this.F) this.exception(MODE_FIQ, 0x1C, (this.pc + 4) | 0);
      else if (this.irq && !this.I) this.exception(MODE_IRQ, 0x18, (this.pc + 4) | 0);
      if (this.T === 0) {
        const id = jit.lookup(this.pc);
        if (id !== 0 && i + jit.lens[id] <= n) { i += jit.fns[id](this); continue; }
      }
      this.interpret1();
      i++;
    }
    this.cycles += i;
    return i;
  }

  // one instruction at this.pc (interrupts already checked)
  interpret1() {
    const bus = this.bus, r = this.r, pc = this.pc;
    if (this.T) {
      const op = bus.read16(pc);
      r[15] = (pc + 4) | 0;
      this.pc = (pc + 2) | 0;
      this.thumb(op, pc);
    } else {
      const op = bus.read32(pc);
      r[15] = (pc + 8) | 0;
      this.pc = (pc + 4) | 0;
      const cond = op >>> 28;
      if (cond === 0xE || this.condPass(cond)) this.arm(op, pc);
    }
  }

  interpret(n) {
    const bus = this.bus, r = this.r;
    const kind = this.pageKind, pageOff = this.pageOff, sd32 = this.sd32, fastFetch = kind !== undefined;
    let i = 0;
    for (; i < n; i++) {
      if (this.halted) break;
      if (this.fiq && !this.F) this.exception(MODE_FIQ, 0x1C, (this.pc + 4) | 0);
      else if (this.irq && !this.I) this.exception(MODE_IRQ, 0x18, (this.pc + 4) | 0);
      const pc = this.pc;
      if (this.breakpoints !== null) { const bp = this.breakpoints.get(pc); if (bp) bp(this); }
      if (this.T) {
        const op = bus.read16(pc);
        r[15] = (pc + 4) | 0;
        this.pc = (pc + 2) | 0;
        this.thumb(op, pc);
      } else {
        const p = pc >>> 20;
        const op = fastFetch && kind[p] === 1 ? sd32[((pageOff[p] + (pc & 0xFFFFF)) & 0x1FFFFFF) >>> 2] : bus.read32(pc);
        r[15] = (pc + 8) | 0;
        this.pc = (pc + 4) | 0;
        const cond = op >>> 28;
        if (cond === 0xE || this.condPass(cond)) this.arm(op, pc);
      }
    }
    this.cycles += i;
    return i;
  }

  setPC(v) { this.pc = v | 0; }
  // register write from an ARM instruction; writing r15 branches
  wr(d, v) {
    if (d === 15) this.setPC(v & ~3);
    else this.r[d] = v;
  }

  shiftImm(op) {
    const v = this.r[op & 15];
    const type = (op >>> 5) & 3, amt = (op >>> 7) & 31;
    switch (type) {
      case 0: // LSL
        if (amt === 0) { this.sc = this.C; return v; }
        this.sc = (v >>> (32 - amt)) & 1; return v << amt;
      case 1: // LSR (#0 means #32)
        if (amt === 0) { this.sc = v >>> 31; return 0; }
        this.sc = (v >>> (amt - 1)) & 1; return (v >>> amt) | 0;
      case 2: // ASR (#0 means #32)
        if (amt === 0) { this.sc = v >>> 31; return v >> 31; }
        this.sc = (v >>> (amt - 1)) & 1; return v >> amt;
      default: // ROR, or RRX for #0
        if (amt === 0) { this.sc = v & 1; return (this.C << 31) | (v >>> 1); }
        this.sc = (v >>> (amt - 1)) & 1; return (v >>> amt) | (v << (32 - amt));
    }
  }
  shiftReg(op) {
    const rm = op & 15;
    const v = rm === 15 ? (this.r[15] + 4) | 0 : this.r[rm];
    const amt = this.r[(op >>> 8) & 15] & 0xFF, type = (op >>> 5) & 3;
    if (amt === 0) { this.sc = this.C; return v; }
    switch (type) {
      case 0:
        if (amt < 32) { this.sc = (v >>> (32 - amt)) & 1; return v << amt; }
        this.sc = amt === 32 ? v & 1 : 0; return 0;
      case 1:
        if (amt < 32) { this.sc = (v >>> (amt - 1)) & 1; return (v >>> amt) | 0; }
        this.sc = amt === 32 ? v >>> 31 : 0; return 0;
      case 2:
        if (amt < 32) { this.sc = (v >>> (amt - 1)) & 1; return v >> amt; }
        this.sc = v >>> 31; return v >> 31;
      default: {
        const a = amt & 31;
        if (a === 0) { this.sc = v >>> 31; return v; }
        this.sc = (v >>> (a - 1)) & 1; return (v >>> a) | (v << (32 - a));
      }
    }
  }

  arm(op, pc) {
    const bus = this.bus, r = this.r;
    const top = (op >>> 25) & 7;
    switch (top) {
      case 0: case 1: {
        if (top === 0) {
          if ((op & 0x0FFFFFF0) === 0x012FFF10) { // BX
            const v = r[op & 15];
            this.T = v & 1; this.setPC(v & (this.T ? ~1 : ~3)); return;
          }
          if ((op & 0x90) === 0x90) {
            if ((op & 0x0FC000F0) === 0x00000090) return this.armMul(op);
            if ((op & 0x0F8000F0) === 0x00800090) return this.armMulLong(op);
            if ((op & 0x0FB00FF0) === 0x01000090) return this.armSwap(op);
            if (op & 0x60) return this.armHalf(op);
          }
        }
        const opcode = (op >>> 21) & 15, S = (op >>> 20) & 1;
        if (!S && opcode >= 8 && opcode <= 11) return this.armPsr(op, pc);
        let b;
        if (top === 1) {
          const rot = ((op >>> 8) & 15) << 1, imm = op & 0xFF;
          b = rot ? (imm >>> rot) | (imm << (32 - rot)) : imm;
          this.sc = rot ? b >>> 31 : this.C;
        } else if (op & 0x10) b = this.shiftReg(op);
        else b = this.shiftImm(op);
        const rn = (op >>> 16) & 15, rd = (op >>> 12) & 15;
        let a = r[rn];
        if (rn === 15 && top === 0 && (op & 0x10)) a = (a + 4) | 0;
        const sf = S && rd !== 15;
        let res;
        switch (opcode) {
          case 0x0: res = a & b; if (sf) this.logicFlags(res, this.sc); break;
          case 0x1: res = a ^ b; if (sf) this.logicFlags(res, this.sc); break;
          case 0x2: res = this.add(a, ~b, 1, sf); break;
          case 0x3: res = this.add(b, ~a, 1, sf); break;
          case 0x4: res = this.add(a, b, 0, sf); break;
          case 0x5: res = this.add(a, b, this.C, sf); break;
          case 0x6: res = this.add(a, ~b, this.C, sf); break;
          case 0x7: res = this.add(b, ~a, this.C, sf); break;
          case 0x8: this.logicFlags(a & b, this.sc); if (rd === 15) this.setCPSR(this.getSPSR()); return;
          case 0x9: this.logicFlags(a ^ b, this.sc); if (rd === 15) this.setCPSR(this.getSPSR()); return;
          case 0xA: this.add(a, ~b, 1, true); if (rd === 15) this.setCPSR(this.getSPSR()); return;
          case 0xB: this.add(a, b, 0, true); if (rd === 15) this.setCPSR(this.getSPSR()); return;
          case 0xC: res = a | b; if (sf) this.logicFlags(res, this.sc); break;
          case 0xD: res = b; if (sf) this.logicFlags(res, this.sc); break;
          case 0xE: res = a & ~b; if (sf) this.logicFlags(res, this.sc); break;
          default: res = ~b; if (sf) this.logicFlags(res, this.sc); break;
        }
        if (rd === 15) {
          if (S) { this.setCPSR(this.getSPSR()); this.setPC(res & (this.T ? ~1 : ~3)); }
          else this.setPC(res & ~3);
        } else r[rd] = res;
        return;
      }
      case 2: case 3: {
        if (top === 3 && (op & 0x10)) return this.undefinedInstr(op, pc);
        const P = (op >>> 24) & 1, U = (op >>> 23) & 1, B = (op >>> 22) & 1, W = (op >>> 21) & 1, L = (op >>> 20) & 1;
        const rn = (op >>> 16) & 15, rd = (op >>> 12) & 15;
        const off = top === 2 ? op & 0xFFF : this.shiftImm(op);
        const base = r[rn];
        const wb = U ? (base + off) | 0 : (base - off) | 0;
        const addr = P ? wb : base;
        const kind = this.pageKind, p = addr >>> 20, fast = kind !== undefined && kind[p] === 1;
        if (L) {
          let v;
          if (B) v = bus.read8(addr);
          else {
            v = fast ? this.sd32[((this.pageOff[p] + (addr & 0xFFFFF)) & 0x1FFFFFF) >>> 2] : bus.read32(addr & ~3);
            const rot = (addr & 3) << 3;
            if (rot) v = (v >>> rot) | (v << (32 - rot));
          }
          if ((!P || W) && rn !== 15) r[rn] = wb;
          this.wr(rd, v);
        } else {
          const v = rd === 15 ? (r[15] + 4) | 0 : r[rd];
          if (B) bus.write8(addr, v & 0xFF);
          else if (fast) {
            const o = (this.pageOff[p] + (addr & 0xFFFFF)) & 0x1FFFFFF;
            this.sd32[o >>> 2] = v;
            if (this.jit !== null && bus.sdCode[o >>> 2] !== 0) this.jit.flush();
          }
          else bus.write32(addr & ~3, v);
          if ((!P || W) && rn !== 15) r[rn] = wb;
        }
        return;
      }
      case 4: return this.armBlock(op);
      case 5: { // B / BL
        if (op & 0x01000000) r[14] = (pc + 4) | 0;
        this.setPC((r[15] + ((op << 8) >> 6)) | 0);
        return;
      }
      case 6: return this.undefinedInstr(op, pc); // coprocessor data transfer
      default:
        if ((op & 0x0F000000) === 0x0F000000) { this.exception(MODE_SVC, 0x08, (pc + 4) | 0); return; }
        return this.undefinedInstr(op, pc); // CDP / MCR / MRC
    }
  }

  undefinedInstr(op, pc) {
    if (this.onUndefined && this.onUndefined(this, op, pc)) return;
    this.exception(MODE_UND, 0x04, (pc + (this.T ? 2 : 4)) | 0);
  }

  armPsr(op, pc) {
    const r = this.r;
    if ((op & 0x0FBF0FFF) === 0x010F0000) { // MRS
      r[(op >>> 12) & 15] = (op & 0x00400000) ? this.getSPSR() : this.getCPSR();
      return;
    }
    if ((op & 0x0DB0F000) === 0x0120F000) { // MSR
      let v;
      if (op & 0x02000000) { const rot = ((op >>> 8) & 15) << 1, imm = op & 0xFF; v = rot ? (imm >>> rot) | (imm << (32 - rot)) : imm; }
      else v = r[op & 15];
      let mask = 0;
      if (op & 0x00080000) mask |= 0xFF000000;
      if (op & 0x00040000) mask |= 0x00FF0000;
      if (op & 0x00020000) mask |= 0x0000FF00;
      if (op & 0x00010000) mask |= 0x000000FF;
      if (op & 0x00400000) {
        this.setSPSR((this.getSPSR() & ~mask) | (v & mask));
      } else {
        if (this.mode === MODE_USR) mask &= 0xFF000000;
        const t = this.T;
        this.setCPSR((this.getCPSR() & ~mask) | (v & mask));
        this.T = t; // MSR cannot change the T bit
      }
      return;
    }
    return this.undefinedInstr(op, pc);
  }

  armMul(op) {
    const r = this.r;
    let res = Math.imul(r[op & 15], r[(op >>> 8) & 15]);
    if (op & 0x00200000) res = (res + r[(op >>> 12) & 15]) | 0;
    r[(op >>> 16) & 15] = res;
    if (op & 0x00100000) { this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; }
  }

  armMulLong(op) {
    const r = this.r;
    const hiR = (op >>> 16) & 15, loR = (op >>> 12) & 15;
    const a = r[op & 15], b = r[(op >>> 8) & 15], signed = (op & 0x00400000) !== 0;
    // The low word is exact with imul. The double product is within 2^12 of the true 64-bit product, and
    // product minus low word is an exact multiple of 2^32, so rounding its quotient gives the high word exactly.
    let lo = Math.imul(a, b);
    const prod = signed ? a * b : (a >>> 0) * (b >>> 0);
    let hi = Math.round((prod - (lo >>> 0)) / 4294967296) | 0;
    if (op & 0x00200000) { // accumulate
      const sum = (lo >>> 0) + (r[loR] >>> 0);
      lo = sum | 0;
      hi = (hi + r[hiR] + (sum > 0xFFFFFFFF ? 1 : 0)) | 0;
    }
    r[loR] = lo; r[hiR] = hi;
    if (op & 0x00100000) { this.N = hi >>> 31; this.Z = (hi === 0 && lo === 0) ? 1 : 0; }
  }

  armSwap(op) {
    const r = this.r, bus = this.bus;
    const addr = r[(op >>> 16) & 15], rd = (op >>> 12) & 15, rm = op & 15;
    if (op & 0x00400000) {
      const v = bus.read8(addr); bus.write8(addr, r[rm] & 0xFF); r[rd] = v;
    } else {
      let v = bus.read32(addr & ~3);
      const rot = (addr & 3) << 3;
      if (rot) v = (v >>> rot) | (v << (32 - rot));
      bus.write32(addr & ~3, r[rm]); r[rd] = v;
    }
  }

  armHalf(op) {
    const r = this.r, bus = this.bus;
    const P = (op >>> 24) & 1, U = (op >>> 23) & 1, I = (op >>> 22) & 1, W = (op >>> 21) & 1, L = (op >>> 20) & 1;
    const rn = (op >>> 16) & 15, rd = (op >>> 12) & 15, sh = (op >>> 5) & 3;
    const off = I ? ((op >>> 4) & 0xF0) | (op & 15) : r[op & 15];
    const base = r[rn];
    const wb = U ? (base + off) | 0 : (base - off) | 0;
    const addr = P ? wb : base;
    if (L) {
      let v;
      if (sh === 1) { v = bus.read16(addr & ~1); if (addr & 1) v = (v >>> 8) | (v << 24); }
      else if (sh === 2) v = (bus.read8(addr) << 24) >> 24;
      else v = (addr & 1) ? (bus.read8(addr) << 24) >> 24 : (bus.read16(addr) << 16) >> 16;
      if ((!P || W) && rn !== 15) r[rn] = wb;
      this.wr(rd, v);
    } else {
      const v = rd === 15 ? (r[15] + 4) | 0 : r[rd];
      bus.write16(addr & ~1, v & 0xFFFF);
      if ((!P || W) && rn !== 15) r[rn] = wb;
    }
  }

  armBlock(op) {
    const r = this.r, bus = this.bus;
    const P = (op >>> 24) & 1, U = (op >>> 23) & 1, S = (op >>> 22) & 1, W = (op >>> 21) & 1, L = (op >>> 20) & 1;
    const rn = (op >>> 16) & 15;
    let list = op & 0xFFFF;
    let n = 0; for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
    const base = r[rn];
    if (n === 0) { list = 0x8000; n = 16; } // ARM7 quirk: empty list transfers r15, base moves by 0x40
    let addr = U ? (P ? base + 4 : base) : (P ? base - n * 4 : base - n * 4 + 4);
    addr |= 0;
    const newBase = (U ? base + n * 4 : base - n * 4) | 0;
    const userBank = S && !(L && (list & 0x8000));
    if (L) {
      if (W) r[rn] = newBase;
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        const v = bus.read32(addr & ~3); addr = (addr + 4) | 0;
        if (i === 15) {
          if (S) { this.setCPSR(this.getSPSR()); this.setPC(v & (this.T ? ~1 : ~3)); }
          else this.setPC(v & ~3);
        } else if (userBank) this.setUserReg(i, v);
        else r[i] = v;
      }
    } else {
      let first = true;
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        let v;
        if (i === 15) v = (r[15] + 4) | 0;
        else if (userBank) v = this.getUserReg(i);
        else v = (i === rn && !first && W) ? newBase : r[i];
        bus.write32(addr & ~3, v); addr = (addr + 4) | 0;
        first = false;
      }
      if (W) r[rn] = newBase;
    }
  }

  // ---------- Thumb ----------
  thumb(op, pc) {
    const r = this.r, bus = this.bus;
    switch (op >>> 13) {
      case 0: {
        if ((op & 0x1800) === 0x1800) { // add/sub register or 3-bit immediate
          const rd = op & 7, rs = (op >>> 3) & 7, x = (op >>> 6) & 7;
          const b = (op & 0x400) ? x : r[x];
          r[rd] = (op & 0x200) ? this.add(r[rs], ~b, 1, true) : this.add(r[rs], b, 0, true);
          return;
        }
        const rd = op & 7, v = r[(op >>> 3) & 7], amt = (op >>> 6) & 31;
        let res;
        switch ((op >>> 11) & 3) {
          case 0: if (amt === 0) res = v; else { this.C = (v >>> (32 - amt)) & 1; res = v << amt; } break;
          case 1: if (amt === 0) { this.C = v >>> 31; res = 0; } else { this.C = (v >>> (amt - 1)) & 1; res = (v >>> amt) | 0; } break;
          default: if (amt === 0) { this.C = v >>> 31; res = v >> 31; } else { this.C = (v >>> (amt - 1)) & 1; res = v >> amt; } break;
        }
        r[rd] = res; this.N = res >>> 31; this.Z = res === 0 ? 1 : 0;
        return;
      }
      case 1: {
        const rd = (op >>> 8) & 7, imm = op & 0xFF;
        switch ((op >>> 11) & 3) {
          case 0: r[rd] = imm; this.N = 0; this.Z = imm === 0 ? 1 : 0; break;
          case 1: this.add(r[rd], ~imm, 1, true); break;
          case 2: r[rd] = this.add(r[rd], imm, 0, true); break;
          default: r[rd] = this.add(r[rd], ~imm, 1, true); break;
        }
        return;
      }
      case 2: {
        if ((op & 0xFC00) === 0x4000) return this.thumbAlu(op);
        if ((op & 0xFC00) === 0x4400) { // hi register operations / BX
          const rd = (op & 7) | ((op >>> 4) & 8), rs = (op >>> 3) & 15;
          const sv = r[rs];
          switch ((op >>> 8) & 3) {
            case 0: { const v = (r[rd] + sv) | 0; if (rd === 15) this.setPC(v & ~1); else r[rd] = v; return; }
            case 1: this.add(r[rd], ~sv, 1, true); return;
            case 2: if (rd === 15) this.setPC(sv & ~1); else r[rd] = sv; return;
            default: this.T = sv & 1; this.setPC(sv & (this.T ? ~1 : ~3)); return;
          }
        }
        if ((op & 0xF800) === 0x4800) { // PC-relative load
          r[(op >>> 8) & 7] = bus.read32(((r[15] & ~2) + ((op & 0xFF) << 2)) | 0);
          return;
        }
        // load/store with register offset (formats 7 and 8)
        const rd = op & 7, addr = (r[(op >>> 3) & 7] + r[(op >>> 6) & 7]) | 0;
        switch ((op >>> 9) & 7) {
          case 0: bus.write32(addr & ~3, r[rd]); return;
          case 1: bus.write16(addr & ~1, r[rd] & 0xFFFF); return;
          case 2: bus.write8(addr, r[rd] & 0xFF); return;
          case 3: r[rd] = (bus.read8(addr) << 24) >> 24; return;
          case 4: { let v = bus.read32(addr & ~3); const rot = (addr & 3) << 3; if (rot) v = (v >>> rot) | (v << (32 - rot)); r[rd] = v; return; }
          case 5: { let v = bus.read16(addr & ~1); if (addr & 1) v = (v >>> 8) | (v << 24); r[rd] = v; return; }
          case 6: r[rd] = bus.read8(addr); return;
          default: r[rd] = (addr & 1) ? (bus.read8(addr) << 24) >> 24 : (bus.read16(addr) << 16) >> 16; return;
        }
      }
      case 3: { // load/store with immediate offset
        const rd = op & 7, imm = (op >>> 6) & 31;
        const B = (op >>> 12) & 1;
        const addr = (r[(op >>> 3) & 7] + (B ? imm : imm << 2)) | 0;
        if (op & 0x800) {
          if (B) r[rd] = bus.read8(addr);
          else { let v = bus.read32(addr & ~3); const rot = (addr & 3) << 3; if (rot) v = (v >>> rot) | (v << (32 - rot)); r[rd] = v; }
        } else {
          if (B) bus.write8(addr, r[rd] & 0xFF); else bus.write32(addr & ~3, r[rd]);
        }
        return;
      }
      case 4: {
        if (!(op & 0x1000)) { // halfword immediate
          const rd = op & 7, addr = (r[(op >>> 3) & 7] + (((op >>> 6) & 31) << 1)) | 0;
          if (op & 0x800) { let v = bus.read16(addr & ~1); if (addr & 1) v = (v >>> 8) | (v << 24); r[rd] = v; }
          else bus.write16(addr & ~1, r[rd] & 0xFFFF);
          return;
        }
        const rd = (op >>> 8) & 7, addr = (r[13] + ((op & 0xFF) << 2)) | 0;
        if (op & 0x800) { let v = bus.read32(addr & ~3); const rot = (addr & 3) << 3; if (rot) v = (v >>> rot) | (v << (32 - rot)); r[rd] = v; }
        else bus.write32(addr & ~3, r[rd]);
        return;
      }
      case 5: {
        if (!(op & 0x1000)) { // load address
          r[(op >>> 8) & 7] = (((op & 0x800) ? r[13] : (r[15] & ~2)) + ((op & 0xFF) << 2)) | 0;
          return;
        }
        if ((op & 0xFF00) === 0xB000) { // add offset to SP
          const off = (op & 0x7F) << 2;
          r[13] = (op & 0x80) ? (r[13] - off) | 0 : (r[13] + off) | 0;
          return;
        }
        if ((op & 0xF600) === 0xB400) { // push / pop
          const list = op & 0xFF, R = (op >>> 8) & 1;
          if (op & 0x800) {
            let addr = r[13];
            for (let i = 0; i < 8; i++) if (list & (1 << i)) { r[i] = bus.read32(addr & ~3); addr = (addr + 4) | 0; }
            if (R) { this.setPC(bus.read32(addr & ~3) & ~1); addr = (addr + 4) | 0; }
            r[13] = addr;
          } else {
            let n = R; for (let i = 0; i < 8; i++) if (list & (1 << i)) n++;
            let addr = (r[13] - n * 4) | 0;
            r[13] = addr;
            for (let i = 0; i < 8; i++) if (list & (1 << i)) { bus.write32(addr & ~3, r[i]); addr = (addr + 4) | 0; }
            if (R) bus.write32(addr & ~3, r[14]);
          }
          return;
        }
        return this.undefinedInstr(op, pc);
      }
      case 6: {
        if (!(op & 0x1000)) { // LDMIA / STMIA
          const rb = (op >>> 8) & 7, list = op & 0xFF;
          let addr = r[rb];
          if (op & 0x800) {
            for (let i = 0; i < 8; i++) if (list & (1 << i)) { r[i] = bus.read32(addr & ~3); addr = (addr + 4) | 0; }
            if (!(list & (1 << rb))) r[rb] = addr;
          } else {
            let n = 0; for (let i = 0; i < 8; i++) if (list & (1 << i)) n++;
            const nb = (addr + n * 4) | 0; let first = true;
            for (let i = 0; i < 8; i++) if (list & (1 << i)) {
              bus.write32(addr & ~3, (i === rb && !first) ? nb : r[i]); addr = (addr + 4) | 0; first = false;
            }
            r[rb] = nb;
          }
          return;
        }
        const cond = (op >>> 8) & 15;
        if (cond === 15) { this.exception(MODE_SVC, 0x08, (pc + 2) | 0); return; }
        if (cond === 14) return this.undefinedInstr(op, pc);
        if (this.condPass(cond)) this.setPC((r[15] + (((op & 0xFF) << 24) >> 23)) | 0);
        return;
      }
      default: {
        if ((op & 0xF800) === 0xE000) { this.setPC((r[15] + (((op & 0x7FF) << 21) >> 20)) | 0); return; }
        if ((op & 0xF800) === 0xF000) { r[14] = (r[15] + (((op & 0x7FF) << 21) >> 9)) | 0; return; }
        if ((op & 0xF800) === 0xF800) {
          const target = (r[14] + ((op & 0x7FF) << 1)) | 0;
          r[14] = (pc + 2) | 1;
          this.setPC(target & ~1);
          return;
        }
        return this.undefinedInstr(op, pc);
      }
    }
  }

  thumbAlu(op) {
    const r = this.r;
    const rd = op & 7, s = r[(op >>> 3) & 7], d = r[rd];
    let res;
    switch ((op >>> 6) & 15) {
      case 0x0: res = d & s; break;
      case 0x1: res = d ^ s; break;
      case 0x2: { const a = s & 0xFF; if (a === 0) res = d; else if (a < 32) { this.C = (d >>> (32 - a)) & 1; res = d << a; } else { this.C = a === 32 ? d & 1 : 0; res = 0; } break; }
      case 0x3: { const a = s & 0xFF; if (a === 0) res = d; else if (a < 32) { this.C = (d >>> (a - 1)) & 1; res = (d >>> a) | 0; } else { this.C = a === 32 ? d >>> 31 : 0; res = 0; } break; }
      case 0x4: { const a = s & 0xFF; if (a === 0) res = d; else if (a < 32) { this.C = (d >>> (a - 1)) & 1; res = d >> a; } else { this.C = d >>> 31; res = d >> 31; } break; }
      case 0x5: r[rd] = this.add(d, s, this.C, true); return;
      case 0x6: r[rd] = this.add(d, ~s, this.C, true); return;
      case 0x7: { const a = s & 0xFF; if (a === 0) res = d; else { const b = a & 31; if (b === 0) { this.C = d >>> 31; res = d; } else { this.C = (d >>> (b - 1)) & 1; res = (d >>> b) | (d << (32 - b)); } } break; }
      case 0x8: res = d & s; this.N = res >>> 31; this.Z = res === 0 ? 1 : 0; return;
      case 0x9: r[rd] = this.add(0, ~s, 1, true); return;
      case 0xA: this.add(d, ~s, 1, true); return;
      case 0xB: this.add(d, s, 0, true); return;
      case 0xC: res = d | s; break;
      case 0xD: res = Math.imul(d, s); break;
      case 0xE: res = d & ~s; break;
      default: res = ~s; break;
    }
    r[rd] = res; this.N = res >>> 31; this.Z = res === 0 ? 1 : 0;
  }
}

if (typeof module !== 'undefined') module.exports = { ARM7 };

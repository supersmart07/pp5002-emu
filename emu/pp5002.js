// PortalPlayer PP5002 system model (1st-generation iPod): memory map, two ARM7 cores, peripherals.
// Unknown I/O is logged and backed by a plain register file so read-modify-write sequences behave.
'use strict';

const SDRAM_BASE = 0x28000000, SDRAM_SIZE = 32 * 1024 * 1024, SDRAM_MASK = SDRAM_SIZE - 1;
const IRAM_BASE = 0x40000000, IRAM_SIZE = 0x18000;
// IDE data register: hit hard by PIO sector transfers (a 15 MB buffer refill is ~8 million accesses), so the
// memory accessors send it straight to the IDE device instead of the generic I/O dispatch
const IDE_DATA = 0xC00031E0 | 0;
const CPU_HZ = 72000000;             // instructions per emulated second (approximate)

class PP5002 {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.sdram = new ArrayBuffer(SDRAM_SIZE);
    this.sd8 = new Uint8Array(this.sdram); this.sd16 = new Uint16Array(this.sdram); this.sd32 = new Int32Array(this.sdram);
    this.iram = new ArrayBuffer(IRAM_SIZE);
    this.ir8 = new Uint8Array(this.iram); this.ir16 = new Uint16Array(this.iram); this.ir32 = new Int32Array(this.iram);
    // 1 MB page table: logical page -> 1 SDRAM, 2 IRAM, 0 I/O, with byte offset into that RAM
    this.pageKind = new Uint8Array(4096);
    this.pageOff = new Int32Array(4096);
    this.mmap = new Uint32Array(16);   // MMAP0..7 logical/physical pairs
    this.regs = new Map(); // generic register file for unimplemented I/O
    this.seen = new Set();
    this.devices = [];     // {base, size, read(addr, width), write(addr, v, width)}
    this.ioCache = new Map();
    this.usec = 0;         // microsecond counter
    this.cycleAcc = 0;
    this.cur = null;       // core currently executing
    this.curPid = 0x55;    // processor ID of the core currently executing (for PROC_ID and mailbox)
    this.cpu = new ARM7(this, 'cpu'); this.cpu.pid = 0x55;
    this.cop = new ARM7(this, 'cop'); this.cop.pid = 0xAA;
    this.trace = opts.trace || false;
    // translated-code map per word of RAM; a write to a marked word discards all translations
    this.sdCode = new Uint8Array(SDRAM_SIZE >> 2); this.irCode = new Uint8Array(IRAM_SIZE >> 2);
    this.jit = null;
    this.rebuildPages();
    if (typeof ArmJit !== 'undefined' && (opts.jit !== undefined ? opts.jit : ArmJit.enabledByDefault())) this.jit = this.cpu.jit = this.cop.jit = new ArmJit(this);
  }
  codeWrite(o) { this.lastCodeWrite = o; this.jit.flush(); }   // o: address written (for debugging)

  // Each MMAPn pair: logical = base | (mask bits 8..13 -> address bits 24..29); physical = base | permissions.
  translate(a) {
    for (let i = 0; i < 8; i++) {
      const L = this.mmap[i * 2], P = this.mmap[i * 2 + 1];
      if (!(L & 0x3F00)) continue;
      const M = (((L & 0x3F00) << 16) | 0xC0000000) >>> 0;
      if (((a & M) >>> 0) === ((L & M) >>> 0)) return (((P & M) | (a & ~M)) >>> 0);
    }
    return a;
  }
  rebuildPages() {
    for (let p = 0; p < 4096; p++) {
      const phys = this.translate((p << 20) >>> 0);
      if (phys >= 0x28000000 && phys < 0x30000000) { this.pageKind[p] = 1; this.pageOff[p] = (phys - 0x28000000) % SDRAM_SIZE; }
      else if (phys >= IRAM_BASE && phys < IRAM_BASE + 0x100000) { this.pageKind[p] = 2; this.pageOff[p] = 0; }
      else { this.pageKind[p] = 0; this.pageOff[p] = phys; }
    }
    if (this.jit) this.jit.flush();   // translations are keyed by logical address
  }
  setMmap(i, v) { this.mmap[i] = v; this.rebuildPages(); }

  // ---------- save / restore ----------
  // SDRAM is stored sparsely: the indices of non-zero 4 KB pages and their bytes, back to back
  save() {
    const PAGE = 4096, n = SDRAM_SIZE / PAGE, idx = [], w = this.sd32, per = PAGE / 4;
    for (let p = 0; p < n; p++) { for (let i = p * per, e = i + per; i < e; i++) if (w[i] !== 0) { idx.push(p); break; } }
    const data = new Uint8Array(idx.length * PAGE);
    idx.forEach((p, k) => data.set(this.sd8.subarray(p * PAGE, (p + 1) * PAGE), k * PAGE));
    const devices = {};
    for (const d of this.devices) if (d.save) devices[d.name] = d.save();
    return { usec: this.usec, cycleAcc: this.cycleAcc, mmap: this.mmap.slice(), regs: [...this.regs],
      iram: this.ir8.slice(), sdram: { page: PAGE, idx: Uint32Array.from(idx), data }, cpu: this.cpu.save(), cop: this.cop.save(), devices };
  }
  load(o) {
    this.usec = o.usec; this.cycleAcc = o.cycleAcc;
    this.mmap.set(o.mmap); this.rebuildPages();
    this.regs = new Map(o.regs);
    this.ir8.set(o.iram);
    this.sd8.fill(0);
    const P = o.sdram.page;
    o.sdram.idx.forEach((p, k) => this.sd8.set(o.sdram.data.subarray(k * P, (k + 1) * P), p * P));
    this.cpu.load(o.cpu); this.cop.load(o.cop);
    for (const d of this.devices) if (d.load && o.devices[d.name]) d.load(o.devices[d.name]);
    if (this.intc) { this.intc.refresh(null); this.updateIrq(); }
    if (this.jit) this.jit.flush();
  }

  attach(dev) { this.devices.push(dev); dev.sys = this; this.ioCache.clear(); this.tickers = null; return dev; }

  // ---- memory accessors used by the cores (address only; I/O sees the current core's ID) ----
  ioAddr(p, a) { return ((this.pageOff[p] & 0xFFF00000) | (a & 0xFFFFF)) >>> 0; }
  read32(a) {
    const p = a >>> 20, k = this.pageKind[p];
    if (k === 1) return this.sd32[((this.pageOff[p] + (a & 0xFFFFF)) & SDRAM_MASK) >>> 2];
    if (k === 2) { const o = a & 0x1FFFF; return o < IRAM_SIZE ? this.ir32[o >>> 2] : 0; }
    if (a === IDE_DATA && this.ide) return this.ide.fastRead(4) | 0;
    return this.io(this.ioAddr(p, a), 0, 4, false, this.curPid) | 0;
  }
  read16(a) {
    const p = a >>> 20, k = this.pageKind[p];
    if (k === 1) return this.sd16[((this.pageOff[p] + (a & 0xFFFFF)) & SDRAM_MASK) >>> 1];
    if (k === 2) { const o = a & 0x1FFFF; return o < IRAM_SIZE ? this.ir16[o >>> 1] : 0; }
    if (a === IDE_DATA && this.ide) return this.ide.fastRead(2);
    return this.io(this.ioAddr(p, a), 0, 2, false, this.curPid) & 0xFFFF;
  }
  read8(a) {
    const p = a >>> 20, k = this.pageKind[p];
    if (k === 1) return this.sd8[(this.pageOff[p] + (a & 0xFFFFF)) & SDRAM_MASK];
    if (k === 2) { const o = a & 0x1FFFF; return o < IRAM_SIZE ? this.ir8[o] : 0; }
    return this.io(this.ioAddr(p, a), 0, 1, false, this.curPid) & 0xFF;
  }
  write32(a, v) {
    const p = a >>> 20, k = this.pageKind[p];
    if (k === 1) { const o = (this.pageOff[p] + (a & 0xFFFFF)) & SDRAM_MASK; this.sd32[o >>> 2] = v; if (this.sdCode[o >>> 2] !== 0) this.codeWrite(o); return; }
    if (k === 2) { const o = a & 0x1FFFF; if (o < IRAM_SIZE) { this.ir32[o >>> 2] = v; if (this.irCode[o >>> 2] !== 0) this.codeWrite(IRAM_BASE + o); } return; }
    if (a === IDE_DATA && this.ide) { this.ide.fastWrite(v, 4); return; }
    this.io(this.ioAddr(p, a), v >>> 0, 4, true, this.curPid);
  }
  write16(a, v) {
    const p = a >>> 20, k = this.pageKind[p];
    if (k === 1) { const o = (this.pageOff[p] + (a & 0xFFFFF)) & SDRAM_MASK; this.sd16[o >>> 1] = v; if (this.sdCode[o >>> 2] !== 0) this.codeWrite(o); return; }
    if (k === 2) { const o = a & 0x1FFFF; if (o < IRAM_SIZE) { this.ir16[o >>> 1] = v; if (this.irCode[o >>> 2] !== 0) this.codeWrite(IRAM_BASE + o); } return; }
    if (a === IDE_DATA && this.ide) { this.ide.fastWrite(v & 0xFFFF, 2); return; }
    this.io(this.ioAddr(p, a), v & 0xFFFF, 2, true, this.curPid);
  }
  write8(a, v) {
    const p = a >>> 20, k = this.pageKind[p];
    if (k === 1) { const o = (this.pageOff[p] + (a & 0xFFFFF)) & SDRAM_MASK; this.sd8[o] = v; if (this.sdCode[o >>> 2] !== 0) this.codeWrite(o); return; }
    if (k === 2) { const o = a & 0x1FFFF; if (o < IRAM_SIZE) { this.ir8[o] = v; if (this.irCode[o >>> 2] !== 0) this.codeWrite(IRAM_BASE + o); } return; }
    this.io(this.ioAddr(p, a), v & 0xFF, 1, true, this.curPid);
  }
  // generic accessors kept for tools
  read(a, w) { return w === 4 ? this.read32(a) : w === 2 ? this.read16(a) : this.read8(a); }
  write(a, v, w) { if (w === 4) this.write32(a, v); else if (w === 2) this.write16(a, v); else this.write8(a, v); }

  // device owning an I/O address, cached per 256-byte block (no two devices share a block)
  deviceAt(a) {
    const key = a >>> 8;
    let d = this.ioCache.get(key);
    if (d === undefined) {
      d = null;
      for (const x of this.devices) if (a >= x.base && a < x.base + x.size) { d = x; break; }
      this.ioCache.set(key, d);
    }
    return d;
  }

  io(a, v, w, isWrite, pid) {
    const d = this.deviceAt(a);
    if (d !== null && a >= d.base && a < d.base + d.size) {
      // Device accesses can raise or clear interrupts (FIFO refills, acknowledges), so the cores'
      // IRQ/FIQ lines are recomputed at once; a stale line would re-enter a handler that already ran.
      let r = 0;
      if (isWrite) d.write(a, v, w, pid); else r = d.read(a, w, pid) | 0;
      if (d.irqSource) { this.intc.refresh(d); this.updateIrq(); }
      else if (d === this.intc) this.updateIrq();
      return r;
    }
    const base = a & ~3, sh = (a & 3) * 8;
    if (isWrite) {
      this.note(a, w, true, v);
      if (w === 4) this.regs.set(base, v);
      else {
        const mask = (w === 2 ? 0xFFFF : 0xFF) << sh;
        const old = this.regs.get(base) || 0;
        this.regs.set(base, ((old & ~mask) | ((v << sh) & mask)) >>> 0);
      }
      return 0;
    }
    this.note(a, w, false, 0);
    const r = (this.regs.get(base) || 0) >>> sh;
    return w === 4 ? r | 0 : w === 2 ? r & 0xFFFF : r & 0xFF;
  }

  // logs the first read and first write of each unemulated register (and everything while tracing);
  // the key is numeric because some registers are hit ~100,000 times a second
  note(a, w, isWrite, v) {
    const key = isWrite ? -1 - a : a;
    const tr = this.traceRange;
    if (this.trace || !this.seen.has(key) || (tr && a >= tr[0] && a <= tr[1])) {
      this.seen.add(key);
      const c = this.cur;
      this.log(`[io] ${c ? c.name : '?'} pc=${c ? hex(c.pc - (c.T ? 2 : 4)) : '?'} ${isWrite ? 'W' : 'R'}${w * 8} ${hex(a)}${isWrite ? ' = ' + hex(v) : ''}`);
    }
  }

  // advance emulated time by n instructions
  tick(n) {
    this.cycleAcc += n;
    const us = Math.floor(this.cycleAcc * 1e6 / CPU_HZ);
    if (us > 0) {
      this.cycleAcc -= us * CPU_HZ / 1e6;
      this.usec = (this.usec + us) >>> 0;
      const t = this.tickers || (this.tickers = this.devices.filter(d => d.tick));
      for (let i = 0; i < t.length; i++) t[i].tick(us);
    }
  }

  step(slice) {
    // cores parked by a delay hint resume once their wake-up time has passed
    const cpu = this.cpu, cop = this.cop;
    if (cpu.halted && cpu.wakeAt !== undefined && ((this.usec - cpu.wakeAt) | 0) >= 0) { cpu.halted = false; cpu.wakeAt = undefined; }
    if (cop.halted && cop.wakeAt !== undefined && ((this.usec - cop.wakeAt) | 0) >= 0) { cop.halted = false; cop.wakeAt = undefined; }
    if (!this.cpu.halted) { this.cur = this.cpu; this.curPid = 0x55; this.cpu.run(slice); }
    if (!this.cop.halted) { this.cur = this.cop; this.curPid = 0xAA; this.cop.run(slice); }
    this.tick(slice);
    if (this.intc) this.intc.refresh(null);
    this.updateIrq();
  }

  updateIrq() {
    const ic = this.intc; if (!ic) return;
    const raw = ic.bits;
    const p0 = raw & ic.en[0], p1 = raw & ic.en[1];
    this.cpu.fiq = (p0 & ic.fiqSel[0]) !== 0; this.cpu.irq = (p0 & ~ic.fiqSel[0]) !== 0;
    this.cop.fiq = (p1 & ic.fiqSel[1]) !== 0; this.cop.irq = (p1 & ~ic.fiqSel[1]) !== 0;
    // a sleeping core wakes when one of its enabled interrupts is pending
    if (this.cpu.halted && p0) { this.cpu.halted = false; this.cpu.wakeAt = undefined; }
    if (this.cop.halted && p1) { this.cop.halted = false; this.cop.wakeAt = undefined; }
  }
}

function hex(v, n) { return '0x' + ((v >>> 0).toString(16)).padStart(n || 8, '0'); }

if (typeof module !== 'undefined') module.exports = { PP5002, hex, SDRAM_BASE, IRAM_BASE };

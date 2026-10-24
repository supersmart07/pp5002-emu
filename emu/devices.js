// PP5002 peripherals. Register addresses follow the Rockbox/ipodlinux PP5002 notes, refined by watching firmware 1.2.
'use strict';

// Processor ID: 0x55 for the main CPU, 0xAA for the coprocessor.
function procIdDevice() {
  return { name: 'procid', base: 0xC4000000, size: 0x10, read: (a, w, pid) => (pid * 0x01010101) >>> 0, write() {} };
}

// Memory mapping controller. Firmware maps logical 0 onto SDRAM before jumping to low addresses.
function mmapDevice() {
  const regs = new Uint32Array(0x40);
  return {
    name: 'mmap', base: 0xF000F000, size: 0x100,
    save() { return { regs: regs.slice() }; },
    load(o) { regs.set(o.regs); },
    read(a) { return regs[(a & 0xFF) >>> 2]; },
    write(a, v) {
      const i = (a & 0xFF) >>> 2;
      regs[i] = v;
      if (i >= 4 && i < 20) this.sys.setMmap(i - 4, v);
      this.sys.log(`[mmap] ${hex(a)} = ${hex(v)}`);
    }
  };
}

// System controller: CPU_CTL / COP_CTL sleep and wake, clock and device enables, chip revision.
// The revision string is read two characters per register from 0xCF00403C down to 0xCF004030.
function sysCtlDevice(revision) {
  const regs = new Map();
  const rev = (revision || 'PP5002C').padEnd(8, '\0');
  const pair = i => (rev.charCodeAt(i) << 8) | rev.charCodeAt(i + 1);
  return {
    name: 'sysctl', base: 0xCF004000, size: 0x1000,
    save() { return { regs: [...regs] }; },
    load(o) { regs.clear(); for (const [k, v] of o.regs) regs.set(k, v); },
    read(a) {
      if (a >= 0xCF004030 && a <= 0xCF00403C) return pair((0x3C - (a & 0xFF)) / 2);
      if (a === 0xCF004054 || a === 0xCF004058) {
        const core = a === 0xCF004054 ? this.sys.cpu : this.sys.cop;
        return core.halted ? 0xCA : 0xCE;
      }
      // Status read by the firmware's doze routine (idle power saving): bit 14 = COP asleep. Without it the CPU
      // waits forever after putting the COP to sleep and the iPod never wakes up.
      if (a === 0xCF004050) return ((regs.get(a) || 0) & ~0x4000) | (this.sys.cop.halted ? 0x4000 : 0);
      // PLL control: the doze routine switches clocks and waits for bit 12 (locked) to follow bit 13 (PLL on)
      if (a === 0xCF004010) { const v = regs.get(a) || 0; return (v & ~0x1000) | ((v & 0x2000) ? 0x1000 : 0); }
      this.sys.note(a, 4, false, 0);
      return regs.get(a) || 0;
    },
    write(a, v) {
      if (a === 0xCF004054 || a === 0xCF004058) {
        const core = a === 0xCF004054 ? this.sys.cpu : this.sys.cop;
        const sleep = (v & 0xFF) === 0xCA || ((v & 0x80) && !(v & 0x04));
        this.sys.log(`[ctl] ${core.name} ${sleep ? 'sleep' : 'wake'} (${hex(v)}) by ${this.sys.cur && this.sys.cur.name} pc=${this.sys.cur && hex(this.sys.cur.pc)}`);
        core.halted = sleep;
        return;
      }
      this.sys.note(a, 4, true, v);
      regs.set(a, v);
    }
  };
}

// Timers: TIMER1/TIMER2 (count down in microseconds, raise IRQ) and the free-running USEC counter.
function timerDevice() {
  const t = [{ cfg: 0, val: 0, cnt: 0, irq: false }, { cfg: 0, val: 0, cnt: 0, irq: false }];
  return {
    name: 'timer', base: 0xCF001100, size: 0x20, t,
    save() { return { t: t.map(x => ({ ...x })) }; },
    load(o) { o.t.forEach((x, i) => Object.assign(t[i], x)); },
    read(a) {
      const o = a & 0x1F;
      if (o === 0x10) return this.sys.usec;
      const tm = t[o >> 3];
      if (o & 4) { const v = tm.cnt; tm.irq = false; return v; }
      return tm.cfg;
    },
    write(a, v) {
      const o = a & 0x1F;
      if (o === 0x10) { this.sys.usec = v; return; }
      const tm = t[o >> 3];
      if (o & 4) { tm.irq = false; return; }
      tm.cfg = v; tm.cnt = v & 0xFFFF; // low bits: reload value in microseconds
      this.sys.log(`[timer${(o >> 3) + 1}] cfg=${hex(v)}`);
    },
    tick(us) {
      for (const tm of t) {
        if (!(tm.cfg & 0x80000000)) continue;
        let c = tm.cnt - us;
        while (c <= 0) {
          tm.irq = true;
          if (tm.cfg & 0x40000000) c += (tm.cfg & 0xFFFF) + 1; else { tm.cfg &= ~0x80000000; c = 0; break; }
        }
        tm.cnt = c;
      }
    }
  };
}

if (typeof module !== 'undefined') module.exports = { procIdDevice, mmapDevice, sysCtlDevice, timerDevice };

// Cache controller and tag RAM (0xF0000000-0xF000EFFF). The emulator has no cache, so flushes are no-ops.
function cacheDevice() {
  const regs = new Map();
  return {
    name: 'cache', base: 0xF0000000, size: 0xF000,
    save() { return { regs: [...regs] }; },
    load(o) { regs.clear(); for (const [k, v] of o.regs) regs.set(k, v); },
    read(a) { return a >= 0xF000E000 ? (regs.get(a) || 0) : 0; },
    write(a, v) { if (a >= 0xF000E000) regs.set(a, v); }
  };
}
if (typeof module !== 'undefined') module.exports.cacheDevice = cacheDevice;

// Interrupt controller at 0xCF001000.
//   +0x00 raw status   +0x20/24/28/2C CPU enabled / enable / disable / FIQ select
//   +0x10 raw status   +0x30/34/38/3C COP enabled / enable / disable / FIQ select
// Sources: bit 1 IDE, bit 11 TIMER1, bit 12 TIMER2, bit 14 GPIO (others discovered as needed).
function intcDevice() {
  const en = [0, 0], fiqSel = [0, 0];
  const sources = [];   // {dev, fn, val}: fn() returns the interrupt bits that device currently asserts
  const dev = {
    name: 'intc', base: 0xCF001000, size: 0x100, en, fiqSel, bits: 0,
    addSource(source, fn) { source.irqSource = true; sources.push({ dev: source, fn, val: 0 }); },
    save() { return { en: en.slice(), fiqSel: fiqSel.slice() }; },
    load(o) { en[0] = o.en[0]; en[1] = o.en[1]; fiqSel[0] = o.fiqSel[0]; fiqSel[1] = o.fiqSel[1]; },
    // re-evaluate one device's lines (after it was accessed), or every device (after time passed)
    refresh(source) {
      let bits = 0;
      for (const s of sources) { if (!source || s.dev === source) s.val = s.fn(); bits |= s.val; }
      this.bits = bits >>> 0;
    },
    raw() { return this.bits; },
    pending(core) { return (this.bits & en[core]) >>> 0; },
    read(a) {
      const o = a & 0xFF;
      switch (o) {
        case 0x00: case 0x10: return this.bits;
        case 0x20: return en[0];
        case 0x2C: return fiqSel[0];
        case 0x30: return en[1];
        case 0x3C: return fiqSel[1];
      }
      this.sys.note(a, 4, false, 0);
      return 0;
    },
    write(a, v) {
      const o = a & 0xFF;
      switch (o) {
        case 0x24: en[0] = (en[0] | v) >>> 0; return;
        case 0x28: en[0] = (en[0] & ~v) >>> 0; return;
        case 0x2C: fiqSel[0] = v >>> 0; return;
        case 0x34: en[1] = (en[1] | v) >>> 0; return;
        case 0x38: en[1] = (en[1] & ~v) >>> 0; return;
        case 0x3C: fiqSel[1] = v >>> 0; return;
      }
      this.sys.note(a, 4, true, v);
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.intcDevice = intcDevice;

// IDE controller with one ATA disk (PIO). Task file at 0xC00031E0 + 4*reg, control at 0xC00033F8.
function ideDevice(image) {
  const BSY = 0x80, DRDY = 0x40, DSC = 0x10, DRQ = 0x08, ERR = 0x01;
  const sectors = Math.floor(image.length / 512);
  const cfg = new Map();
  const s = { status: DRDY | DSC, error: 1, feat: 0, nsect: 1, sector: 1, lcyl: 0, hcyl: 0, select: 0xA0, devctl: 0,
    buf: new Uint8Array(512 * 16), bufLen: 0, pos: 0, cmd: 0, lba: 0, left: 0, multiple: 1, irq: false };

  function identify() {
    const w = new Uint16Array(256);
    const str = (from, len, text) => { const t = text.padEnd(len * 2, ' '); for (let i = 0; i < len; i++) w[from + i] = (t.charCodeAt(i * 2) << 8) | t.charCodeAt(i * 2 + 1); };
    const cyl = Math.min(16383, Math.floor(sectors / (16 * 63)));
    w[0] = 0x0040; w[1] = cyl; w[3] = 16; w[6] = 63;
    str(10, 10, 'EMU0000000000001'); str(23, 4, 'FW1.2'); str(27, 20, 'TOSHIBA MK5002MAL');
    w[47] = 0x8010; w[49] = 0x0200; w[51] = 0x0200; w[53] = 0x0007;
    w[54] = cyl; w[55] = 16; w[56] = 63; const chs = cyl * 16 * 63; w[57] = chs & 0xFFFF; w[58] = chs >>> 16;
    w[59] = 0x0100 | s.multiple; w[60] = sectors & 0xFFFF; w[61] = sectors >>> 16;
    w[80] = 0x001E; w[82] = 0x4208; w[83] = 0x4000; w[84] = 0x4000; w[85] = 0x4208; w[86] = 0x0000; w[87] = 0x4000;
    s.buf.set(new Uint8Array(w.buffer), 0); s.bufLen = 512; s.pos = 0;
  }
  function lba() { return ((s.select & 0x0F) << 24) | (s.hcyl << 16) | (s.lcyl << 8) | s.sector; }
  function setLba(v) { s.sector = v & 0xFF; s.lcyl = (v >>> 8) & 0xFF; s.hcyl = (v >>> 16) & 0xFF; s.select = (s.select & 0xF0) | ((v >>> 24) & 0x0F); }
  function done(err) { s.status = DRDY | DSC | (err ? ERR : 0); s.error = err ? 0x04 : 0; raise(); }
  function raise() { if (!(s.devctl & 2)) s.irq = true; }
  function loadRead() {
    const n = Math.min(s.left, s.cmd === 0xC4 ? s.multiple : 1);
    if (s.lba + n > sectors) { done(true); return; }
    s.buf.set(image.subarray(s.lba * 512, (s.lba + n) * 512), 0);
    dev.sectorsRead += n;
    s.bufLen = n * 512; s.pos = 0; s.chunk = n;
    s.status = DRDY | DSC | DRQ; raise();
  }
  function startWrite() {
    const n = Math.min(s.left, s.cmd === 0xC5 ? s.multiple : 1);
    s.bufLen = n * 512; s.pos = 0; s.chunk = n; s.status = DRDY | DSC | DRQ;
  }
  function command(c) {
    s.cmd = c; s.error = 0;
    if (s.select & 0x10) { s.status = 0; s.error = 0x04; return; } // no slave device
    const count = s.nsect || 256;
    switch (c) {
      case 0x20: case 0x21: case 0xC4:
        s.lba = lba(); s.left = count; loadRead(); break;
      case 0x30: case 0x31: case 0xC5:
        s.lba = lba(); s.left = count; startWrite(); break;
      case 0xEC: identify(); s.status = DRDY | DSC | DRQ; raise(); break;
      case 0xC6: s.multiple = Math.min(16, s.nsect || 1); done(false); break;
      case 0x90: s.error = 0x01; s.nsect = 1; s.sector = 1; s.lcyl = 0; s.hcyl = 0; s.status = DRDY | DSC; raise(); break;
      case 0x40: case 0x41: setLba(lba() + count - 1); done(false); break;
      case 0xE5: s.nsect = 0xFF; done(false); break;  // check power mode: active
      default: done(false); break;                     // idle, standby, sleep, set features, flush, recalibrate...
    }
    if (dev.sys.ideLog) dev.sys.log(`[ata] cmd ${hex(c, 2)} lba=${lba()} count=${count}`);
  }
  function dataRead() {
    if (!(s.status & DRQ)) return 0;
    const v = s.buf[s.pos] | (s.buf[s.pos + 1] << 8);
    s.pos += 2;
    if (s.pos >= s.bufLen) {
      if (s.cmd === 0xEC) { s.status = DRDY | DSC; }
      else { s.lba += s.chunk; s.left -= s.chunk; if (s.left > 0) loadRead(); else s.status = DRDY | DSC; }
    }
    return v;
  }
  function dataWrite(v) {
    if (!(s.status & DRQ)) return;
    s.buf[s.pos] = v & 0xFF; s.buf[s.pos + 1] = (v >>> 8) & 0xFF; s.pos += 2;
    if (s.pos >= s.bufLen) {
      if (s.lba + s.chunk <= sectors) {
        image.set(s.buf.subarray(0, s.bufLen), s.lba * 512);
        for (let k = 0; k < s.chunk; k++) dev.written.add(s.lba + k);
      }
      dev.dirty = true;
      s.lba += s.chunk; s.left -= s.chunk;
      if (s.left > 0) { startWrite(); raise(); } else done(false);
    }
  }
  const dev = {
    name: 'ide', base: 0xC0003000, size: 0x1000, state: s, image, dirty: false,
    written: new Set(),   // sectors the firmware has written since the disk was built
    sectorsRead: 0,
    save() { return { s: { ...s, buf: s.buf.slice() }, cfg: [...cfg] }; },
    load(o) { Object.assign(s, o.s, { buf: new Uint8Array(o.s.buf) }); cfg.clear(); for (const [k, v] of o.cfg) cfg.set(k, v); },
    irqLine() { return s.irq; },
    // data register fast path: only a change of the interrupt line (at a sector boundary) is reported
    fastRead(w) {
      const before = s.irq;
      const v = w === 4 ? (dataRead() | (dataRead() << 16)) : dataRead();
      if (s.irq !== before) { this.sys.intc.refresh(this); this.sys.updateIrq(); }
      return v;
    },
    fastWrite(v, w) {
      const before = s.irq;
      if (w === 4) { dataWrite(v & 0xFFFF); dataWrite(v >>> 16); } else dataWrite(v);
      if (s.irq !== before) { this.sys.intc.refresh(this); this.sys.updateIrq(); }
    },
    read(a, w) {
      const o = a & 0xFFF;
      switch (o) {
        case 0x1E0: return w === 4 ? (dataRead() | (dataRead() << 16)) >>> 0 : dataRead();
        case 0x1E4: return s.error;
        case 0x1E8: return s.nsect;
        case 0x1EC: return s.sector;
        case 0x1F0: return s.lcyl;
        case 0x1F4: return s.hcyl;
        case 0x1F8: return s.select;
        case 0x1FC: s.irq = false; return (s.select & 0x10) ? 0 : s.status;
        case 0x3F8: return (s.select & 0x10) ? 0 : s.status;
        case 0x024: return ((cfg.get(o) || 0) | 0x40) >>> 0; // bit 6: controller ready for the next register access
      }
      return cfg.get(o) || 0;
    },
    write(a, v, w) {
      const o = a & 0xFFF;
      switch (o) {
        case 0x1E0: if (w === 4) { dataWrite(v & 0xFFFF); dataWrite(v >>> 16); } else dataWrite(v); return;
        case 0x1E4: s.feat = v & 0xFF; return;
        case 0x1E8: s.nsect = v & 0xFF; return;
        case 0x1EC: s.sector = v & 0xFF; return;
        case 0x1F0: s.lcyl = v & 0xFF; return;
        case 0x1F4: s.hcyl = v & 0xFF; return;
        case 0x1F8: s.select = v & 0xFF; return;
        case 0x1FC: command(v & 0xFF); return;
        case 0x3F8:
          if ((v & 4) && !(s.devctl & 4)) { s.status = BSY; }
          if (!(v & 4) && (s.devctl & 4)) { s.status = DRDY | DSC; s.error = 1; s.nsect = 1; s.sector = 1; s.lcyl = 0; s.hcyl = 0; }
          s.devctl = v & 0xFF; return;
      }
      if (!cfg.has(o)) dev.sys.note(a, w, true, v);
      cfg.set(o, v);
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.ideDevice = ideDevice;

// GPIO ports A-D at 0xCF000000. Each register group spans 0x10 bytes with one 32-bit register per port
// (A +0x0, B +0x4, C +0x8, D +0xC; only the low byte is used):
//   0x00 enable, 0x10 output enable, 0x20 output value, 0x30 input value,
//   0x40 interrupt status, 0x50 interrupt enable, 0x60 interrupt level, 0x70 interrupt clear.
// Port A on the 1G: bits 0-4 buttons (active low: right, select, play, left, menu), bit 5 hold (high = on),
// bits 6-7 scroll wheel quadrature. Port D bit 6 follows the I2S word clock (firmware 1.3 syncs to it).
function gpioDevice() {
  // r[group * 4 + port]; register address = base + group * 0x10 + port * 4 (only the low byte is used)
  const r = new Uint8Array(32);
  const EN = 0, OE = 1, OUT = 2, IN = 3, ISTAT = 4, IEN = 5, ILEV = 6, ICLR = 7;
  const ext = new Uint8Array([0xDF, 0xFF, 0xFF, 0xFF]);   // levels driven by the outside world (hold off)
  const dev = {
    name: 'gpio', base: 0xCF000000, size: 0x100, regs: r, ext,
    save() { return { r: r.slice(), ext: ext.slice() }; },
    load(o) { r.set(o.r); ext.set(o.ext); },
    input(p) {
      const oe = r[OE * 4 + p];
      let e = ext[p];
      if (p === 3 && this.lrclk) e = (e & ~0x40) | (this.lrclk() ? 0x40 : 0);   // port D bit 6: I2S word clock
      return ((r[OUT * 4 + p] & oe) | (e & ~oe)) & 0xFF;
    },
    // latch an interrupt for every enabled pin whose level now matches its programmed level
    update() {
      for (let p = 0; p < 4; p++) {
        const hit = ~(this.input(p) ^ r[ILEV * 4 + p]) & 0xFF;
        r[ISTAT * 4 + p] |= hit & r[IEN * 4 + p];
      }
    },
    setExt(p, v) { ext[p] = v & 0xFF; this.update(); },
    irqLine() { this.update(); return (r[16] | r[17] | r[18] | r[19]) !== 0; },
    read(a, w) {
      const o = a & 0xFF;
      if (o >= 0x80) { this.sys.note(a, w, false, 0); return 0; }
      if (o & 3) return 0;
      const g = o >> 4, p = (o >> 2) & 3;
      return g === IN ? this.input(p) : g === ICLR ? 0 : r[g * 4 + p];
    },
    write(a, v, w) {
      const o = a & 0xFF;
      if (o >= 0x80) { this.sys.note(a, w, true, v); return; }
      if (o & 3) return;
      const g = o >> 4, p = (o >> 2) & 3, b = v & 0xFF;
      if (g === ICLR) r[ISTAT * 4 + p] &= ~b;
      else if (g !== IN) {
        if (this.sys.gpioLog && g === OUT && r[g * 4 + p] !== b) this.sys.log(`[gpio] out ${'ABCD'[p]} ${r[g * 4 + p].toString(16)} -> ${b.toString(16)}`);
        r[g * 4 + p] = b;
      }
      this.update();
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.gpioDevice = gpioDevice;

// LCD bridge (0xC0001000) driving a Hitachi HD66753 2-bpp grayscale controller.
//   +0x00 control/status (bit 15 busy), +0x08 index register bytes, +0x10 data bytes (high byte first).
// R11 sets the GRAM address, R12 writes GRAM; each 16-bit GRAM word holds 8 pixels, 2 bits each, MSB = leftmost.
function lcdDevice() {
  const gram = new Uint16Array(0x10000);
  const regs = new Uint16Array(0x100);
  let index = 0, hiByte = 0, phase = 0, addr = 0, ctl = 0;
  const dev = {
    name: 'lcd', base: 0xC0001000, size: 0x100, gram, regs, frames: 0, dirty: false,
    get backlight() { return (ctl & 2) !== 0; },   // LCD bridge control bit 1 drives the backlight
    save() { return { gram: gram.slice(), regs: regs.slice(), index, hiByte, phase, addr, ctl }; },
    load(o) { gram.set(o.gram); regs.set(o.regs); ({ index, hiByte, phase, addr, ctl } = o); this.dirty = true; },
    width: 160, height: 128, rowWords: 0x20,
    read(a) {
      const o = a & 0xFF;
      if (o === 0x00) return ctl & ~0x8000;   // never busy
      this.sys.note(a, 4, false, 0);
      return 0;
    },
    write(a, v) {
      const o = a & 0xFF, b = v & 0xFF;
      if (o === 0x00) { if (this.sys.gpioLog && ctl !== v) this.sys.log(`[lcd] ctl ${hex(ctl)} -> ${hex(v)}`); ctl = v; return; }
      if (o === 0x08) { index = ((index << 8) | b) & 0xFFFF; phase = 0; return; }
      if (o === 0x10) {
        if (phase === 0) { hiByte = b; phase = 1; return; }
        phase = 0;
        const word = (hiByte << 8) | b;
        const reg = index & 0xFF;
        if (reg === 0x12) {
          gram[addr & 0xFFFF] = word; this.dirty = true;
          // R05 entry mode: bit 2 = vertical address step, bit 4 = increment (else decrement)
          const step = (regs[5] & 0x04) ? this.rowWords : 1;
          addr = (regs[5] & 0x10 ? addr + step : addr - step) & 0xFFFF;
          return;
        }
        regs[reg] = word;
        if (reg === 0x11) addr = word;
        if (this.sys.lcdLog) this.sys.log(`[lcd] R${reg.toString(16).padStart(2, '0')} = ${hex(word, 4)}`);
        return;
      }
      this.sys.note(a, 4, true, v);
    },
    // Render to gray levels 0 (light) .. 3 (dark). Column words run right to left (word 0x14 is the
    // leftmost 8 pixels, word 0 is off-panel); within a word the top two bits are the leftmost pixel.
    pixels() {
      const out = new Uint8Array(this.width * this.height);
      const words = this.width / 8;
      for (let y = 0; y < this.height; y++)
        for (let xw = 1; xw <= words; xw++) {
          const w = gram[y * this.rowWords + xw];
          for (let k = 0; k < 8; k++) out[y * this.width + (words - xw) * 8 + k] = (w >>> (14 - 2 * k)) & 3;
        }
      return out;
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.lcdDevice = lcdDevice;

// Inter-processor mailbox at 0xC8004000.
//   +0x00 status bits (CPU -> COP), +0x04 set bits, +0x08 clear bits.
//   +0x10 COP -> CPU message: raises CPU interrupt 18 until the CPU reads it.  +0x20 CPU -> COP message.
function mailboxDevice() {
  const regs = new Map();
  let status = 0;
  const dev = {
    name: 'mailbox', base: 0xC8004000, size: 0x100, toCpu: false,
    save() { return { regs: [...regs], status, toCpu: this.toCpu }; },
    load(o) { regs.clear(); for (const [k, v] of o.regs) regs.set(k, v); status = o.status; this.toCpu = o.toCpu; },
    irqLine() { return this.toCpu; },
    read(a, w, pid) {
      const o = a & 0xFF;
      if (this.sys.mboxLog) this.sys.log(`[mbox] ${pid === 0x55 ? 'cpu' : 'cop'} R ${hex(a)}`);
      if (o === 0x00) return status;
      if (o === 0x10 && pid === 0x55) this.toCpu = false;
      return regs.get(o) || 0;
    },
    write(a, v, w, pid) {
      const o = a & 0xFF;
      if (this.sys.mboxLog) this.sys.log(`[mbox] ${pid === 0x55 ? 'cpu' : 'cop'} W ${hex(a)} = ${hex(v)}`);
      if (o === 0x04) { status = (status | v) >>> 0; return; }
      if (o === 0x08) { status = (status & ~v) >>> 0; return; }
      regs.set(o, v >>> 0);
      if (o === 0x10) this.toCpu = true;
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.mailboxDevice = mailboxDevice;

// Two 16550-style serial ports at 0xC0006000 and 0xC0006040 (registers on a 4-byte stride).
// Transmit always completes immediately; nothing is ever received. Bytes sent are kept for debugging.
function uartDevice() {
  const regs = new Uint8Array(0x80);
  const dev = {
    name: 'uart', base: 0xC0006000, size: 0x80, sent: [[], []],
    save() { return { regs: regs.slice() }; },
    load(o) { regs.set(o.regs); },
    read(a) {
      const o = a & 0x7F, port = o >> 6, r = (o & 0x3F) >> 2;
      if (r === 5) return 0x60;          // LSR: transmitter holding register and shift register empty
      if (r === 0 && !(regs[(port << 6) | 0x0C] & 0x80)) return 0; // RBR: no data
      if (r === 2) return 0x01;          // IIR: no interrupt pending
      return regs[o & ~3];
    },
    write(a, v) {
      const o = a & 0x7F, port = o >> 6, r = (o & 0x3F) >> 2;
      if (r === 0 && !(regs[(port << 6) | 0x0C] & 0x80)) { const s = this.sent[port]; s.push(v & 0xFF); if (s.length > 4096) s.shift(); return; }
      regs[o & ~3] = v & 0xFF;
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.uartDevice = uartDevice;

// I2S audio output at 0xC0002500 feeding the WM8731 codec.
//   +0x00 config (bit 0 enable), +0x1C FIFO config, +0x40 FIFO write (sample in bits 31-16, L/R alternating).
// The FIFO holds 16 samples and drains at 2 x 44100 samples/s; interrupt 5 is asserted while it can take
// another burst of 12. Drained samples land in `out` (Int16 ring) for the host to play.
function i2sDevice() {
  const DEPTH = 16, BURST = 12, RATE = 44100 * 2;
  const fifo = new Int16Array(DEPTH);
  let head = 0, level = 0, acc = 0, cfg = 0;
  const regs = new Map();
  const RING = 1 << 17;
  const dev = {
    name: 'i2s', base: 0xC0002500, size: 0x100,
    out: new Int16Array(RING), outW: 0, outR: 0, underruns: 0, rate: 44100,
    get enabled() { return (cfg & 1) !== 0; },
    save() { return { fifo: fifo.slice(), head, level, acc, cfg, regs: [...regs] }; },
    load(o) { fifo.set(o.fifo); ({ head, level, acc, cfg } = o); regs.clear(); for (const [k, v] of o.regs) regs.set(k, v); },
    irqLine() { return (cfg & 1) !== 0 && level <= DEPTH - BURST; },
    read(a) {
      const o = a & 0xFF;
      if (o === 0x00) return cfg;
      if (o === 0x1C) return ((regs.get(0x1C) || 0) & 0xFFFF) | ((DEPTH - level) << 16);
      return regs.get(o & ~3) >>> ((o & 3) * 8) || 0;
    },
    write(a, v, w) {
      const o = a & 0xFF;
      if (o === 0x00) { cfg = v; if (!(cfg & 1)) { level = 0; } return; }
      if (o === 0x40) {
        if (level < DEPTH) { fifo[(head + level) % DEPTH] = v >> 16; level++; }
        return;
      }
      const base = o & ~3, sh = (o & 3) * 8, mask = (w === 4 ? 0xFFFFFFFF : w === 2 ? 0xFFFF : 0xFF) << sh;
      regs.set(base, (((regs.get(base) || 0) & ~mask) | ((v << sh) & mask)) >>> 0);
    },
    tick(us) {
      if (!(cfg & 1)) return;
      acc += us * RATE / 1e6;
      while (acc >= 1) {
        acc -= 1;
        let s = 0;
        if (level) { s = fifo[head]; head = (head + 1) % DEPTH; level--; } else this.underruns++;
        this.out[this.outW & (RING - 1)] = s; this.outW++;
        if (this.capture) this.capture.push(s);
      }
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.i2sDevice = i2sDevice;

// I2C controller at 0xC0008000; snoops writes to the WM8731 codec (bus address 0x34) to track volume.
//   +0x00 control (written 0x92 to start a transfer), +0x04 device address, +0x0C/+0x10 data bytes.
function i2cDevice() {
  const regs = new Map();
  const codec = new Uint16Array(16);
  codec[2] = codec[3] = 0x79;            // headphone volume reset value: 0 dB
  const dev = {
    name: 'i2c', base: 0xC0008000, size: 0x100, codec,
    save() { return { regs: [...regs], codec: codec.slice() }; },
    load(o) { regs.clear(); for (const [k, v] of o.regs) regs.set(k, v); codec.set(o.codec); },
    // headphone gain as a linear factor (WM8731: 0x79 = 0 dB, 1 dB steps, <= 0x2F mute)
    get gain() { const v = codec[2] & 0x7F; return v <= 0x2F ? 0 : Math.pow(10, (v - 0x79) / 20); },
    read(a) { return regs.get(a & 0xFF) || 0; },
    write(a, v) {
      const o = a & 0xFF;
      regs.set(o, v >>> 0);
      if (o === 0x00 && (v & 0x80) && (regs.get(0x04) & 0xFE) === 0x34) {
        const b0 = regs.get(0x0C) & 0xFF, b1 = regs.get(0x10) & 0xFF;
        const reg = b0 >> 1, val = ((b0 & 1) << 8) | b1;
        if (reg < 16) codec[reg] = val;
        if (reg === 2 && (val & 0x100)) codec[3] = val;   // LRHPBOTH: left setting applies to right too
      }
    }
  };
  return dev;
}
if (typeof module !== 'undefined') module.exports.i2cDevice = i2cDevice;

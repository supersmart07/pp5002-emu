// Loop hints. Each hint finds a loop in the loaded firmware by its instruction pattern (so it works across
// firmware versions) and replaces one instruction with a trap opcode:
//   - idle loops: when the loop's backward branch would loop again, the core sleeps instead of spinning,
//     until its next interrupt or until a microsecond deadline;
//   - the PIO disk read loop: the whole transfer is copied by the host in one go.
'use strict';

const IdleHints = (() => {
  const TRAP = 0xEE000000;   // CDP p0 encoding, unused by the firmware; low bits index the installed hints
  // pattern: [mask, value] per consecutive word; `at` is the index of the conditional branch to patch
  const table = [
    { // audio decoder (COP) waiting for room in the output buffer, which the FIQ handler drains:
      //   cmp rX, r0 / ldrls r1, [sp, #4] / cmpls r0, r1 / blo top
      kind: 'irq', at: 3, note: 'wait for audio buffer space',
      pattern: [[0xFFF0FFFF, 0xE1500000], [0xFFFFFFFF, 0x959D1004], [0xFFFFFFFF, 0x91500001], [0xFF000000, 0x3A000000]] },
    { // udelay(): spin on the microsecond timer until r0 <= now; sleep until that time instead
      //   ldr r1, [r2] / add r1, r1, r3 / cmp r0, r1 / bhi loop
      kind: 'delay', at: 3, note: 'udelay busy-wait',
      pattern: [[0xFFFFFFFF, 0xE5921000], [0xFFFFFFFF, 0xE0811003], [0xFFFFFFFF, 0xE1500001], [0xFFFFFFFF, 0x8AFFFFFB]] },
    { // ATA PIO read into a word-aligned buffer, 32 bytes per pass (a song buffer refill runs it ~500,000 times):
      //   ldrh r3, [r0] / ldrh r4, [r0] / add r3, r3, r4, lsl #16 / ... / stm r1!, {r3-r10} / subs r2, r2, #32 / bne top
      // the trap replaces the first ldrh; r0 = data register, r1 = destination, r2 = bytes (a multiple of 32)
      kind: 'pio', at: 0, length: 27, note: 'PIO sector read loop',
      pattern: [[0xFFFFFFFF, 0xE1D030B0], [0xFFFFFFFF, 0xE1D040B0], [0xFFFFFFFF, 0xE0833804],
        ...Array(21).fill([0, 0]), [0xFFFFFFFF, 0xE8A107F8], [0xFFFFFFFF, 0xE2522020], [0xFF000000, 0x1A000000]] },
  ];
  const IDE_DATA = 0xC00031E0 | 0;

  function install(sys, osos) {
    const words = new Int32Array(osos.buffer, osos.byteOffset, osos.length >> 2);
    const installed = [];
    for (const h of table) {
      const n = h.pattern.length;
      for (let i = 0; i + n <= words.length; i++) {
        let ok = true;
        for (let k = 0; k < n && ok; k++) ok = ((words[i + k] & h.pattern[k][0]) >>> 0) === h.pattern[k][1];
        if (!ok) continue;
        const addr = (i + h.at) * 4, word = words[i + h.at] >>> 0;
        const hint = { kind: h.kind, note: h.note, addr, cond: word >>> 28, target: (addr + 8 + ((word << 8) >> 6)) >>> 0,
          exit: (i + (h.length || 0)) * 4 };
        sys.sd32[addr >>> 2] = (TRAP | installed.length) >>> 0;   // osos is loaded at SDRAM offset 0
        installed.push(hint);
      }
    }
    const handler = (core, op, pc) => {
      if ((op & 0xFFFFFF00) >>> 0 !== TRAP) return false;
      const h = installed[op & 0xFF];
      if (!h) return false;
      if (h.kind === 'pio') {
        const r = core.r;
        if (r[0] !== IDE_DATA || !sys.ide) {             // not the disk: run the replaced ldrh r3, [r0] and go on
          r[3] = sys.read16(r[0]); core.setPC(h.addr + 4); return true;
        }
        let dst = r[1], n = r[2] >>> 0;
        for (; n >= 32; n -= 32) {
          for (let k = 0; k < 8; k++, dst = (dst + 4) | 0) {
            const lo = sys.ide.fastRead(2), hi = sys.ide.fastRead(2);
            sys.write32(dst, lo | (hi << 16));
          }
        }
        r[1] = dst; r[2] = n;                              // the loop ends after subs r2, r2, #32 reaches zero
        core.N = 0; core.Z = n === 0 ? 1 : 0; core.C = 1; core.V = 0;
        core.setPC(n === 0 ? h.exit : h.addr + 4);
        if (n !== 0) r[3] = sys.read16(r[0]);              // odd remainder: fall back to the original loop
        return true;
      }
      if (!core.condPass(h.cond)) return true;            // loop is done: fall through
      core.setPC(h.target);
      if (h.kind === 'irq') { core.halted = true; return true; }
      const remaining = (core.r[0] - core.r[1]) >>> 0;    // microseconds until the delay ends
      if (remaining > 20) { core.halted = true; core.wakeAt = (sys.usec + remaining) | 0; }
      return true;
    };
    sys.cpu.onUndefined = handler; sys.cop.onUndefined = handler;
    return installed;
  }
  return { install, table };
})();

if (typeof module !== 'undefined') module.exports = { IdleHints };

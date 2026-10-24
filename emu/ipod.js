// Assembles a 1st-generation iPod: PP5002 + peripherals + disk, with wheel and button input.
// Shared by the browser front end and the headless jsc runner.
'use strict';

function createIPod({ osos, disk, log }) {
  const sys = new PP5002({ log: log || (() => {}) });
  sys.attach(procIdDevice());
  sys.attach(mmapDevice());
  sys.attach(sysCtlDevice());
  sys.timer = sys.attach(timerDevice());
  sys.attach(cacheDevice());
  sys.intc = sys.attach(intcDevice());
  sys.ide = sys.attach(ideDevice(disk));
  sys.gpio = sys.attach(gpioDevice());
  sys.lcd = sys.attach(lcdDevice());
  sys.mbox = sys.attach(mailboxDevice());
  sys.uart = sys.attach(uartDevice());
  sys.i2s = sys.attach(i2sDevice());
  sys.i2c = sys.attach(i2cDevice());
  sys.gpio.lrclk = () => Math.floor(sys.usec * 0.0882) & 1;   // 44.1 kHz square wave (two edges per frame)
  const ic = sys.intc;
  ic.addSource(sys.timer, () => (sys.timer.t[0].irq ? 1 << 11 : 0) | (sys.timer.t[1].irq ? 1 << 12 : 0));
  ic.addSource(sys.ide, () => (sys.ide.irqLine() ? 1 << 1 : 0));
  ic.addSource(sys.gpio, () => (sys.gpio.irqLine() ? 1 << 14 : 0));
  ic.addSource(sys.mbox, () => (sys.mbox.irqLine() ? 1 << 18 : 0));
  ic.addSource(sys.i2s, () => (sys.i2s.irqLine() ? 1 << 5 : 0));
  sys.sd8.set(osos, 0);
  sys.cpu.reset(0x28000000);
  sys.cop.reset(0x28000000);
  const hints = typeof IdleHints !== 'undefined' ? IdleHints.install(sys, osos) : [];

  // ---- input: port A bits 0-4 buttons (active low), bit 5 hold (high = on), bits 6-7 wheel quadrature ----
  const BTN = { next: 0, select: 1, play: 2, prev: 3, menu: 4 };
  const GRAY_CW = [0, 2, 3, 1];
  let buttons = 0, hold = false, phase = 0;
  const pressedAt = {}, releaseAt = {};   // a press lasts at least MIN_PRESS of emulated time (debounce)
  // Menu + Play held for 5 s resets a 1st-generation iPod; on the hardware that reset does not go through
  // this firmware, so the emulator can watch for it and call onReset (headless hosts; the web page times the
  // combination on its own clock so a slow emulator cannot stretch it)
  const RESET_COMBO = (1 << BTN.menu) | (1 << BTN.play), RESET_HOLD = 5000000;
  let comboSince = null;
  const MIN_PRESS = 60000;
  const wheelQueue = [];          // pending quadrature steps (+1 clockwise, -1 counter-clockwise)
  let nextWheelAt = 0;
  // With hold on, the five buttons read as released (as on the hardware, where buttons do nothing on hold);
  // the firmware itself ignores the wheel and shows the lock icon.
  const apply = () => sys.gpio.setExt(0, (hold ? 0x1F : (0x1F & ~buttons)) | (hold ? 0x20 : 0) | (GRAY_CW[phase] << 6));
  apply();
  const input = {
    press(name, down) {
      const b = 1 << BTN[name];
      if (down) { buttons |= b; pressedAt[name] = sys.usec; delete releaseAt[name]; apply(); return; }
      const held = (sys.usec - (pressedAt[name] || 0)) >>> 0;
      if (held < MIN_PRESS) { releaseAt[name] = pressedAt[name] + MIN_PRESS; return; }
      buttons &= ~b; apply();
    },
    setHold(on) { hold = !!on; apply(); },
    turn(steps) {
      // the clock comparisons below are 32-bit and wrap after ~36 minutes, so an idle wheel restarts from now
      // (a stale nextWheelAt after a long pause or a restored snapshot would otherwise block the wheel)
      const ahead = (nextWheelAt - sys.usec) | 0;
      if (!wheelQueue.length && !(ahead > 0 && ahead <= 4000)) nextWheelAt = sys.usec;
      const d = steps > 0 ? 1 : -1; for (let i = 0; i < Math.abs(steps); i++) wheelQueue.push(d);
    },
    get hold() { return hold; }
  };

  const SLICE = typeof SLICE_OVERRIDE !== "undefined" ? SLICE_OVERRIDE : 256;
  // run until `usec` microseconds of emulated time pass, or until `budgetMs` of wall time is used
  function runFor(usec, budgetMs) {
    const end = sys.usec + usec;
    const t0 = budgetMs ? Date.now() : 0;
    let n = 0;
    while ((sys.usec - end | 0) < 0) {
      if (buttons) for (const name in releaseAt) {
        if ((sys.usec - releaseAt[name] | 0) >= 0) { buttons &= ~(1 << BTN[name]); delete releaseAt[name]; apply(); }
      }
      if (api.onReset && (buttons & RESET_COMBO) === RESET_COMBO && !hold) {
        if (comboSince === null) comboSince = sys.usec;
        else if ((sys.usec - comboSince | 0) >= RESET_HOLD) { comboSince = null; buttons = 0; apply(); if (api.onReset) api.onReset(); return true; }
      } else comboSince = null;
      if (wheelQueue.length && (sys.usec - nextWheelAt | 0) >= 0) {
        phase = (phase + wheelQueue.shift() + 4) & 3; apply();
        nextWheelAt = sys.usec + 4000;   // 4 ms between quadrature edges
      }
      sys.step(SLICE);
      if (budgetMs && (++n & 63) === 0 && Date.now() - t0 > budgetMs) return false;
    }
    return true;
  }

  // Whole-iPod snapshot: system state, wheel phase, and the disk sectors written since the disk was built
  // (the disk itself is rebuilt from the song list, so only the firmware's own writes are kept).
  function saveState() {
    const sectors = Uint32Array.from([...sys.ide.written].sort((a, b) => a - b));
    const data = new Uint8Array(sectors.length * 512);
    sectors.forEach((s, k) => data.set(disk.subarray(s * 512, (s + 1) * 512), k * 512));
    return { format: 1, sys: sys.save(), input: { phase, hold }, disk: { sectors, data } };
  }
  function loadState(o) {
    if (!o || o.format !== 1) throw new Error('unknown snapshot format');
    o.disk.sectors.forEach((s, k) => { disk.set(o.disk.data.subarray(k * 512, (k + 1) * 512), s * 512); sys.ide.written.add(s); });
    sys.load(o.sys);
    phase = o.input.phase; hold = o.input.hold; buttons = 0;
    for (const k in releaseAt) delete releaseAt[k];
    wheelQueue.length = 0;
    apply();
  }

  const api = { sys, input, runFor, lcd: sys.lcd, disk, hints, saveState, loadState, onReset: null };
  return api;
}

if (typeof module !== 'undefined') module.exports = { createIPod };

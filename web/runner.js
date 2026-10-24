// Emulation loop shared by the Web Worker and the main-thread fallback.
// post(message, transfer) sends to the page; handle(message) takes page messages:
//   in : start {osos, disk, hfsOffset, hold, restore?}, input {op, ...}, harvest, snapshot, pause {on}
//   out: ready {restored}, restoreFailed, frame {px, backlight}, audio {pcm, gain}, stats {speed, playing, blocks},
//        harvest {files}, snapshot {state}, error {message}
'use strict';

function createRunner(post, schedule, budgetMs) {
  let ipod = null, hfsOffset = 0, paused = false, last = 0, audioR = 0, audioPort = null;
  let lastFrame = 0, lastBacklight = null, statEmu = 0, lastStat = 0;
  const later = schedule || (fn => setTimeout(fn, 2));

  function loop() {
    if (!ipod) return;
    const now = performance.now();
    const dt = Math.min(now - last, 100);
    last = now;
    if (!paused) {
      const usec0 = ipod.sys.usec;
      ipod.runFor(Math.max(1, Math.round(dt * 1000)), budgetMs || 30);
      statEmu += ((ipod.sys.usec - usec0) >>> 0) / 1000;
    }
    const lcd = ipod.lcd;
    if ((lcd.dirty || lcd.backlight !== lastBacklight) && now - lastFrame > 15) {
      lcd.dirty = false; lastBacklight = lcd.backlight; lastFrame = now;
      const px = lcd.pixels();
      post({ type: 'frame', px, backlight: lcd.backlight }, [px.buffer]);
    }
    // Audio leaves in whole stereo frames: an output slot's position in the I2S stream decides its channel
    // (even = left), so chunks must start on an even index and hold an even number of samples.
    const a = ipod.sys.i2s;
    if (a.outW - audioR > a.out.length) audioR = (a.outW - a.out.length + 1) & ~1;
    const n = (a.outW - audioR) & ~1;
    if (n >= 512) {
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = a.out[(audioR + i) & (a.out.length - 1)];
      audioR += n;
      const msg = { type: 'audio', pcm, gain: ipod.sys.i2c.gain };
      if (audioPort) audioPort.postMessage(msg, [pcm.buffer]); else post(msg, [pcm.buffer]);
    }
    if (now - lastStat > 1000) {
      post({ type: 'stats', speed: Math.min(statEmu / Math.max(now - lastStat, 1), 9.99), playing: ipod.sys.i2s.enabled,
        blocks: ipod.sys.jit ? ipod.sys.jit.fns.length - 1 : null, jitFailed: ipod.sys.jit ? ipod.sys.jit.failed : null });
      statEmu = 0; lastStat = now;
    }
    later(loop);
  }

  // gzip with the browser's CompressionStream when there is one; snapshots stay usable without it
  async function gzip(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function snapshot() {
    const st = ipod.saveState();               // captured synchronously; compression happens afterwards
    // While a big song sits in RAM the pages are mostly audio, which barely compresses (30 MB -> 26 MB) and costs
    // hundreds of milliseconds to try, so large RAM images are kept as they are.
    const parts = st.sys.sdram.data.length > 8e6 ? [st.disk] : [st.sys.sdram, st.disk];
    for (const part of parts) {
      const z = await gzip(part.data);
      if (z) { part.data = z; part.gz = true; }
    }
    return st;
  }
  function unpack(st) {
    for (const part of [st.sys.sdram, st.disk]) if (part.gz) { part.data = Inflate.gunzip(part.data); part.gz = false; }
    return st;
  }

  function handle(m) {
    try {
      if (m.type === 'ping') { post({ type: 'pong' }); return; }
      if (m.type === 'audioPort') { audioPort = m.port; return; }
      if (m.type === 'start') {
        hfsOffset = m.hfsOffset;
        ipod = createIPod({ osos: new Uint8Array(m.osos), disk: new Uint8Array(m.disk) });
        if (m.restore) {
          try { ipod.loadState(unpack(m.restore)); }
          catch (err) { ipod = null; post({ type: 'restoreFailed', message: String(err && err.message || err) }); return; }
        }
        ipod.input.setHold(!!m.hold);
        audioR = ipod.sys.i2s.outW & ~1;
        last = lastStat = performance.now();
        post({ type: 'ready', restored: !!m.restore, playing: ipod.sys.i2s.enabled });
        loop();
      } else if (m.type === 'input' && ipod) {
        if (m.op === 'press') ipod.input.press(m.button, m.down);
        else if (m.op === 'turn') ipod.input.turn(m.steps);
        else if (m.op === 'hold') ipod.input.setHold(m.on);
      } else if (m.type === 'pause') {
        paused = !!m.on;
      } else if (m.type === 'snapshot' && ipod) {
        snapshot().then(state => post({ type: 'snapshot', state }, [state.sys.sdram.data.buffer, state.disk.data.buffer]),
          err => post({ type: 'snapshot', state: null, message: String(err) }));
      } else if (m.type === 'harvest' && ipod) {
        post({ type: 'harvest', files: [...IPodDisk.harvest(ipod.disk, hfsOffset)] });
      } else if (m.type === 'debug' && ipod) {   // core and input state, for ipodDebug.query() in the page
        const s = ipod.sys, core = c => ({ pc: c.pc >>> 0, halted: c.halted, mode: c.mode, T: c.T, I: c.I, F: c.F, irq: c.irq, fiq: c.fiq });
        post({ type: 'debug', usec: s.usec >>> 0, cpu: core(s.cpu), cop: core(s.cop), gpioExtA: s.gpio.ext[0], gpioRegs: Array.from(s.gpio.regs),
          blocks: s.jit ? s.jit.fns.length - 1 : null, flushes: s.jit ? s.jit.flushes : null, lcdFrames: s.lcd.frames, i2s: s.i2s.enabled });
      } else if (m.type === 'stop') {
        ipod = null;
      }
    } catch (err) {
      post({ type: 'error', message: String(err && err.message || err) });
    }
  }
  return { handle };
}

if (typeof module !== 'undefined') module.exports = { createRunner };

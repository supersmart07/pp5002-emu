// Headless scenario runner for jsc:  jsc tools/boot.js -- <scenario>
// Builds a disk with three generated WAV tones, boots firmware 1.2 and replays a scripted input sequence,
// printing FRAME lines for tools/frame.py.
for (const f of ['arm7', 'jit', 'pp5002', 'devices', 'hints', 'hfsplus', 'itunesdb', 'disk', 'ipod']) load(`emu/${f}.js`);
if (typeof OPHIST !== "undefined") load(OPHIST);

function wav(seconds, freq) {
  const rate = 44100, n = rate * seconds, b = new Uint8Array(44 + n * 4), dv = new DataView(b.buffer);
  const w = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { const s = Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000); dv.setInt16(44 + i * 4, s, true); dv.setInt16(46 + i * 4, s, true); }
  return b;
}

// firmware to boot: fw/ (1.2) by default, or another folder named by FW_DIR in a file loaded first
const fwDir = typeof FW_DIR !== 'undefined' ? FW_DIR : 'fw';
const firmware = readFile(fwDir + '/Firmware', 'binary');
const osos = readFile(fwDir + '/images/osos.bin', 'binary');
const mp3 = (() => { try { return readFile(typeof MP3_PATH !== 'undefined' ? MP3_PATH : 'work/test.mp3', 'binary'); } catch (e) { return null; } })();
const songs = [
  { title: 'Concert A', artist: 'Test Tones', album: 'Calibration', kind: 'wav', data: wav(4, 440), ms: 4000, track: 1 },
  { title: 'Middle C', artist: 'Test Tones', album: 'Calibration', kind: 'wav', data: wav(4, 261.6), ms: 4000, track: 2 },
  { title: 'High E', artist: 'Another Artist', album: 'Second Album', kind: 'wav', data: wav(3, 659.3), ms: 3000, track: 1 },
];
if (mp3) songs.unshift({ title: 'A MP3 Fifth', artist: 'Test Tones', album: 'Calibration', kind: 'mp3', data: mp3, ms: typeof MP3_MS !== 'undefined' ? MP3_MS : 10000, bitrate: 192, track: 3 });
const built = IPodDisk.build(firmware, songs, { name: 'iPod' });
print(`disk ${(built.disk.length / 1e6).toFixed(1)} MB, ${built.tracks.length} tracks`);

const logs = [];
const ipod = createIPod({ osos, disk: built.disk, log: s => { if (/\[timer/.test(s)) return; print(s); } });

function frame(label) {
  const px = ipod.lcd.pixels(); let s = '';
  for (let i = 0; i < px.length; i++) s += px[i].toString(16);
  print('FRAME 160 128 ' + s + ' ' + label);
}
if (typeof afterBuild !== 'undefined') afterBuild(built, ipod);
if (typeof breakpoints !== 'undefined') ipod.sys.cpu.breakpoints = new Map(breakpoints.map(([a, f]) => [a, c => f(c, ipod)]));
const ms = n => n * 1000;
const steps = {
  wait: n => ipod.runFor(ms(n)),
  press: name => { ipod.input.press(name, true); ipod.runFor(ms(120)); ipod.input.press(name, false); ipod.runFor(ms(600)); },
  turn: n => { ipod.input.turn(n); ipod.runFor(ms(Math.abs(n) * 5 + 600)); },
  frame: label => { frame(label); print('--- ' + label); },
  hold: ([name, n]) => { ipod.input.press(name, true); ipod.runFor(ms(n)); ipod.input.press(name, false); ipod.runFor(ms(300)); },
  harvest: () => {
    const vol = HFSPlus.open(ipod.disk, built.hfsOffset), recs = HFSPlus.records(vol);
    print('  files: ' + recs.filter(r => r.kind === 'file').map(r => `${r.name}(${r.data.size})`).join(', '));
    const keep = IPodDisk.harvest(ipod.disk, built.hfsOffset);
    print('  harvest: ' + [...keep].map(([k, v]) => k + ' ' + v.length).join(', '));
  },
  capture: on => { const a = ipod.sys.i2s; if (on) { a.capture = []; a.captureOdd = a.outW & 1; } else { const c = a.capture.slice(a.captureOdd); a.capture = null; let h = ''; for (const v of c) { const u = v & 0xFFFF; h += (u < 0x1000 ? (u < 0x100 ? (u < 0x10 ? '000' : '00') : '0') : '') + u.toString(16); } print('PCM ' + h); } },
  timeit: n => { const t0 = Date.now(), u0 = ipod.sys.usec, c0 = ipod.sys.cpu.cycles + ipod.sys.cop.cycles; ipod.runFor(ms(n)); const dt = Date.now() - t0; print(`  timeit: ${n} ms emulated in ${dt} ms wall = ${(n / dt * 100).toFixed(0)}% speed, ${((ipod.sys.cpu.cycles + ipod.sys.cop.cycles - c0) / dt / 1000).toFixed(1)} MIPS executed`); },
  onreset: () => { ipod.onReset = () => print('--- reset requested at ' + (ipod.sys.usec / 1e6).toFixed(2) + ' s'); },
  sethold: on => { ipod.input.setHold(on); },
  combo: ([names, n]) => { for (const b of names) ipod.input.press(b, true); ipod.runFor(ms(n)); for (const b of names) ipod.input.press(b, false); ipod.runFor(ms(300)); },
  gpiolog: on => { ipod.sys.gpioLog = on; },
  print: s => print('--- ' + s + ' at ' + (ipod.sys.usec / 1e6).toFixed(2) + ' s'),
  trace: on => { ipod.sys.trace = on; ipod.sys.mboxLog = on; },
  state: () => { const s = ipod.sys; print(`  intc cpu en=${hex(s.intc.en[0])} fiq=${hex(s.intc.fiqSel[0])} cop en=${hex(s.intc.en[1])} fiq=${hex(s.intc.fiqSel[1])} raw=${hex(s.intc.raw())} t1=${hex(s.timer.t[0].cfg)} t2=${hex(s.timer.t[1].cfg)} cpsr cpu=${hex(s.cpu.getCPSR())} cop=${hex(s.cop.getCPSR())}`); },
  dump: ([addr, len]) => { let s = ''; for (let i = 0; i < len; i++) { const v = ipod.sys.cop.bus.read8(addr + i); s += (v < 16 ? '0' : '') + v.toString(16); } print(`DUMP ${hex(addr)} ${s}`); },
  audio: () => { const a = ipod.sys.i2s; let peak = 0, nz = 0; const n = Math.min(a.outW, a.out.length); for (let i = 0; i < n; i++) { const v = Math.abs(a.out[i]); if (v) nz++; if (v > peak) peak = v; } print(`  audio: ${a.outW} samples out, ${nz} nonzero, peak ${peak}, underruns ${a.underruns}`); },
  scroll: ([secs, step]) => {   // turn the wheel `step` clicks every 100 ms, reporting speed per emulated second
    const a = ipod.sys.i2s;
    for (let s = 0; s < secs; s++) {
      const t0 = Date.now(), u0 = a.underruns, c0 = ipod.sys.cpu.cycles, p0 = ipod.sys.cop.cycles, io0 = ipod.sys.ioCount || 0;
      for (let k = 0; k < 10; k++) { ipod.input.turn(step); ipod.runFor(ms(100)); }
      const dt = Date.now() - t0;
      print(`  scroll ${s + 1}: ${dt} ms wall (${(100000 / Math.max(dt, 1)).toFixed(0)}% speed), cpu ${((ipod.sys.cpu.cycles - c0) / 1e6).toFixed(1)}M cop ${((ipod.sys.cop.cycles - p0) / 1e6).toFixed(1)}M instr, underruns ${a.underruns - u0}`);
    }
  },
  scrollpcs: ([secs, step]) => {   // like scroll, sampling where the CPU core is every ~1 ms
    // samples taken inside the run loop: every 64th executed CPU instruction's address, bucketed by 64-byte block
    const m = new Map(), cpu = ipod.sys.cpu, run0 = cpu.run;
    cpu.run = function (n) { let done = 0; while (done < n && !this.halted) { const k = hex(this.pc & ~63); m.set(k, (m.get(k) || 0) + 1); done += run0.call(this, Math.min(64, n - done)); } return done; };
    for (let s = 0; s < secs * 10; s++) { if (step) ipod.input.turn(step); ipod.runFor(ms(100)); }
    cpu.run = run0;
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 40)) print(`  ${(v / tot * 100).toFixed(1)}% cpu ${k}`);
  },
  iocount: secs => {   // count I/O accesses by address while scrolling, per emulated second
    const sys = ipod.sys, m = new Map(), io0 = sys.io;
    sys.io = function (a, v, w, isW, pid) { const k = (isW ? 'W' : 'R') + w * 8 + ' ' + hex(a); m.set(k, (m.get(k) || 0) + 1); return io0.call(this, a, v, w, isW, pid); };
    for (let s = 0; s < secs * 10; s++) { ipod.input.turn(2); ipod.runFor(ms(100)); }
    sys.io = io0;
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    print(`  io: ${(tot / secs / 1000).toFixed(0)}k accesses per second`);
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 12)) print(`  ${(v / secs / 1000).toFixed(1)}k/s ${k}`);
  },
  jsprof: secs => {   // jsc only: sample the host JS while scrolling; prints the hottest functions (self and inclusive)
    startSamplingProfiler();
    for (let s = 0; s < secs * 10; s++) { ipod.input.turn(2); ipod.runFor(ms(100)); }
    const tr = samplingProfilerStackTraces(), self = new Map(), incl = new Map(), tiers = new Map();
    for (const t of tr.traces) {
      const f = t.frames.map(f => (f.name || '(anon)').replace(/^block_.*/, 'block_*') + (f.tier ? '' : ''));
      if (t.frames[0] && /^block_/.test(t.frames[0].name || '')) tiers.set(t.frames[0].category || t.frames[0].tier || JSON.stringify(Object.keys(t.frames[0])), (tiers.get(t.frames[0].category || t.frames[0].tier || JSON.stringify(Object.keys(t.frames[0]))) || 0) + 1);
      if (!f.length) continue;
      self.set(f[0], (self.get(f[0]) || 0) + 1);
      for (const k of new Set(f)) incl.set(k, (incl.get(k) || 0) + 1);
    }
    const n = tr.traces.length;
    print(`  ${n} samples; self:`); for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) print(`  ${(v / n * 100).toFixed(1).padStart(5)}% ${k}`);
    print('  block tiers: ' + JSON.stringify([...tiers]));
    print('  inclusive:'); for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 25)) print(`  ${(v / n * 100).toFixed(1).padStart(5)}% ${k}`);
  },
  pcs: n => { const m = new Map(); for (let i = 0; i < n; i++) { ipod.runFor(997); const k = `cpu ${ipod.sys.cpu.halted ? 'zz' : hex(ipod.sys.cpu.pc)} cop ${ipod.sys.cop.halted ? 'zz' : hex(ipod.sys.cop.pc)}`; m.set(k, (m.get(k) || 0) + 1); } for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 12)) print(`  ${v} x ${k}`); },
};
if (typeof FLUSH_WHO !== 'undefined' && ipod.sys.jit) {   // debug: who makes the translator flush
  const jj = ipod.sys.jit, f0 = jj.flush.bind(jj); globalThis.flushWho = new Map();
  jj.flush = () => { const k = new Error().stack.split("\n").slice(1, 4).map(s => s.split("@")[0]).join(" < ") + " addr " + hex(ipod.sys.lastCodeWrite || 0); ipod.sys.lastCodeWrite = 0; flushWho.set(k, (flushWho.get(k) || 0) + 1); f0(); };
}
const scenarios = {
  mp3: [['wait', 2500], ['press', 'select'], ['turn', 6], ['press', 'select'], ['turn', 12], ['press', 'select'], ['frame', 'list'], ['press', 'select'],
        ['pcs', 400], ['audio'], ['frame', 'playing'], ['wait', 3000], ['audio'], ['frame', 'playing2']],
  prefs: [['wait', 2500], ['press', 'select'], ['wait', 5000], ['harvest'], ['press', 'menu'], ['wait', 1000], ['press', 'play'], ['wait', 3000], ['harvest']],
  backlight: [['wait', 2500], ['press', 'select'], ['gpiolog', true], ['trace', true], ['print', 'hold menu'], ['hold', ['menu', 1800]], ['wait', 1000], ['print', 'hold menu again'], ['hold', ['menu', 1800]], ['wait', 1000], ['trace', false]],
  bench: [['wait', 2500], ['press', 'select'], ['turn', 6], ['press', 'select'], ['turn', 12], ['press', 'select'], ['press', 'select'], ['wait', 500], ['timeit', 8000]],
  rec: [['wait', 2500], ['press', 'select'], ['turn', 6], ['press', 'select'], ['turn', 12], ['press', 'select'], ['capture', true], ['press', 'select'], ['wait', 16000], ['capture', false]],
  hold: [['wait', 2500], ['press', 'select'], ['frame', 'main'], ['sethold', true], ['wait', 500], ['frame', 'hold on'], ['press', 'select'], ['frame', 'select while hold'],
         ['wait', 1500], ['frame', 'after'], ['turn', 6], ['frame', 'wheel while hold'], ['press', 'menu'], ['frame', 'menu while hold'], ['sethold', false], ['wait', 500], ['press', 'select'], ['frame', 'select after hold off']],
  reset: [['wait', 2500], ['press', 'select'], ['turn', 6], ['frame', 'before'], ['onreset'], ['combo', [['menu', 'play'], 4000]], ['print', 'released after 4 s'], ['combo', [['menu', 'play'], 6000]], ['print', 'released after 6 s']],
  about: [['wait', 2500], ['press', 'select'], ['turn', 18], ['press', 'select'], ['frame', 'settings'], ['press', 'select'], ['wait', 500], ['frame', 'about']],
  settings: [['wait', 2500], ['press', 'select'], ['turn', 18], ['press', 'select'], ['frame', 's0'], ['turn', 36], ['frame', 's6'], ['turn', 36], ['frame', 's12'], ['turn', 36], ['frame', 's18']],
  legal: [['wait', 2500], ['press', 'select'], ['turn', 6], ['press', 'select'], ['turn', 12], ['press', 'select'], ['press', 'select'], ['wait', 1500],
          ['scroll', [2, 0]], ['press', 'menu'], ['press', 'menu'], ['press', 'menu'], ['turn', 12], ['frame', 'main'], ['press', 'select'], ...Array(11).fill(['turn', 6]), ['frame', 'settings'],
          ['press', 'select'], ['wait', 500], ['frame', 'legal'], ['scroll', [8, 2]], ['frame', 'scrolled'], ['audio'], ...(typeof PROFILE !== 'undefined' ? [[PROFILE === 2 ? 'jsprof' : PROFILE === 3 ? 'scrollpcs' : 'iocount', PROFILE === 3 ? [3, 2] : 3], ...(PROFILE === 3 ? [['press', 'menu'], ['press', 'menu'], ['wait', 2000], ['frame', 'idle'], ['print', 'idle'], ['scrollpcs', [3, 0]]] : [])] : [])],
  doze: [['wait', 2500], ['press', 'select'], ['frame', 'awake'], ['print', 'idle'], ...Array(30).fill(['wait', 10000]), ['print', 'after 300 s idle'], ['state'], ['frame', 'idle 300 s'],
         ['press', 'menu'], ['wait', 2000], ['print', 'after menu press'], ['frame', 'after menu'], ['turn', 6], ['frame', 'after turn'], ['press', 'select'], ['frame', 'after select']],
  legalidle: [['wait', 2500], ['press', 'select'], ['turn', 6], ['press', 'select'], ['turn', 12], ['press', 'select'], ['press', 'select'], ['wait', 1500],
          ['press', 'menu'], ['press', 'menu'], ['press', 'menu'], ['turn', 12], ['press', 'select'], ...Array(11).fill(['turn', 6]), ['frame', 'settings'],
          ['press', 'select'], ['wait', 1000], ['frame', 'legal 1 s'], ['wait', 5000], ['frame', 'legal 6 s'], ['wait', 10000], ['frame', 'legal 16 s'], ['scroll', [3, 2]], ['frame', 'scrolled']],
  longselect: [['wait', 2500], ['press', 'select'], ['turn', 6], ['press', 'select'], ['turn', 12], ['press', 'select'], ['press', 'select'], ['wait', 1500],
          ['press', 'menu'], ['press', 'menu'], ['press', 'menu'], ['turn', 12], ['frame', 'main'], ['hold', ['select', 1500]], ['frame', 'after 1.5 s select hold'],
          ['press', 'menu'], ['wait', 500], ['frame', 'back'], ['hold', ['select', 400]], ['frame', 'after 0.4 s hold']],
  calib: [['wait', 2500], ['press', 'select'], ['frame', 'main'], ['turn', 1], ['frame', 't1'], ['turn', 1], ['frame', 't2'], ['turn', 1], ['frame', 't3'], ['turn', 1], ['frame', 't4'], ['turn', 2], ['frame', 't6'], ['turn', 2], ['frame', 't8']],
  songs: [['wait', 2500], ['press', 'select'], ['turn', 6], ['frame', 'main'], ['press', 'select'], ['frame', 'browse'],
          ['turn', 6], ['frame', 'b1'], ['turn', 6], ['frame', 'b2'], ['press', 'select'], ['frame', 'list'], ['state'], ['trace', true], ['press', 'select'], ['wait', 1500], ['trace', false], ['pcs', 300], ['state'], ['audio'], ['frame', 'playing'], ['wait', 2000], ['audio'], ['frame', 'playing2']],
};
const name = (typeof arguments !== 'undefined' && arguments[0]) || 'songs';
const t0 = Date.now();
for (const [op, arg] of scenarios[name]) steps[op](arg);
print(`emulated ${(ipod.sys.usec / 1e6).toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const l of logs.slice(-30)) print(l);

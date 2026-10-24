// Playback performance monitor:  jsc [fwsel.js] tools/perfplay.js -- <song file> [seconds]
// Plays one song and prints, per emulated second: wall time, speed, instructions per core, disk sectors read,
// I/O accesses and audio FIFO underruns inside the emulated iPod.
for (const f of ['arm7', 'jit', 'pp5002', 'devices', 'hints', 'hfsplus', 'itunesdb', 'disk', 'ipod']) load(`emu/${f}.js`);
const fwDir = typeof FW_DIR !== 'undefined' ? FW_DIR : 'fw';
const firmware = readFile(fwDir + '/Firmware', 'binary'), osos = readFile(fwDir + '/images/osos.bin', 'binary');
const file = arguments[0], seconds = Number(arguments[1] || 90);
const data = readFile(file, 'binary');
const kind = /\.mp3$/i.test(file) ? 'mp3' : 'wav';
const ms = kind === 'wav' ? (data.length - 44) / 4 / 44.1 : 240000;
const built = IPodDisk.build(firmware, [{ title: 'Long', artist: 'Perf', album: 'Perf', kind, data, ms, bitrate: kind === 'mp3' ? 320 : 1411 }], { name: 'iPod', time: 0 });
const ipod = createIPod({ osos, disk: built.disk });
const sys = ipod.sys;
const press = b => { ipod.input.press(b, true); ipod.runFor(120000); ipod.input.press(b, false); ipod.runFor(600000); };
ipod.runFor(2500000); press('select');
ipod.input.turn(6); ipod.runFor(700000); press('select');
ipod.input.turn(12); ipod.runFor(700000); press('select');
press('select');

// counters
let ioCalls = 0, sectorsRead = 0;
const io0 = sys.io.bind(sys); sys.io = (a, v, w, isW, pid) => { ioCalls++; return io0(a, v, w, isW, pid); };
const ide = sys.ide, s = ide.state;
let lastLba = -1;
print(`${kind} ${(data.length / 1e6).toFixed(1)} MB on firmware ${fwDir}`);
print('sec  wall_ms speed  cpu_Minstr cop_Minstr  io_k  sectors underruns');
let worst = Infinity, totalWall = 0;
const capFrom = typeof CAP_FROM !== 'undefined' ? CAP_FROM : 0, capTo = typeof CAP_TO !== 'undefined' ? CAP_TO : 0;
for (let sec = 1; sec <= seconds; sec++) {
  if (sec === capFrom) { sys.i2s.capture = []; sys.i2s.captureOdd = sys.i2s.outW & 1; }
  if (sec === capTo && sys.i2s.capture) {
    const c = sys.i2s.capture.slice(sys.i2s.captureOdd); sys.i2s.capture = null;
    let h = ''; for (const v of c) { const u = v & 0xFFFF; h += u.toString(16).padStart(4, '0'); } print('PCM ' + h);
  }
  const t0 = Date.now(), c0 = sys.cpu.cycles, p0 = sys.cop.cycles, io0n = ioCalls, u0 = sys.i2s.underruns;
  const reads0 = ide.sectorsRead || 0;
  ipod.runFor(1000000);
  const wall = Date.now() - t0; totalWall += wall;
  const speed = 1000 / Math.max(wall, 1);
  worst = Math.min(worst, speed);
  const line = `${String(sec).padStart(3)}  ${String(wall).padStart(6)}  ${(speed * 100).toFixed(0).padStart(4)}%  ${((sys.cpu.cycles - c0) / 1e6).toFixed(1).padStart(8)}  ${((sys.cop.cycles - p0) / 1e6).toFixed(1).padStart(8)}  ${((ioCalls - io0n) / 1000).toFixed(0).padStart(5)}  ${String((ide.sectorsRead || 0) - reads0).padStart(6)}  ${sys.i2s.underruns - u0}`;
  if (wall > 700 || sec % 10 === 0 || sys.i2s.underruns - u0) print(line);
}
print(`average ${(seconds * 1000 / totalWall * 100).toFixed(0)}% speed, worst second ${(worst * 100).toFixed(0)}%`);

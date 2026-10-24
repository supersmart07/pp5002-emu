// Snapshot round trip: run iPod A into a song, snapshot it, keep running A; restore the snapshot into a
// fresh iPod B built from an identical disk and run it the same way. Audio and screen must match exactly.
for (const f of ['arm7', 'jit', 'pp5002', 'devices', 'hints', 'hfsplus', 'itunesdb', 'disk', 'ipod']) load(`emu/${f}.js`);
const fwDir = typeof FW_DIR !== 'undefined' ? FW_DIR : 'fw';
const firmware = readFile(fwDir + '/Firmware', 'binary'), osos = readFile(fwDir + '/images/osos.bin', 'binary');
const mp3 = readFile('work/test.mp3', 'binary');
const songs = [{ title: 'Noise', artist: 'Test', album: 'Test', kind: 'mp3', data: mp3, ms: 10000, bitrate: 192 }];
const TIME = Date.UTC(2026, 9, 24, 12, 0, 0);
const build = () => IPodDisk.build(firmware, songs, { name: 'iPod', time: TIME }).disk;
const ms = n => n * 1000;
function press(ipod, b) { ipod.input.press(b, true); ipod.runFor(ms(120)); ipod.input.press(b, false); ipod.runFor(ms(600)); }
function record(ipod, n) {
  const a = ipod.sys.i2s; a.capture = []; ipod.runFor(ms(n)); const c = a.capture; a.capture = null;
  return { pcm: c, lcd: ipod.lcd.pixels() };
}

const d1 = build(), d2 = build();
let same = d1.length === d2.length; for (let i = 0; same && i < d1.length; i++) if (d1[i] !== d2[i]) same = false;
print('disk builds identical:', same, (d1.length / 1e6).toFixed(1) + ' MB');

const A = createIPod({ osos, disk: d1 });
A.runFor(ms(2500)); press(A, 'select');                               // language
A.input.turn(6); A.runFor(ms(700)); press(A, 'select');               // Browse
A.input.turn(12); A.runFor(ms(700)); press(A, 'select');              // Songs
press(A, 'select'); A.runFor(ms(2000));                               // play, 2 s in
let t0 = Date.now();
const snap = A.saveState();
const saveMs = Date.now() - t0;
const ra = record(A, 3000);

const B = createIPod({ osos, disk: d2 });
t0 = Date.now();
B.loadState(snap);
const loadMs = Date.now() - t0;
const rb = record(B, 3000);

let diffPcm = ra.pcm.length === rb.pcm.length ? 0 : -1;
if (!diffPcm) for (let i = 0; i < ra.pcm.length; i++) if (ra.pcm[i] !== rb.pcm[i]) diffPcm++;
let diffLcd = 0; for (let i = 0; i < ra.lcd.length; i++) if (ra.lcd[i] !== rb.lcd[i]) diffLcd++;
let peak = 0; for (const v of rb.pcm) peak = Math.max(peak, Math.abs(v));
print(`snapshot: ${snap.sys.sdram.idx.length} RAM pages (${(snap.sys.sdram.data.length / 1e6).toFixed(1)} MB), ${snap.disk.sectors.length} disk sectors; save ${saveMs} ms, load ${loadMs} ms`);
print(`after restore: ${rb.pcm.length} samples (peak ${peak}), audio differences ${diffPcm}, screen differences ${diffLcd}`);
let s = ''; for (const v of rb.lcd) s += v.toString(16); print('FRAME 160 128 ' + s + ' restored');

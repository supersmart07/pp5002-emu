// Headless runner for JavaScriptCore's jsc shell:
//   jsc tools/run.js -- <instructions> [trace]
// Loads firmware osos.bin at 0x28000000 and boots both cores there, as the flash bootloader would.
load('emu/arm7.js');
load('emu/pp5002.js');
load('emu/devices.js');

var peek = [0x3f7eb8 + 0x130, 0x3f7eb8 + 0xec, 0x3f7eb8 + 0xf0];
var gpioA = Number((typeof arguments !== 'undefined' && arguments[1]) || 0xdf);
const args = typeof arguments !== 'undefined' ? arguments : [];
const total = Number(args[0] || 2e6);
const fw = readFile('fw/images/osos.bin', 'binary');

const lines = [];
const sys = new PP5002({ log: s => { lines.push(s); print(s); } });
sys.attach(procIdDevice());
sys.attach(mmapDevice());
sys.attach(sysCtlDevice());
sys.timer = sys.attach(timerDevice());
sys.attach(cacheDevice());
sys.intc = sys.attach(intcDevice());
sys.ide = sys.attach(ideDevice(readFile('work/disk/ipod.img', 'binary')));
sys.ideLog = true;
sys.gpio = sys.attach(gpioDevice());
if (typeof gpioA !== 'undefined') sys.gpio.ext[0] = gpioA;
sys.lcd = sys.attach(lcdDevice());
sys.mbox = sys.attach(mailboxDevice());
sys.lcdLog = true;
sys.intc.addSource(() => (sys.timer.t[0].irq ? 1 << 11 : 0) | (sys.timer.t[1].irq ? 1 << 12 : 0) | (sys.ide.irqLine() ? 1 << 1 : 0) | (sys.gpio.irqLine() ? 1 << 14 : 0) | (sys.mbox.irqLine() ? 1 << 18 : 0));
sys.sd8.set(fw, 0);
sys.cpu.reset(0x28000000);
sys.cop.reset(0x28000000);

const recent = [];
sys.cpu.onUndefined = (c, op, pc) => { print(`[undef] ${c.name} pc=${hex(pc)} op=${hex(op)}`); return false; };
sys.cop.onUndefined = sys.cpu.onUndefined;

if (typeof watchValue !== 'undefined') {
  const orig = sys.write.bind(sys);
  sys.write = (a, v, w, pid) => { if (w === 4 && (v >>> 0) === watchValue) { const c = sys.cur; print(`[watch] ${c.name} pc=${hex(c.pc)} lr=${hex(c.r[14])} store ${hex(v)} -> ${hex(a)}`);
    if (c.pc === 0xef22c && !sys.btDone) { sys.btDone = true; const bt = []; for (let k = 0; k < 120; k++) { const x = c.bus.read32(c.r[13] + k * 4); if (x > 0x100 && x < 0x2bc068 && (x & 3) === 0) bt.push(hex(x)); } print('  stack code ptrs: ' + bt.join(' ')); } } orig(a, v, w, pid); };
}
// optional input script (define `script` in a file loaded before this one):
//   [{at: instructions, a: gpioA byte} | {at, frame: 'label'}]
const events = (typeof script !== 'undefined' ? script : []).slice().sort((x, y) => x.at - y.at);
function dumpFrame(label) {
  const px = sys.lcd.pixels();
  let s = '';
  for (let i = 0; i < px.length; i++) s += px[i].toString(16);
  print('FRAME ' + sys.lcd.width + ' ' + sys.lcd.height + ' ' + s + ' ' + (label || ''));
}
let done = 0;
const slice = 200;
const t0 = Date.now();
let lastPc = 0, samePc = 0;
while (done < total) {
  sys.step(slice);
  done += slice;
  while (events.length && events[0].at <= done) {
    const e = events.shift();
    if (e.a !== undefined) { sys.gpio.setExt(0, e.a); print('[input] A=' + e.a.toString(16) + ' at ' + done); }
    if (e.frame !== undefined) dumpFrame(e.frame);
  }
  if (done % 2000000 === 0) print(`.. ${done} instr, cpu pc=${hex(sys.cpu.pc)} cop pc=${hex(sys.cop.pc)} ${sys.cop.halted ? '(cop asleep)' : ''} usec=${sys.usec}`);
}
const ms = Date.now() - t0;
print(`ran ${done} instr in ${ms} ms (${(done / ms / 1000).toFixed(1)} MIPS)`);
const c = sys.cpu;
print(`cpu pc=${hex(c.pc)} cpsr=${hex(c.getCPSR())} ` + Array.from(c.r).map((v, i) => `r${i}=${hex(v)}`).join(' '));
if (typeof peek !== 'undefined') for (const a of peek) print(`peek ${hex(a)} = ${hex(sys.cpu.bus.read32(a))}`);

dumpFrame('end');
{
  const g = sys.gpio.regs, f = i => Array.from(g.slice(i, i + 4)).map(v => v.toString(16).padStart(2, '0')).join(' ');
  print(`gpio en=${f(0)} oe=${f(0x10)} out=${f(0x20)} in=${[0,1,2,3].map(p => sys.gpio.input(p).toString(16)).join(' ')} istat=${f(0x40)} ien=${f(0x50)} ilev=${f(0x60)}`);
  print(`intc cpu en=${hex(sys.intc.en[0])} fiq=${hex(sys.intc.fiqSel[0])} cop en=${hex(sys.intc.en[1])} raw=${hex(sys.intc.raw())}`);
}
{
  const rd = a => sys.cpu.bus.read32(a);
  for (let p = 0; p < 4; p++) {
    const obj = rd(0x392968 + p * 4);
    if (!obj) continue;
    const cb = [], arg = [];
    for (let i = 0; i < 8; i++) { cb.push(hex(rd(obj + i * 4)).slice(4)); arg.push(hex(rd(obj + 0x20 + i * 4)).slice(2)); }
    print(`port${'ABCD'[p]} obj=${hex(obj)} cb=[${cb.join(' ')}] arg=[${arg.join(' ')}]`);
  }
}

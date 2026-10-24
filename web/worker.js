// Runs the emulated iPod off the main thread; the loop itself lives in runner.js.
// The page starts this worker with a unique query string and the same string is passed on to every script
// loaded here, so an updated emulator never runs against cached copies of older scripts.
const q = self.location.search;
importScripts(...['../emu/arm7.js', '../emu/jit.js', '../emu/pp5002.js', '../emu/devices.js', '../emu/hints.js',
  '../emu/hfsplus.js', '../emu/itunesdb.js', '../emu/disk.js', '../emu/ipod.js', '../emu/inflate.js', 'runner.js'].map(u => u + q));

const runner = createRunner((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = e => runner.handle(e.data);

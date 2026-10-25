// Audio output for the emulator: a ring of interleaved 16-bit stereo frames at 44.1 kHz, read with linear
// interpolation at the output rate. The read speed is nudged (at most ±0.5%) to keep about 250 ms buffered,
// which absorbs drift between the emulated clock and the sound card without audible pitch change.
// Loaded twice: as an AudioWorklet module (registers the processor) and as a plain script (ScriptProcessor fallback).
'use strict';

class AudioRing {
  constructor(outRate) {
    this.size = 1 << 16;                       // frames (~1.5 s)
    this.buf = new Int16Array(this.size * 2);
    this.w = 0;                                // frames written (absolute)
    this.r = 0;                                // read position in frames (fractional, absolute)
    this.base = 44100 / outRate;
    this.target = Math.round(44100 * 0.25);
    this.playing = false;                      // false while (re)filling after an underrun
    this.gain = 1; this.gainNow = 1; this.muted = false;
    this.underruns = 0;
  }
  push(pcm, gain) {
    if (gain !== undefined) this.gain = gain;
    const n = pcm.length >> 1, mask = this.size - 1;
    for (let i = 0; i < n; i++) {
      const k = ((this.w + i) & mask) * 2;
      this.buf[k] = pcm[i * 2]; this.buf[k + 1] = pcm[i * 2 + 1];
    }
    this.w += n;
    if (this.w - this.r > this.size - 1024) this.r = this.w - this.target;   // far behind: skip ahead
  }
  fill() { return this.w - this.r; }
  render(L, R) {
    const mask = this.size - 1, n = L.length;
    let fill = this.w - this.r;
    if (!this.playing && fill >= this.target) this.playing = true;
    if (!this.playing) { L.fill(0); R.fill(0); return; }
    const step = this.base * (1 + Math.max(-0.005, Math.min(0.005, (fill - this.target) / this.target * 0.01)));
    const g0 = this.gainNow, g1 = (this.muted ? 0 : this.gain);
    for (let i = 0; i < n; i++) {
      if (this.w - this.r < 2) {                // underrun: fade to silence and refill
        for (let j = i; j < n; j++) { L[j] = 0; R[j] = 0; }
        this.playing = false; this.underruns++; break;
      }
      const g = (g0 + (g1 - g0) * (i / n)) / 32768;
      const ri = Math.floor(this.r), f = this.r - ri;
      const a = (ri & mask) * 2, b = ((ri + 1) & mask) * 2;
      L[i] = (this.buf[a] + (this.buf[b] - this.buf[a]) * f) * g;
      R[i] = (this.buf[a + 1] + (this.buf[b + 1] - this.buf[a + 1]) * f) * g;
      this.r += step;
    }
    this.gainNow = g1;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('ipod-out', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.ring = new AudioRing(sampleRate);
      const onMsg = e => {
        const m = e.data;
        if (m.type === 'audio') this.ring.push(m.pcm, m.gain);
        else if (m.type === 'mute') this.ring.muted = m.on;
        else if (m.type === 'port') m.port.onmessage = onMsg;   // direct line from the emulator thread
        else if (m.type === 'stats') this.port.postMessage({ type: 'stats', fill: this.ring.fill(), playing: this.ring.playing,
          played: this.ring.r / 44100, underruns: this.ring.underruns });
      };
      this.port.onmessage = onMsg;
    }
    process(inputs, outputs) {
      const out = outputs[0];
      this.ring.render(out[0], out[1] || out[0]);
      return true;
    }
  });
}

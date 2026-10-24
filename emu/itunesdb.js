// iTunesDB writer in the early (iTunes 2/3) layout read by iPod Software 1.x.
// Tracks: {id, title, artist, album, genre, path (':iPod_Control:Music:F00:X.wav'), size, ms, kind, bitrate, rate, track}
'use strict';

const ITunesDB = (() => {
  class W {
    constructor() { this.a = []; this.n = 0; }
    u8(v) { this.a.push(v & 0xFF); this.n++; }
    u16(v) { this.u8(v); this.u8(v >>> 8); }
    u32(v) { this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24); }
    tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
    pad(to) { while (this.n < to) this.u8(0); }
    bytes(b) { for (const x of b) this.u8(x); }
    out() { return new Uint8Array(this.a); }
  }
  const cat = parts => { const len = parts.reduce((s, p) => s + p.length, 0), o = new Uint8Array(len); let p = 0; for (const x of parts) { o.set(x, p); p += x.length; } return o; };
  const set32 = (b, off, v) => { b[off] = v & 0xFF; b[off + 1] = (v >>> 8) & 0xFF; b[off + 2] = (v >>> 16) & 0xFF; b[off + 3] = (v >>> 24) & 0xFF; };

  function mhodString(type, s) {
    const w = new W();
    const str = String(s || '');
    w.tag('mhod'); w.u32(0x18); w.u32(0x18 + 16 + str.length * 2); w.u32(type); w.u32(0); w.u32(0);
    w.u32(1); w.u32(str.length * 2); w.u32(0); w.u32(0);
    for (let i = 0; i < str.length; i++) w.u16(str.charCodeAt(i));
    return w.out();
  }
  function mhodPosition(pos) {
    const w = new W();
    w.tag('mhod'); w.u32(0x18); w.u32(0x2C); w.u32(100); w.u32(0); w.u32(0);
    w.u32(pos); w.pad(0x2C);
    return w.out();
  }

  let stampMs = null;   // fixed creation time for reproducible builds (null: now)
  function mhit(t) {
    const mhods = [mhodString(1, t.title), mhodString(2, t.path), mhodString(3, t.album), mhodString(4, t.artist)];
    if (t.genre) mhods.push(mhodString(5, t.genre));
    mhods.push(mhodString(6, t.kindName || (t.kind === 'mp3' ? 'MPEG audio file' : t.kind === 'aiff' ? 'AIFF audio file' : 'WAV audio file')));
    const h = new W();
    const body = cat(mhods);
    const stamp = (Math.floor((stampMs === null ? Date.now() : stampMs) / 1000) + 2082844800) >>> 0;
    h.tag('mhit'); h.u32(0x9C); h.u32(0x9C + body.length); h.u32(mhods.length);
    h.u32(t.id); h.u32(1);
    h.u32(t.kind === 'mp3' ? 0x4D503320 : t.kind === 'aiff' ? 0x41494646 : 0x57415620); // 'MP3 ', 'AIFF', 'WAV '
    h.u8(t.kind === 'mp3' ? 1 : 0); h.u8(1); h.u8(0); h.u8(0);
    h.u32(stamp); h.u32(t.size); h.u32(t.ms); h.u32(t.track || 0); h.u32(t.tracks || 0); h.u32(t.year || 0);
    h.u32(t.bitrate || 1411); h.u32(((t.rate || 44100) << 16) >>> 0);
    h.pad(0x68); h.u32(stamp);            // time added
    h.pad(0x9C);
    return cat([h.out(), body]);
  }

  function mhip(trackId, pos) {
    const pm = mhodPosition(pos);
    const h = new W();
    h.tag('mhip'); h.u32(0x4C); h.u32(0x4C + pm.length); h.u32(1); h.u32(0); h.u32(pos);
    h.u32(trackId); h.u32(0);
    h.pad(0x4C);
    return cat([h.out(), pm]);
  }

  function mhyp(name, trackIds, master, plId) {
    const title = mhodString(1, name);
    const items = trackIds.map((id, i) => mhip(id, i + 1));
    const h = new W();
    const body = cat([title, ...items]);
    h.tag('mhyp'); h.u32(0x6C); h.u32(0x6C + body.length); h.u32(1); h.u32(trackIds.length);
    h.u32(master ? 1 : 0); h.u32(0); h.u32(plId >>> 0); h.u32(0);
    h.pad(0x6C);
    return cat([h.out(), body]);
  }

  function mhsd(type, child) {
    const h = new W();
    h.tag('mhsd'); h.u32(0x60); h.u32(0x60 + child.length); h.u32(type); h.pad(0x60);
    return cat([h.out(), child]);
  }

  // tracks: array as above; playlists: [{name, ids:[...]}]; name: the iPod's name (master playlist title)
  function build(tracks, playlists, name, time) {
    stampMs = time === undefined ? null : time;
    const items = tracks.map(mhit);
    const lt = new W(); lt.tag('mhlt'); lt.u32(0x5C); lt.u32(tracks.length); lt.pad(0x5C);
    const trackSet = mhsd(1, cat([lt.out(), ...items]));
    const pls = [mhyp(name || 'iPod', tracks.map(t => t.id), true, 0x1000)];
    (playlists || []).forEach((p, i) => pls.push(mhyp(p.name, p.ids, false, 0x2000 + i)));
    const lp = new W(); lp.tag('mhlp'); lp.u32(0x5C); lp.u32(pls.length); lp.pad(0x5C);
    const plSet = mhsd(2, cat([lp.out(), ...pls]));
    const h = new W();
    h.tag('mhbd'); h.u32(0x68); h.u32(0); h.u32(1); h.u32(1); h.u32(2);
    h.pad(0x68);
    const db = cat([h.out(), trackSet, plSet]);
    set32(db, 8, db.length);
    return db;
  }

  return { build };
})();

if (typeof module !== 'undefined') module.exports = { ITunesDB };

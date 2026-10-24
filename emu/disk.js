// Builds the emulated iPod hard disk: Apple partition map, Apple_MDFW firmware partition, Apple_HFS data volume.
// songs: [{title, artist, album, genre, track, ms, kind: 'mp3'|'wav'|'aiff', data: Uint8Array}]
'use strict';

const IPodDisk = (() => {
  const BS = 512;
  const enc = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF; return b; };

  function apmEntry(count, start, blocks, name, type, status) {
    const e = new Uint8Array(BS), dv = new DataView(e.buffer);
    e[0] = 0x50; e[1] = 0x4D; dv.setUint32(4, count); dv.setUint32(8, start); dv.setUint32(12, blocks);
    e.set(enc(name).subarray(0, 31), 16); e.set(enc(type).subarray(0, 31), 48);
    dv.setUint32(84, 0); dv.setUint32(88, blocks); dv.setUint32(92, status);
    return e;
  }

  // extra: Map of 'iPod_Control/Device/Preferences' style paths -> Uint8Array, kept from earlier sessions
  // time: build timestamp in ms; the same songs, extra files and time always give the same disk bytes
  function build(firmware, songs, opts) {
    opts = opts || {};
    const H = HFSPlus;
    const tracks = [], folders = new Map();
    let musicBytes = 0;
    songs.forEach((s, i) => {
      const dir = 'F' + String(i % 20).padStart(2, '0');
      const ext = s.kind === 'mp3' ? 'mp3' : s.kind === 'aiff' ? 'aif' : 'wav';
      const fname = 'T' + String(i + 1).padStart(4, '0') + '.' + ext;
      if (!folders.has(dir)) folders.set(dir, H.folder());
      folders.get(dir).children.set(fname, H.file(s.data, H.fourcc(ext === 'mp3' ? 'MPG3' : ext === 'aif' ? 'AIFF' : 'WAVE'), H.fourcc('hook')));
      musicBytes += s.data.length;
      tracks.push({
        id: 1000 + i, title: s.title, artist: s.artist || 'Unknown Artist', album: s.album || 'Unknown Album', genre: s.genre,
        track: s.track, path: `:iPod_Control:Music:${dir}:${fname}`, size: s.data.length, ms: Math.round(s.ms || 0),
        kind: s.kind, bitrate: s.bitrate, rate: s.rate
      });
    });
    const music = H.folder([...folders.entries()].sort());
    const db = ITunesDB.build(tracks, opts.playlists || [], opts.name || 'iPod', opts.time);
    const control = H.folder([
      ['Music', music],
      ['iTunes', H.folder([['iTunesDB', H.file(db, H.fourcc('ITDB'), H.fourcc('hook'))]])],
      ['Device', H.folder()]
    ]);
    const root = H.folder([['iPod_Control', control], ['Calendars', H.folder()], ['Contacts', H.folder()]]);
    for (const [path, data] of (opts.extra || new Map())) {
      const parts = path.split('/'); let n = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!n.children.has(parts[i])) n.children.set(parts[i], H.folder());
        n = n.children.get(parts[i]);
      }
      n.children.set(parts[parts.length - 1], H.file(data));
    }

    const hfsSize = Math.ceil((musicBytes + db.length + 48 * 1024 * 1024) / (1024 * 1024)) * 1024 * 1024;
    const mapStart = 1, mapBlocks = 63, fwStart = 64, fwBlocks = 8 * 1024 * 1024 / BS;
    const hfsStart = fwStart + fwBlocks, hfsBlocks = hfsSize / BS;
    const total = hfsStart + hfsBlocks;
    const disk = new Uint8Array(total * BS);
    const dv = new DataView(disk.buffer);
    disk[0] = 0x45; disk[1] = 0x52; dv.setUint16(2, BS); dv.setUint32(4, total);
    const parts = [[mapStart, mapBlocks, 'Apple', 'Apple_partition_map', 0x37], [fwStart, fwBlocks, 'firmware', 'Apple_MDFW', 0x37], [hfsStart, hfsBlocks, 'disk', 'Apple_HFS', 0x40000033]];
    parts.forEach((p, i) => disk.set(apmEntry(parts.length, ...p), (1 + i) * BS));
    disk.set(firmware.subarray(0, Math.min(firmware.length, fwBlocks * BS)), fwStart * BS);
    H.build({ size: hfsSize, root, volumeName: opts.name || 'iPod', into: disk.subarray(hfsStart * BS), time: opts.time });
    return { disk, hfsOffset: hfsStart * BS, tracks };
  }

  // files the firmware wrote that are worth keeping between sessions
  function harvest(disk, hfsOffset) {
    const keep = new Map();
    try {
      const vol = HFSPlus.open(disk, hfsOffset), tree = HFSPlus.tree(vol);
      const dev = HFSPlus.find(tree, 'iPod_Control/Device');
      if (dev && dev.children) for (const [name, n] of dev.children) if (n.kind === 'file') keep.set('iPod_Control/Device/' + name, HFSPlus.readFork(vol, n.rec.data));
      const pc = HFSPlus.find(tree, 'iPod_Control/iTunes/Play Counts');
      if (pc && pc.kind === 'file') keep.set('iPod_Control/iTunes/Play Counts', HFSPlus.readFork(vol, pc.rec.data));
    } catch (e) { /* unreadable volume: start fresh */ }
    return keep;
  }

  return { build, harvest };
})();

if (typeof module !== 'undefined') module.exports = { IPodDisk };

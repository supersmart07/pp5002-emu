// Windows installer formats, enough to pull iPod firmware out of Apple's Windows updaters:
//   - Compound File Binary (OLE / .msi): stream reader
//   - Microsoft Cabinet (MSCF): folders and files, with stored, MSZIP and LZX compression
// LZX follows the algorithm in Microsoft's cabinet LZX specification (as implemented by libmspack).
'use strict';

const WinArchive = (() => {
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const OLE_SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

  // ---------- Compound File Binary ----------
  // returns [{name, data}] for every stream of the compound file starting at `base` in `buf`
  function cfbStreams(buf, base) {
    const b = buf.subarray(base);
    for (let i = 0; i < 8; i++) if (b[i] !== OLE_SIG[i]) throw new Error('not a compound file');
    const ss = 1 << u16(b, 0x1E), mss = 1 << u16(b, 0x20);
    const nFat = u32(b, 0x2C), dirStart = u32(b, 0x30), cutoff = u32(b, 0x38);
    const miniFatStart = u32(b, 0x3C), difatStart = u32(b, 0x44);
    const sector = n => (n + 1) * ss;
    // DIFAT -> FAT sector list
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(u32(b, 0x4C + i * 4));
    for (let s = difatStart; fatSectors.length < nFat && s < 0xFFFFFFFA;) {
      const o = sector(s);
      for (let i = 0; i < ss / 4 - 1 && fatSectors.length < nFat; i++) fatSectors.push(u32(b, o + i * 4));
      s = u32(b, o + ss - 4);
    }
    const fat = new Uint32Array(fatSectors.length * ss / 4);
    fatSectors.forEach((s, k) => { const o = sector(s); for (let i = 0; i < ss / 4; i++) fat[k * ss / 4 + i] = o + i * 4 + 4 <= b.length ? u32(b, o + i * 4) : 0xFFFFFFFE; });
    const chain = (start, table, guard) => { const out = []; for (let s = start; s < 0xFFFFFFFA && out.length < guard; s = table[s]) out.push(s); return out; };
    const readChain = (start, size) => {
      const out = new Uint8Array(size); let p = 0;
      for (const s of chain(start, fat, fat.length)) { const n = Math.min(ss, size - p); if (n <= 0) break; out.set(b.subarray(sector(s), sector(s) + n), p); p += n; }
      return out;
    };
    const dirSecs = chain(dirStart, fat, fat.length);
    const dir = new Uint8Array(dirSecs.length * ss);
    dirSecs.forEach((s, k) => dir.set(b.subarray(sector(s), sector(s) + ss), k * ss));
    const entries = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
      const type = dir[o + 0x42];
      if (!type) continue;
      const nameLen = u16(dir, o + 0x40);
      let name = ''; for (let i = 0; i + 2 < nameLen; i += 2) name += String.fromCharCode(u16(dir, o + i));
      entries.push({ name, type, start: u32(dir, o + 0x74), size: u32(dir, o + 0x78) });
    }
    const root = entries.find(e => e.type === 5);
    const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
    const miniFatBytes = miniFatStart < 0xFFFFFFFA ? readChain(miniFatStart, chain(miniFatStart, fat, fat.length).length * ss) : new Uint8Array(0);
    const miniFat = new Uint32Array(miniFatBytes.length / 4); for (let i = 0; i < miniFat.length; i++) miniFat[i] = u32(miniFatBytes, i * 4);
    return entries.filter(e => e.type === 2).map(e => {
      if (e.size >= cutoff) return { name: e.name, data: readChain(e.start, e.size) };
      const out = new Uint8Array(e.size); let p = 0;
      for (const s of chain(e.start, miniFat, miniFat.length)) { const n = Math.min(mss, e.size - p); if (n <= 0) break; out.set(miniStream.subarray(s * mss, s * mss + n), p); p += n; }
      return { name: e.name, data: out };
    });
  }
  function findCompoundFiles(buf) {
    const hits = [];
    outer: for (let i = buf.indexOf(0xD0); i !== -1 && i + 8 <= buf.length; i = buf.indexOf(0xD0, i + 1)) {
      for (let k = 1; k < 8; k++) if (buf[i + k] !== OLE_SIG[k]) continue outer;
      hits.push(i);
    }
    return hits;
  }

  // ---------- LZX ----------
  function lzxDecompress(src, windowBits, outLen) {
    const slots = { 15: 30, 16: 32, 17: 34, 18: 36, 19: 38, 20: 42, 21: 50 }[windowBits];
    if (!slots) throw new Error('unsupported LZX window');
    const extra = new Uint8Array(51), base = new Uint32Array(51);
    for (let i = 0, j = 0; i < 51; i += 2) { extra[i] = j; extra[i + 1] = j; if (i !== 0 && j < 17) j++; }
    for (let i = 0, j = 0; i < 51; i++) { base[i] = j; j += 1 << extra[i]; }
    const MAIN = 256 + slots * 8, LEN = 249;
    const out = new Uint8Array(outLen);
    let pos = 0, inPos = 0, bitBuf = 0, bitsLeft = 0;
    const fill = () => { while (bitsLeft <= 16) { const w = inPos + 1 < src.length ? src[inPos] | (src[inPos + 1] << 8) : 0; inPos += 2; bitBuf |= w << (16 - bitsLeft); bitsLeft += 16; } };
    const bits = n => { if (n === 0) return 0; fill(); const v = bitBuf >>> (32 - n); bitBuf <<= n; bitsLeft -= n; return v; };
    function tree(lens, n) {
      const count = new Uint16Array(17), offs = new Uint16Array(17), sym = new Uint16Array(n);
      for (let i = 0; i < n; i++) count[lens[i]]++;
      count[0] = 0;
      for (let i = 1; i < 17; i++) offs[i] = offs[i - 1] + count[i - 1];
      for (let i = 0; i < n; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
      return { count, sym };
    }
    function decode(t) {
      fill();
      let code = 0, first = 0, index = 0, buf = bitBuf;
      for (let len = 1; len <= 16; len++) {
        code |= (buf >>> 31) & 1; buf <<= 1;
        const c = t.count[len];
        if (code - c < first) { bitBuf <<= len; bitsLeft -= len; return t.sym[index + code - first]; }
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error('LZX: bad Huffman code');
    }
    function readLens(lens, from, to) {
      const pl = new Uint8Array(20);
      for (let i = 0; i < 20; i++) pl[i] = bits(4);
      const pt = tree(pl, 20);
      for (let x = from; x < to;) {
        let z = decode(pt);
        if (z === 17) { let y = bits(4) + 4; while (y-- && x < to) lens[x++] = 0; }
        else if (z === 18) { let y = bits(5) + 20; while (y-- && x < to) lens[x++] = 0; }
        else if (z === 19) { let y = bits(1) + 4; z = decode(pt); z = lens[x] - z; if (z < 0) z += 17; while (y-- && x < to) lens[x++] = z; }
        else { z = lens[x] - z; if (z < 0) z += 17; lens[x++] = z; }
      }
    }
    const mainLens = new Uint8Array(MAIN), lenLens = new Uint8Array(LEN), alignLens = new Uint8Array(8);
    let mainT = null, lenT = null, alignT = null;
    let R0 = 1, R1 = 1, R2 = 1, blockType = 0, blockLeft = 0, intelSize = 0, intelStarted = false;
    const intelFlag = bits(1);
    if (intelFlag) { const hi = bits(16), lo = bits(16); intelSize = (hi << 16) | lo; }
    let frameStart = 0;
    const e8Frames = [];
    while (pos < outLen) {
      const frameEnd = Math.min(frameStart + 32768, outLen);
      while (pos < frameEnd) {
        if (blockLeft === 0) {
          blockType = bits(3);
          blockLeft = (bits(16) << 8) | bits(8);
          if (blockType === 2) { for (let i = 0; i < 8; i++) alignLens[i] = bits(3); alignT = tree(alignLens, 8); }
          if (blockType === 1 || blockType === 2) {
            readLens(mainLens, 0, 256); readLens(mainLens, 256, MAIN); mainT = tree(mainLens, MAIN);
            if (mainLens[0xE8]) intelStarted = true;
            readLens(lenLens, 0, LEN); lenT = tree(lenLens, LEN);
          } else if (blockType === 3) {
            intelStarted = true;
            // 1-16 bits of padding up to the next 16-bit boundary, counted from the bits actually consumed
            const consumed = inPos * 8 - bitsLeft;
            inPos = ((consumed >> 4) + 1) * 2; bitBuf = 0; bitsLeft = 0;
            R0 = u32(src, inPos); R1 = u32(src, inPos + 4); R2 = u32(src, inPos + 8); inPos += 12;
          } else throw new Error('LZX: bad block type ' + blockType);
        }
        let run = Math.min(blockLeft, frameEnd - pos);
        blockLeft -= run;
        if (blockType === 3) {
          out.set(src.subarray(inPos, inPos + run), pos); pos += run; inPos += run;
          if (blockLeft === 0 && (inPos & 1)) inPos++;   // uncompressed blocks are padded to 16 bits
          continue;
        }
        while (run > 0) {
          let m = decode(mainT);
          if (m < 256) { out[pos++] = m; run--; continue; }
          m -= 256;
          let len = m & 7;
          if (len === 7) len += decode(lenT);
          len += 2;
          let off = m >> 3;
          if (off > 2) {
            const e = extra[off];
            if (blockType === 2) {
              off = base[off] - 2;
              if (e > 3) { off += bits(e - 3) << 3; off += decode(alignT); }
              else if (e === 3) off += decode(alignT);
              else if (e > 0) off += bits(e);
              else off = 1;
            } else off = off !== 3 ? base[off] - 2 + bits(e) : 1;
            R2 = R1; R1 = R0; R0 = off;
          } else if (off === 0) off = R0;
          else if (off === 1) { off = R1; R1 = R0; R0 = off; }
          else { off = R2; R2 = R0; R0 = off; }
          // a match may run past the frame boundary; the overrun is credited back to the block below
          for (let k = 0; k < len; k++, pos++) out[pos] = out[pos - off];
          run -= len;
        }
        if (run < 0) blockLeft += run;
      }
      // E8 translation applies to frames finished after it was switched on; it runs after decoding (below)
      // because the output doubles as the match window, which must keep the untranslated bytes
      if (intelStarted && intelSize) e8Frames.push(frameStart);
      frameStart += 32768;
      if (frameStart > pos) frameStart = pos;   // overrun into the next frame stays in place
      // realign the bit stream to 16 bits at every frame boundary
      if (bitsLeft > 0) fill();
      const drop = bitsLeft & 15; if (drop) { bitBuf <<= drop; bitsLeft -= drop; }
    }
    // E8 call translation (x86 executables): absolute call targets back to relative, frame by frame
    for (const fs of e8Frames) {
      const frameLen = Math.min(32768, outLen - fs);
      if (frameLen <= 10 || fs >= 32768 * 32768) continue;
      const end = fs + frameLen - 10;
      for (let p = fs; p < end;) {
        if (out[p++] !== 0xE8) continue;
        const cur = p - 1;
        const abs = out[p] | (out[p + 1] << 8) | (out[p + 2] << 16) | (out[p + 3] << 24);
        if (abs >= -cur && abs < intelSize) {
          const rel = abs >= 0 ? abs - cur : abs + intelSize;
          out[p] = rel & 0xFF; out[p + 1] = (rel >>> 8) & 0xFF; out[p + 2] = (rel >>> 16) & 0xFF; out[p + 3] = (rel >>> 24) & 0xFF;
        }
        p += 4;
      }
    }
    return out;
  }

  // ---------- Cabinet ----------
  // returns [{name, data}] for every file in the cabinet at `base`
  function cabFiles(buf, base) {
    const b = buf.subarray(base);
    if (b[0] !== 0x4D || b[1] !== 0x53 || b[2] !== 0x43 || b[3] !== 0x46) throw new Error('not a cabinet');
    const filesOff = u32(b, 16), nFolders = u16(b, 26), nFiles = u16(b, 28), flags = u16(b, 30);
    let p = 36, resFolder = 0, resData = 0;
    if (flags & 4) { const resHdr = u16(b, 36); resFolder = b[38]; resData = b[39]; p = 40 + resHdr; }
    if (flags & 1) { while (b[p++]) {} while (b[p++]) {} }
    if (flags & 2) { while (b[p++]) {} while (b[p++]) {} }
    const folders = [];
    for (let i = 0; i < nFolders; i++, p += 8 + resFolder) folders.push({ dataOff: u32(b, p), blocks: u16(b, p + 4), comp: u16(b, p + 6) });
    const files = [];
    for (let i = 0, q = filesOff; i < nFiles; i++) {
      const size = u32(b, q), off = u32(b, q + 4), folder = u16(b, q + 8);
      let name = ''; q += 16; while (b[q]) name += String.fromCharCode(b[q++]); q++;
      files.push({ name, size, off, folder });
    }
    const cache = new Map();
    const folderData = fi => {
      if (cache.has(fi)) return cache.get(fi);
      const f = folders[fi];
      let q = f.dataOff, total = 0; const parts = [];
      for (let k = 0; k < f.blocks; k++) {
        const cb = u16(b, q + 4), un = u16(b, q + 6);
        parts.push(b.subarray(q + 8 + resData, q + 8 + resData + cb)); total += un; q += 8 + resData + cb;
      }
      const type = f.comp & 0xF;
      let out;
      if (type === 0) { out = new Uint8Array(total); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } }
      else if (type === 1) { // MSZIP: each block is "CK" + deflate data sharing the previous block's history
        out = new Uint8Array(total); let o = 0;
        for (const x of parts) { const r = Inflate.inflateRaw(x, 2, 32768).data; out.set(r, o); o += r.length; }
      } else if (type === 3) {
        let len = 0; for (const x of parts) len += x.length;
        const src = new Uint8Array(len); let o = 0; for (const x of parts) { src.set(x, o); o += x.length; }
        out = lzxDecompress(src, (f.comp >> 8) & 0x1F, total);
      } else throw new Error('unsupported cabinet compression ' + type);
      cache.set(fi, out);
      return out;
    };
    return files.map(f => ({ name: f.name, get data() { return folderData(f.folder).subarray(f.off, f.off + f.size); } }));
  }

  return { cfbStreams, findCompoundFiles, cabFiles, lzxDecompress };
})();

if (typeof module !== 'undefined') module.exports = { WinArchive };

// Small DEFLATE decoder (RFC 1951) with zlib (RFC 1950) and gzip (RFC 1952) wrappers.
'use strict';

const Inflate = (() => {
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  // canonical Huffman table: counts per length + symbols sorted by code
  function table(lengths, n) {
    const count = new Uint16Array(16), symbols = new Uint16Array(n), offs = new Uint16Array(16);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { count, symbols };
  }

  function inflateRaw(src, start, sizeHint) {
    let pos = start || 0, bitBuf = 0, bitCnt = 0;
    let out = new Uint8Array(sizeHint || Math.max(1024, src.length * 4)), op = 0;
    const need = n => { if (op + n > out.length) { const o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out.subarray(0, op)); out = o; } };
    const bits = n => {
      while (bitCnt < n) { if (pos >= src.length) throw new Error('inflate: unexpected end of data'); bitBuf |= src[pos++] << bitCnt; bitCnt += 8; }
      const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v;
    };
    const decode = t => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const c = t.count[len];
        if (code - c < first) return t.symbols[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: bad Huffman code');
    };
    let fixedL = null, fixedD = null;
    for (;;) {
      const final = bits(1), type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        const len = src[pos] | (src[pos + 1] << 8); pos += 4;
        need(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
      } else {
        let lt, dt;
        if (type === 1) {
          if (!fixedL) {
            const l = new Uint8Array(288);
            for (let i = 0; i < 144; i++) l[i] = 8; for (let i = 144; i < 256; i++) l[i] = 9;
            for (let i = 256; i < 280; i++) l[i] = 7; for (let i = 280; i < 288; i++) l[i] = 8;
            fixedL = table(l, 288); fixedD = table(new Uint8Array(30).fill(5), 30);
          }
          lt = fixedL; dt = fixedD;
        } else if (type === 2) {
          const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
          const ct = table(cl, 19);
          const lens = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const sym = decode(ct);
            if (sym < 16) lens[i++] = sym;
            else if (sym === 16) { const prev = lens[i - 1]; for (let r = 3 + bits(2); r > 0; r--) lens[i++] = prev; }
            else if (sym === 17) i += 3 + bits(3);
            else i += 11 + bits(7);
          }
          lt = table(lens.subarray(0, hlit), hlit); dt = table(lens.subarray(hlit), hdist);
        } else throw new Error('inflate: bad block type');
        for (;;) {
          const sym = decode(lt);
          if (sym < 256) { need(1); out[op++] = sym; continue; }
          if (sym === 256) break;
          const li = sym - 257, len = LBASE[li] + bits(LEXT[li]);
          const di = decode(dt), dist = DBASE[di] + bits(DEXT[di]);
          need(len);
          for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
        }
      }
      if (final) break;
    }
    return { data: out.subarray(0, op), end: pos };
  }

  function zlib(src) { return inflateRaw(src, 2).data; }

  function gunzip(src) {
    if (src[0] !== 0x1F || src[1] !== 0x8B) throw new Error('not gzip data');
    const flags = src[3];
    let p = 10;
    if (flags & 4) p += 2 + (src[p] | (src[p + 1] << 8));
    if (flags & 8) { while (src[p++]) {} }
    if (flags & 16) { while (src[p++]) {} }
    if (flags & 2) p += 2;
    const n = src.length;
    const isize = (src[n - 4] | (src[n - 3] << 8) | (src[n - 2] << 16) | (src[n - 1] << 24)) >>> 0;
    return inflateRaw(src, p, isize + 16).data;
  }

  return { inflateRaw, zlib, gunzip };
})();

if (typeof module !== 'undefined') module.exports = { Inflate };

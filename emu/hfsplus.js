// HFS+ volume reader and writer (Apple TN1150), enough for iPod disks and the updater image.
// The writer builds a whole volume from a file tree: contiguous files, catalog B-tree with spare nodes.
'use strict';

const HFSPlus = (() => {
  const HFS_EPOCH = 2082844800; // seconds from 1904-01-01 to 1970-01-01
  const now = () => (Math.floor(Date.now() / 1000) + HFS_EPOCH) >>> 0;

  // ---------- reading ----------
  function open(img, base) {
    base = base || 0;
    const dv = new DataView(img.buffer, img.byteOffset + base);
    if (dv.getUint16(1024) !== 0x482B && dv.getUint16(1024) !== 0x4858) throw new Error('not an HFS+ volume');
    const bs = dv.getUint32(1024 + 0x28);
    const fork = off => {
      const ext = [];
      for (let i = 0; i < 8; i++) {
        const s = dv.getUint32(1024 + off + 16 + i * 8), c = dv.getUint32(1024 + off + 20 + i * 8);
        if (c) ext.push([s, c]);
      }
      return { size: Number(dv.getBigUint64(1024 + off)), extents: ext };
    };
    return { img, base, dv, bs, catalog: fork(0x110), extents: fork(0xC0), alloc: fork(0x70) };
  }

  function readFork(vol, fork) {
    const out = new Uint8Array(fork.size);
    let pos = 0;
    for (const [start, count] of fork.extents) {
      const off = vol.base + start * vol.bs, len = Math.min(count * vol.bs, fork.size - pos);
      out.set(vol.img.subarray(off, off + len), pos);
      pos += len;
      if (pos >= fork.size) break;
    }
    return out;
  }

  function parseForkData(dv, off) {
    const ext = [];
    for (let i = 0; i < 8; i++) {
      const s = dv.getUint32(off + 16 + i * 8), c = dv.getUint32(off + 20 + i * 8);
      if (c) ext.push([s, c]);
    }
    return { size: Number(dv.getBigUint64(off)), extents: ext };
  }

  // every catalog leaf record: {parent, name, kind: 'folder'|'file', id, data, rsrc, type, creator}
  function records(vol) {
    const cat = readFork(vol, vol.catalog);
    const dv = new DataView(cat.buffer);
    const nodeSize = dv.getUint16(14 + 18);
    let node = dv.getUint32(14 + 10);
    const out = [];
    while (node) {
      const o = node * nodeSize;
      const n = dv.getUint16(o + 10);
      for (let i = 0; i < n; i++) {
        const ro = o + dv.getUint16(o + nodeSize - 2 * (i + 1));
        const keyLen = dv.getUint16(ro);
        const parent = dv.getUint32(ro + 2), nameLen = dv.getUint16(ro + 6);
        let name = '';
        for (let k = 0; k < nameLen; k++) name += String.fromCharCode(dv.getUint16(ro + 8 + k * 2));
        const r = ro + 2 + keyLen;
        const type = dv.getInt16(r);
        if (type === 1) out.push({ parent, name, kind: 'folder', id: dv.getUint32(r + 8) });
        else if (type === 2) out.push({
          parent, name, kind: 'file', id: dv.getUint32(r + 8),
          type: dv.getUint32(r + 48), creator: dv.getUint32(r + 52),
          data: parseForkData(dv, r + 88), rsrc: parseForkData(dv, r + 168)
        });
      }
      node = dv.getUint32(o);
    }
    return out;
  }

  // nested tree {name, kind, children: Map, rec}
  function tree(vol) {
    const recs = records(vol);
    const byId = new Map();
    byId.set(1, { name: '', kind: 'folder', children: new Map() });
    for (const r of recs) if (r.kind === 'folder') byId.set(r.id, { name: r.name, kind: 'folder', children: new Map(), rec: r });
    for (const r of recs) {
      const p = byId.get(r.parent); if (!p) continue;
      p.children.set(r.name, r.kind === 'folder' ? byId.get(r.id) : { name: r.name, kind: 'file', rec: r });
    }
    const top = byId.get(1);
    return top.children.values().next().value || top; // the root folder (CNID 2)
  }

  function find(root, path) {
    let n = root;
    for (const part of path.split(/[\/:\\]/).filter(Boolean)) {
      if (!n.children) return null;
      let hit = n.children.get(part);
      if (!hit) for (const [k, v] of n.children) if (k.toLowerCase() === part.toLowerCase()) hit = v;
      if (!hit) return null;
      n = hit;
    }
    return n;
  }

  // ---------- writing ----------
  // HFS+ catalog order: parent ID, then case-insensitive name. Folding covers ASCII and Latin-1;
  // that is all the names this project creates.
  function fold(c) {
    if (c >= 0x41 && c <= 0x5A) return c + 32;
    if (c >= 0xC0 && c <= 0xDE && c !== 0xD7) return c + 32;
    return c;
  }
  function cmpName(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = fold(a.charCodeAt(i)), y = fold(b.charCodeAt(i));
      if (x !== y) return x - y;
    }
    return a.length - b.length;
  }
  function cmpKey(a, b) { return a.parent !== b.parent ? a.parent - b.parent : cmpName(a.name, b.name); }

  function keyBytes(parent, name) {
    const b = new Uint8Array(8 + name.length * 2), dv = new DataView(b.buffer);
    dv.setUint16(0, 6 + name.length * 2); dv.setUint32(2, parent); dv.setUint16(6, name.length);
    for (let i = 0; i < name.length; i++) dv.setUint16(8 + i * 2, name.charCodeAt(i));
    return b;
  }

  function writeForkData(dv, off, size, startBlock, blocks, clump) {
    dv.setBigUint64(off, BigInt(size));
    dv.setUint32(off + 8, clump || 0);
    dv.setUint32(off + 12, blocks);
    if (blocks) { dv.setUint32(off + 16, startBlock); dv.setUint32(off + 20, blocks); }
  }

  // nodes: list of {kind, height, records: [Uint8Array]} -> packed B-tree file
  // totalNodes: size of the B-tree file in nodes (must match its fork size)
  function packTree(nodeSize, leafRecs, isCatalog, totalNodes) {
    // split records into leaf nodes
    const leaves = [];
    let cur = [], used = 14 + 2;
    for (const r of leafRecs) {
      const need = r.bytes.length + 2;
      if (cur.length && used + need > nodeSize) { leaves.push(cur); cur = []; used = 14 + 2; }
      cur.push(r); used += need;
    }
    if (cur.length) leaves.push(cur);
    // assign node numbers: 0 header, then leaves, then index levels
    let next = 1;
    const levels = [leaves.map(recs => ({ num: next++, recs, kind: -1, height: 1 }))];
    while (levels[levels.length - 1].length > 1) {
      const below = levels[levels.length - 1];
      const height = below[0].height + 1;
      const idx = [];
      let c = [], u = 14 + 2;
      for (const child of below) {
        const k = child.recs[0].key;
        const rec = new Uint8Array(k.length + 4);
        rec.set(k, 0); new DataView(rec.buffer).setUint32(k.length, child.num);
        if (c.length && u + rec.length + 2 > nodeSize) { idx.push(c); c = []; u = 14 + 2; }
        c.push({ key: k, bytes: rec }); u += rec.length + 2;
      }
      if (c.length) idx.push(c);
      levels.push(idx.map(recs => ({ num: next++, recs, kind: 0, height })));
    }
    const usedNodes = next;
    if (usedNodes > totalNodes) throw new Error('B-tree needs ' + usedNodes + ' nodes, only ' + totalNodes + ' reserved');
    const buf = new Uint8Array(totalNodes * nodeSize), dv = new DataView(buf.buffer);
    const writeNode = (n, fl, bl) => {
      const o = n.num * nodeSize;
      dv.setUint32(o, fl); dv.setUint32(o + 4, bl); dv.setInt8(o + 8, n.kind); dv.setUint8(o + 9, n.height);
      dv.setUint16(o + 10, n.recs.length);
      let p = 14;
      n.recs.forEach((r, i) => { buf.set(r.bytes, o + p); dv.setUint16(o + nodeSize - 2 * (i + 1), p); p += r.bytes.length; });
      dv.setUint16(o + nodeSize - 2 * (n.recs.length + 1), p);
    };
    for (const lvl of levels) lvl.forEach((n, i) => writeNode(n, i + 1 < lvl.length ? lvl[i + 1].num : 0, i ? lvl[i - 1].num : 0));
    // header node
    const root = levels.length && levels[0].length ? levels[levels.length - 1][0].num : 0;
    dv.setUint32(0, 0); dv.setUint32(4, 0); dv.setInt8(8, 1); dv.setUint8(9, 0); dv.setUint16(10, 3);
    let h = 14;
    dv.setUint16(h, leaves.length ? levels.length : 0); dv.setUint32(h + 2, root); dv.setUint32(h + 6, leafRecs.length);
    dv.setUint32(h + 10, leaves.length ? levels[0][0].num : 0); dv.setUint32(h + 14, leaves.length ? levels[0][levels[0].length - 1].num : 0);
    dv.setUint16(h + 18, nodeSize); dv.setUint16(h + 20, isCatalog ? 516 : 10);
    dv.setUint32(h + 22, totalNodes); dv.setUint32(h + 26, totalNodes - usedNodes);
    dv.setUint32(h + 32, totalNodes * nodeSize);
    dv.setUint8(h + 37, isCatalog ? 0xCF : 0);
    dv.setUint32(h + 38, isCatalog ? 6 : 2);
    const mapOff = 14 + 106 + 128;
    for (let i = 0; i < usedNodes; i++) buf[mapOff + (i >> 3)] |= 0x80 >> (i & 7);
    dv.setUint16(nodeSize - 2, 14); dv.setUint16(nodeSize - 4, 14 + 106); dv.setUint16(nodeSize - 6, mapOff); dv.setUint16(nodeSize - 8, nodeSize - 8);
    if (totalNodes > (nodeSize - 8 - mapOff) * 8) throw new Error('B-tree too large for a single map node');
    return buf;
  }

  // root: {kind:'folder', children: Map(name -> node)}; file node: {kind:'file', data: Uint8Array, type?, creator?}
  function build(opts) {
    const bs = opts.blockSize || 4096;
    const size = opts.size;
    const totalBlocks = Math.floor(size / bs);
    const t = opts.time !== undefined ? (Math.floor(opts.time / 1000) + HFS_EPOCH) >>> 0 : now();   // ms since 1970
    // assign CNIDs and gather catalog records
    let nextId = 16, files = 0, folders = 0;
    const recs = [];
    const allFiles = [];
    function addFolder(node, parent, name, id) {
      const kids = [...(node.children || new Map()).entries()];
      const rec = new Uint8Array(88), dv = new DataView(rec.buffer);
      dv.setInt16(0, 1); dv.setUint32(4, kids.length); dv.setUint32(8, id);
      for (let k = 0; k < 5; k++) dv.setUint32(12 + k * 4, t);
      dv.setUint16(32 + 10, 0x41ED); // drwxr-xr-x
      recs.push({ parent, name, data: rec });
      const thread = new Uint8Array(10 + name.length * 2), tv = new DataView(thread.buffer);
      tv.setInt16(0, 3); tv.setUint32(4, parent); tv.setUint16(8, name.length);
      for (let i = 0; i < name.length; i++) tv.setUint16(10 + i * 2, name.charCodeAt(i));
      recs.push({ parent: id, name: '', data: thread });
      for (const [kname, kid] of kids) {
        if (kid.kind === 'folder') { const cid = nextId++; folders++; addFolder(kid, id, kname, cid); }
        else { const fid = nextId++; files++; addFile(kid, id, kname, fid); }
      }
    }
    function addFile(node, parent, name, id) {
      const rec = new Uint8Array(248), dv = new DataView(rec.buffer);
      dv.setInt16(0, 2); dv.setUint16(2, 0x0002); dv.setUint32(8, id); // flags: has thread record
      for (let k = 0; k < 5; k++) dv.setUint32(12 + k * 4, t);
      dv.setUint16(32 + 10, 0x81A4); // -rw-r--r--
      dv.setUint32(48, node.type || 0); dv.setUint32(52, node.creator || 0);
      const entry = { parent, name, data: rec, node };
      recs.push(entry);
      allFiles.push(entry);
      const thread = new Uint8Array(10 + name.length * 2), tv = new DataView(thread.buffer);
      tv.setInt16(0, 4); tv.setUint32(4, parent); tv.setUint16(8, name.length);
      for (let i = 0; i < name.length; i++) tv.setUint16(10 + i * 2, name.charCodeAt(i));
      recs.push({ parent: id, name: '', data: thread });
    }
    addFolder(opts.root, 1, opts.volumeName || 'iPod', 2);

    // layout: block 0 = boot + volume header, allocation file, extents file, catalog file, file data
    const allocBlocks = Math.ceil(totalBlocks / 8 / bs);
    const nodeSize = 4096;
    const extentsBlocks = 16 * nodeSize / bs;
    // catalog size is known only after packing; pack once with record placeholders for size
    let blockPtr = 1;
    const allocStart = blockPtr; blockPtr += allocBlocks;
    const extStart = blockPtr; blockPtr += extentsBlocks;
    // estimate catalog node count, reserve generously so the firmware can add files
    const recBytes = recs.reduce((s, r) => s + r.data.length + 8 + r.name.length * 2 + 2, 0);
    const catNodesEst = Math.ceil(recBytes / (nodeSize - 64)) * 2 + 4;
    const spare = Math.max(64, catNodesEst * 2);
    const catNodes = catNodesEst + spare;
    const catBlocks = catNodes * nodeSize / bs;
    const catStart = blockPtr; blockPtr += catBlocks;
    // file data
    for (const f of allFiles) {
      const len = f.node.data ? f.node.data.length : 0;
      const nb = Math.ceil(len / bs);
      f.start = nb ? blockPtr : 0; f.blocks = nb; f.len = len;
      writeForkData(new DataView(f.data.buffer), 88, len, f.start, nb);
      blockPtr += nb;
    }
    if (blockPtr >= totalBlocks - 1) throw new Error('volume too small for these files');

    const leafRecs = recs.map(r => ({ parent: r.parent, name: r.name, rec: r }))
      .sort(cmpKey)
      .map(r => { const key = keyBytes(r.parent, r.name); const bytes = new Uint8Array(key.length + r.rec.data.length); bytes.set(key, 0); bytes.set(r.rec.data, key.length); return { key, bytes }; });
    const catalog = packTree(nodeSize, leafRecs, true, catNodes);
    const extents = packTree(nodeSize, [], false, extentsBlocks * bs / nodeSize);

    // assemble the image
    const img = opts.into || new Uint8Array(totalBlocks * bs);
    img.set(catalog, catStart * bs);
    img.set(extents, extStart * bs);
    for (const f of allFiles) if (f.len) img.set(f.node.data, f.start * bs);
    // allocation bitmap
    const used = blockPtr;
    const bitmap = img.subarray(allocStart * bs, (allocStart + allocBlocks) * bs);
    bitmap.fill(0);
    for (let b = 0; b < used; b++) bitmap[b >> 3] |= 0x80 >> (b & 7);
    const last = totalBlocks - 1; bitmap[last >> 3] |= 0x80 >> (last & 7);
    // volume header (+ alternate copy 1024 bytes before the end)
    const vh = new Uint8Array(512), dv = new DataView(vh.buffer);
    dv.setUint16(0, 0x482B); dv.setUint16(2, 4); dv.setUint32(4, 0x80000100); dv.setUint32(8, 0x31302E30); // '10.0'
    dv.setUint32(16, t); dv.setUint32(20, t); dv.setUint32(28, t);
    dv.setUint32(32, files); dv.setUint32(36, folders); dv.setUint32(40, bs);
    dv.setUint32(44, totalBlocks); dv.setUint32(48, totalBlocks - used - 1); dv.setUint32(52, used);
    dv.setUint32(56, 0x10000); dv.setUint32(60, 0x10000); dv.setUint32(64, nextId); dv.setUint32(68, 1);
    dv.setBigUint64(72, 1n);
    // special files: clump size = their size, as Apple's newfs_hfs does (old firmware divides by it)
    writeForkData(dv, 0x70, allocBlocks * bs, allocStart, allocBlocks, allocBlocks * bs);
    writeForkData(dv, 0xC0, extentsBlocks * bs, extStart, extentsBlocks, extentsBlocks * bs);
    writeForkData(dv, 0x110, catBlocks * bs, catStart, catBlocks, catBlocks * bs);
    img.set(vh, 1024);
    img.set(vh, totalBlocks * bs - 1024);
    return img;
  }

  function folder(entries) { return { kind: 'folder', children: new Map(entries || []) }; }
  function file(data, type, creator) { return { kind: 'file', data, type, creator }; }
  const fourcc = s => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

  return { open, readFork, records, tree, find, build, folder, file, fourcc };
})();

if (typeof module !== 'undefined') module.exports = { HFSPlus };

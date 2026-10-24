// Extracts iPod firmware from what the user supplies:
//   - the original Mac updater download (MacBinary-wrapped .dmg, as Apple distributed it), or a bare .dmg
//     MacBinary -> UDIF (ADC/zlib chunks) -> Apple partition map -> HFS+ -> iPod.pax.gz -> cpio -> Firmware
//   - the Windows updater (InstallShield setup.exe)
//     embedded .msi (compound file) -> cabinet (LZX) -> Updater.exe, which holds the firmware image as-is
//   - a firmware partition image ('{{~~' STOP header, '[hi]' directory), alone or inside any of the above
'use strict';

const Updater = (() => {
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; };

  function isFirmwareImage(b) { return b.length > 0x4400 && ascii(b, 0x100, 4) === ']ih['; }

  function unMacBinary(b) {
    if (b.length < 128 || b[0] !== 0 || b[1] < 1 || b[1] > 63 || b[74] !== 0 || b[82] !== 0) return null;
    const dlen = be32(b, 83);
    if (128 + dlen > b.length) return null;
    return b.subarray(128, 128 + dlen);
  }

  function adc(src, outLen) {
    const out = new Uint8Array(outLen);
    let i = 0, o = 0;
    while (i < src.length && o < outLen) {
      const c = src[i];
      if (c & 0x80) { const n = (c & 0x7F) + 1; out.set(src.subarray(i + 1, i + 1 + n), o); o += n; i += 1 + n; continue; }
      let n, off;
      if (c & 0x40) { if (i + 2 >= src.length) break; n = (c & 0x3F) + 4; off = ((src[i + 1] << 8) | src[i + 2]) + 1; i += 3; }
      else { n = ((c >> 2) & 0xF) + 3; off = (((c & 3) << 8) | src[i + 1]) + 1; i += 2; }
      for (let k = 0; k < n; k++, o++) out[o] = out[o - off];
    }
    return out;
  }

  // classic resource fork: yields {type, id, name, data}
  function* resources(fork) {
    const dataOff = be32(fork, 0), mapOff = be32(fork, 4);
    const m = fork.subarray(mapOff);
    const tl = be16(m, 24), nl = be16(m, 26);
    const ntypes = be16(m, tl) + 1;
    for (let t = 0; t < ntypes; t++) {
      const e = tl + 2 + t * 8;
      const type = ascii(m, e, 4), n = be16(m, e + 4) + 1, ref = be16(m, e + 6);
      for (let i = 0; i < n; i++) {
        const r = tl + ref + i * 12;
        const id = (be16(m, r) << 16) >> 16, nameOff = be16(m, r + 2), off = be32(m, r + 4) & 0xFFFFFF;
        const name = nameOff === 0xFFFF ? '' : ascii(m, nl + nameOff + 1, m[nl + nameOff]);
        const len = be32(fork, dataOff + off);
        yield { type, id, name, data: fork.subarray(dataOff + off + 4, dataOff + off + 4 + len) };
      }
    }
  }

  // decode the base64 <data> blocks of 'blkx' entries in an XML property list (newer UDIF images)
  function plistBlkx(xml) {
    const out = [];
    const re = /<key>Data<\/key>\s*<data>([\s\S]*?)<\/data>/g;
    let m;
    while ((m = re.exec(xml))) {
      const bin = atob(m[1].replace(/\s+/g, ''));
      const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      if (ascii(b, 0, 4) === 'mish') out.push(b);
    }
    return out;
  }

  function expandUDIF(img) {
    let k = -1;
    if (ascii(img, 0, 4) === 'koly') k = 0;
    else if (img.length >= 512 && ascii(img, img.length - 512, 4) === 'koly') k = img.length - 512;
    if (k < 0) return null;
    const dv = new DataView(img.buffer, img.byteOffset + k);
    const dataOff = Number(dv.getBigUint64(24));
    const rsrcOff = Number(dv.getBigUint64(40)), rsrcLen = Number(dv.getBigUint64(48));
    const xmlOff = Number(dv.getBigUint64(216)), xmlLen = Number(dv.getBigUint64(224));
    let tables = [];
    if (xmlLen) tables = plistBlkx(new TextDecoder().decode(img.subarray(xmlOff, xmlOff + xmlLen)));
    else for (const r of resources(img.subarray(rsrcOff, rsrcOff + rsrcLen))) if (r.type === 'blkx') tables.push(r.data);
    let total = 0;
    const chunks = [];
    for (const t of tables) {
      const first = Number(new DataView(t.buffer, t.byteOffset).getBigUint64(8));
      const dataStart = Number(new DataView(t.buffer, t.byteOffset).getBigUint64(24));
      const n = be32(t, 200);
      for (let c = 0; c < n; c++) {
        const e = new DataView(t.buffer, t.byteOffset + 204 + c * 40);
        const type = e.getUint32(0);
        if (type === 0xFFFFFFFF) break;
        if (type === 0x7FFFFFFE) continue;
        const sec = first + Number(e.getBigUint64(8)), cnt = Number(e.getBigUint64(16));
        const off = dataOff + dataStart + Number(e.getBigUint64(24)), len = Number(e.getBigUint64(32));
        chunks.push({ type, sec, cnt, off, len });
        total = Math.max(total, sec + cnt);
      }
    }
    const disk = new Uint8Array(total * 512);
    for (const c of chunks) {
      const src = img.subarray(c.off, c.off + c.len);
      let raw = null;
      if (c.type === 0x80000004) raw = adc(src, c.cnt * 512);
      else if (c.type === 0x80000005) raw = Inflate.zlib(src);
      else if (c.type === 1) raw = src;
      else if (c.type === 0 || c.type === 2) continue;
      else throw new Error('This disk image uses a compression format the emulator cannot read (' + c.type.toString(16) + ').');
      disk.set(raw.subarray(0, c.cnt * 512), c.sec * 512);
    }
    return disk;
  }

  function hfsPartitions(disk) {
    const parts = [];
    if (ascii(disk, 0, 2) === 'ER') {
      const n = be32(disk, 512 + 4);
      for (let i = 1; i <= n; i++) {
        const e = i * 512;
        if (ascii(disk, e, 2) !== 'PM') break;
        if (ascii(disk, e + 48, 9) === 'Apple_HFS') parts.push(be32(disk, e + 8) * 512);
      }
    }
    if (!parts.length && (be16(disk, 1024) === 0x482B || be16(disk, 1024) === 0x4858)) parts.push(0);
    return parts;
  }

  // odc cpio archive: yields {name, data}
  function* cpioFiles(arc) {
    let p = 0;
    while (p + 76 <= arc.length && ascii(arc, p, 6) === '070707') {
      const nameLen = parseInt(ascii(arc, p + 59, 6), 8), size = parseInt(ascii(arc, p + 65, 11), 8);
      const name = ascii(arc, p + 76, nameLen - 1);
      const data = p + 76 + nameLen;
      if (name === 'TRAILER!!!') break;
      yield { name, data: arc.subarray(data, data + size) };
      p = data + size;
    }
  }

  // the OS image's own version: a Mac 'NumVersion' word stored just before the string "buildID"
  // (the firmware directory's version field was not always updated, e.g. 1.4 still says 1.3)
  function numVersion(osos) {
    for (let i = osos.indexOf(0x62); i !== -1; i = osos.indexOf(0x62, i + 1)) {
      if (i < 4 || ascii(osos, i, 8) !== 'buildID\0') continue;
      const major = osos[i - 1], mb = osos[i - 2], stage = osos[i - 3];
      if (major === 0 || major > 0x99 || ![0x20, 0x40, 0x60, 0x80].includes(stage)) continue;
      const v = ((major >> 4) * 10 + (major & 0xF)) + '.' + (mb >> 4) + ((mb & 0xF) ? '.' + (mb & 0xF) : '');
      return stage === 0x80 ? v : v + { 0x20: 'd', 0x40: 'a', 0x60: 'b' }[stage] + osos[i - 4];
    }
    return null;
  }

  // the '[hi]' directory: returns {osos, version} from a firmware partition image
  function splitFirmware(fw) {
    if (!isFirmwareImage(fw)) throw new Error('This is not an iPod firmware image.');
    const dv = new DataView(fw.buffer, fw.byteOffset);
    const dir = dv.getUint32(0x104, true) + 0x200;
    for (let i = 0; i < 10; i++) {
      const e = dir + i * 40;
      const id = ascii(fw, e + 4, 4).split('').reverse().join('');
      if (id === 'osos') {
        const off = dv.getUint32(e + 12, true), len = dv.getUint32(e + 16, true), load = dv.getUint32(e + 20, true);
        const sum = dv.getUint32(e + 28, true), vers = dv.getUint32(e + 32, true);
        if (load !== 0x28000000) throw new Error('This firmware is for a later iPod (iPod mini or 4th generation, built on the PortalPlayer PP5020). This emulator runs 1st and 2nd generation software (versions 1.x).');
        const osos = fw.slice(off, off + len);
        let s = 0; for (let k = 0; k < osos.length; k++) s = (s + osos[k]) >>> 0;
        if (s !== sum) throw new Error('The firmware checksum does not match; the file may be damaged.');
        const version = numVersion(osos) || ((vers >> 8) & 0xF) + '.' + ((vers >> 4) & 0xF) + ((vers & 0xF) ? '.' + (vers & 0xF) : '');
        if (((vers >> 8) & 0xF) >= 2) throw new Error(`This firmware is for the 3rd-generation iPod, which has different hardware. This emulator runs 1st and 2nd generation software (versions 1.x).`);
        return { osos, version };
      }
    }
    throw new Error('No operating system image (osos) was found in this firmware.');
  }

  // a firmware image embedded anywhere in `b`: the STOP header, '[hi]' 0x100 bytes later; cut at its last image
  function findFirmwareImage(b) {
    for (let i = b.indexOf(0x7B); i !== -1 && i + 0x4400 < b.length; i = b.indexOf(0x7B, i + 1)) {
      if (b[i + 1] !== 0x7B || b[i + 2] !== 0x7E || b[i + 3] !== 0x7E || ascii(b, i + 0x100, 4) !== ']ih[') continue;
      const img = b.subarray(i), dv = new DataView(img.buffer, img.byteOffset);
      const dir = dv.getUint32(0x104, true) + 0x200;
      let end = 0;
      for (let k = 0; k < 10 && dir + k * 40 + 40 <= img.length; k++) {
        const e = dir + k * 40;
        if (!dv.getUint32(e, true)) break;
        end = Math.max(end, dv.getUint32(e + 12, true) + dv.getUint32(e + 16, true));
      }
      if (end && end <= img.length) return img.slice(0, end);
    }
    return null;
  }

  function fromWindowsInstaller(b) {
    if (b[0] !== 0x4D || b[1] !== 0x5A || typeof WinArchive === 'undefined') return null;   // 'MZ'
    for (const at of WinArchive.findCompoundFiles(b)) {
      let streams;
      try { streams = WinArchive.cfbStreams(b, at); } catch (e) { continue; }
      for (const s of streams) {
        if (ascii(s.data, 0, 4) !== 'MSCF') continue;
        const files = WinArchive.cabFiles(s.data, 0);
        for (const f of files) {   // the firmware ships inside the updater program itself
          const fw = findFirmwareImage(f.data);
          if (fw) return fw;
        }
      }
    }
    return null;
  }

  // main entry: returns {firmware, osos, version}
  function extract(bytes) {
    let b = bytes;
    if (isFirmwareImage(b)) return Object.assign({ firmware: b }, splitFirmware(b));
    const win = fromWindowsInstaller(b) || (b[0] === 0x4D && b[1] === 0x5A ? findFirmwareImage(b) : null);
    if (win) return Object.assign({ firmware: win }, splitFirmware(win));
    b = unMacBinary(b) || b;
    const disk = expandUDIF(b);
    if (!disk) throw new Error('Unrecognized file. Choose an iPod Software Updater (Mac .dmg/.bin or Windows .exe) or its Firmware file.');
    let refusal = null;   // why a firmware found here cannot run, if none can
    const tryImage = fw => {
      if (!isFirmwareImage(fw)) return null;
      try { return Object.assign({ firmware: fw.slice() }, splitFirmware(fw)); } catch (e) { refusal = refusal || e; return null; }
    };
    for (const off of hfsPartitions(disk)) {
      const vol = HFSPlus.open(disk, off);
      const recs = HFSPlus.records(vol);
      // the firmware lives inside the installer payload, or loose in some updaters
      const loose = recs.find(r => r.kind === 'file' && r.name === 'Firmware');
      if (loose) { const r = tryImage(HFSPlus.readFork(vol, loose.data)); if (r) return r; }
      // later updaters carry one image per iPod model (Resources/Updates/Firmware-<model>.<version>); take the
      // one this hardware runs. Packages also hold a tiny symlink with the .pax.gz name, which is skipped here.
      for (const r of recs) {
        if (r.kind !== 'file' || !/\.pax\.gz$/.test(r.name)) continue;
        const gz = HFSPlus.readFork(vol, r.data);
        if (gz[0] !== 0x1F || gz[1] !== 0x8B) continue;
        for (const f of cpioFiles(Inflate.gunzip(gz))) {
          if (!/\/Resources\/(Updates\/)?Firmware(-[\d.]+)?$/.test(f.name)) continue;
          const ok = tryImage(f.data); if (ok) return ok;
        }
      }
    }
    if (refusal) throw refusal;
    throw new Error('No iPod firmware was found inside this updater.');
  }

  return { extract, splitFirmware, isFirmwareImage, findFirmwareImage };
})();

if (typeof module !== 'undefined') module.exports = { Updater };

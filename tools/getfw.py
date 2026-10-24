"""Extract the firmware the headless tools need from an iPod Software updater, using the page's own extractor:
    python3 tools/getfw.py <updater (.dmg, .dmg.bin, setup.exe or Firmware)> [out dir, default fw]
writes <out>/Firmware and <out>/images/osos.bin (tools/boot.js and friends read these; FW_DIR picks another dir).
Runs the JavaScript in macOS's JavaScriptCore shell (jsc)."""
import binascii, os, pathlib, subprocess, sys, tempfile

JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'
root = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else 'fw')

script = r'''
// jsc has neither TextDecoder nor atob, which the updater reader uses for disk image property lists
globalThis.TextDecoder = class { decode(b) { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; } };
globalThis.atob = s => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; let o = '', bits = 0, n = 0;
  for (const c of s) { if (c === '=') break; const v = A.indexOf(c); if (v < 0) continue; bits = (bits << 6) | v; n += 6; if (n >= 8) { n -= 8; o += String.fromCharCode((bits >> n) & 255); } } return o; };
for (const f of ['hfsplus', 'inflate', 'cab', 'updater']) load(`emu/${f}.js`);
const r = Updater.extract(new Uint8Array(readFile(arguments[0], 'binary')));
const hex = b => { const p = []; for (let i = 0; i < b.length; i += 65536) { let s = ''; for (const x of b.subarray(i, i + 65536)) s += (x < 16 ? '0' : '') + x.toString(16); p.push(s); } return p.join(''); };
print('VERSION ' + r.version); print('FIRMWARE ' + hex(r.firmware)); print('OSOS ' + hex(r.osos));
'''
with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
    f.write(script)
try:
    res = subprocess.run([JSC, f.name, '--', str(src)], cwd=root, capture_output=True, text=True)
finally:
    os.unlink(f.name)
lines = dict(l.split(' ', 1) for l in res.stdout.splitlines() if ' ' in l)
if 'OSOS' not in lines:
    sys.exit((res.stdout + res.stderr).strip() or 'extraction failed')
(out / 'images').mkdir(parents=True, exist_ok=True)
(out / 'Firmware').write_bytes(binascii.unhexlify(lines['FIRMWARE'].strip()))
(out / 'images' / 'osos.bin').write_bytes(binascii.unhexlify(lines['OSOS'].strip()))
print(f"iPod Software {lines['VERSION'].strip()} -> {out}/Firmware, {out}/images/osos.bin")

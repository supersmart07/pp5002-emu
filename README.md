# iPod Classic Emulator (1st generation)

A browser emulator of the 2001 iPod: a PortalPlayer PP5002 with two ARM7TDMI cores, its LCD, click wheel, hard disk
and audio codec. It boots Apple's own iPod Software (1.2, 1.3 and 1.4 tested), so the menus, the clicker and the
MP3 decoder are the real thing; your songs go onto an emulated disk and play through the iPod's own decoder.

**No Apple software is included.** You load your own copy of the iPod Software Updater in the page; it is read in
your browser and stored there. Nothing is uploaded. Not affiliated with Apple.

## Use it

Open the page (on GitHub Pages, or locally as below), then:

1. **iPod Software**: choose an updater for the 1st/2nd-generation iPod. The page accepts the Mac download
   (`.dmg` or MacBinary `.dmg.bin`), the Windows installer (`setup.exe`), or the `Firmware` file from inside either.
2. **Music**: add songs and press Sync. 44.1 kHz MP3s and WAVs go on as they are; other formats are converted in
   the browser to 44.1 kHz, 192 kbps MP3.
3. Drive it with the wheel and buttons, or the keyboard: arrow keys scroll, Enter selects, Esc is Menu, Space is
   Play/Pause, H toggles Hold.

The iPod saves itself as you go and resumes where you left it. One browser tab runs it at a time.
Chrome, Edge and other Chromium browsers run it fastest (they get the block translator); Safari and Firefox work too.

## Run it locally

Any static web server works (the page needs `http://` for its Web Worker). This one disables caching, which helps
while changing the code:

    python3 tools/serve.py 8741

Then open http://localhost:8741.

## Develop

The headless tools run the same emulator in macOS's JavaScriptCore shell (`jsc`). They need the firmware as files;
extract it from your updater (it goes to `fw/`, which `.gitignore` keeps out of the repository):

    python3 tools/getfw.py "iPod Software 1.2 Updater.dmg.bin"

Scenarios in `tools/boot.js` boot the iPod, press buttons and dump screens; `tools/frame.py` and `tools/sheet.py` turn
the dumps into PNGs:

    JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
    $JSC tools/boot.js -- songs > out.log
    python3 tools/frame.py shot.png 2 < out.log && python3 tools/sheet.py sheet.png "shot_*.png"

Checks used during development:

- Audio accuracy: the `rec` scenario records the emulated I²S output while an MP3 plays (`work/test.mp3` by
  default, `MP3_PATH` overrides); compare it with ffmpeg's decode using `tools/audiocmp.py`.
- Save and resume: `$JSC tools/snaptest.js` restores a snapshot into a second iPod and compares audio and screen.
- Speed: `$JSC tools/perfplay.js -- song.mp3 60` reports emulation speed second by second.
- Another firmware: put `var FW_DIR = 'fw/v13';` in a file loaded before the tool.
- Block translator: on in Chromium browsers, off in jsc unless a file loaded first sets `var ARM_JIT = 1;`.

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `web/` | The page: UI, Web Worker, shared run loop, AudioWorklet output |
| `emu/arm7.js` | ARMv4T interpreter (ARM + Thumb) |
| `emu/jit.js` | Block translator: compiles hot ARM code into JavaScript functions, bit-identical to the interpreter |
| `emu/pp5002.js` | Memory map, MMAP remapping, core scheduling, interrupt routing |
| `emu/devices.js` | Peripherals (see below) |
| `emu/hints.js` | Loop hints: idle waits sleep instead of spinning; disk PIO reads are copied in one go |
| `emu/ipod.js` | Puts an iPod together: system, devices, input, save and restore |
| `emu/hfsplus.js`, `emu/itunesdb.js`, `emu/disk.js` | Build the disk: Apple partition map, firmware partition, HFS+ volume, iTunesDB |
| `emu/updater.js`, `emu/inflate.js`, `emu/cab.js` | Read updaters: MacBinary → UDIF → HFS+ → pax → Firmware, and InstallShield → MSI → cabinet (LZX) |
| `tools/` | Headless scenario runner, firmware extraction, screen dumps, audio and speed checks, test server |

## Hardware notes (as observed with firmware 1.2)

| Address | Device | Notes |
| --- | --- | --- |
| `0x28000000` | SDRAM, 32 MB | `osos` is loaded here; MMAP0 maps logical 0 (and the `0x04000000` alias) onto it |
| `0x40000000` | IRAM, 96 KB | FIQ handler and MP3 decoder run from here |
| `0xC0001000` | LCD bridge → HD66753 | `+0x08` index bytes, `+0x10` data bytes; ctl bit 1 = backlight; column words run right to left |
| `0xC0002500` | I²S | `+0x40` FIFO (sample in bits 31–16), interrupt 5 routed to the COP as FIQ |
| `0xC0003000` | IDE | task file at `+0x1E0`; `+0x24` bit 6 = controller ready |
| `0xC0006000` | 2 × 16550 UART | second port polled during playback (remote connector) |
| `0xC0008000` | I²C | WM8731 codec at address `0x34`; register 2 = headphone volume |
| `0xC4000000` | Processor ID | `0x55555555` CPU, `0xAAAAAAAA` COP |
| `0xC8004000` | Mailbox | `+0x00` status, `+0x04` set, `+0x08` clear, `+0x10` COP→CPU (interrupt 18) |
| `0xCF000000` | GPIO A–D | port A: buttons 0–4 (active low), hold bit 5 (high = on), wheel quadrature bits 6–7 |
| `0xCF001000` | Interrupts / timers | `+0x20/24/28/2C` CPU mask/enable/disable/FIQ; timer 1 = IRQ 11, GPIO = 14 |
| `0xCF004000` | System control | `+0x54/58` CPU/COP sleep (`0xCA`) and wake (`0xCE`); `+0x30–3C` chip revision string `PP5002C` |
| `0xF000F000` | MMAP | logical/physical pairs; mask bits 8–13 cover address bits 24–29 |

## Implementation notes

- Working: firmware 1.2, 1.3 and 1.4 boot, menus, wheel/buttons/hold/backlight, MP3/WAV playback matching ffmpeg
  (53 dB SNR), song sync via HFS+ and iTunesDB, Apple-style shell, AudioWorklet output.
- Accepted inputs: Mac updater (.dmg / .dmg.bin), Windows updater (InstallShield setup.exe: embedded .msi ->
  LZX cabinet -> Updater.exe, which holds the firmware image), or a bare Firmware file. Multi-model updaters
  (e.g. iPod Updater 2004-04-28: Resources/Updates/Firmware-<model>.<version>) yield the 1st/2nd generation
  image; 3rd generation (2.x) and PP5020 images (iPod mini, loaded at 0x10000000) are rejected with an
  explanation. The version shown is the OS image's Mac NumVersion word stored just before the string "buildID"
  (0x01408000 = 1.4), because the firmware directory's version field still says 1.3 in 1.4.
- Tested updaters: iPod 1.2 (Mac), 1.3 (Windows setup.exe), 1.3.1 (Mac; same OS image as 1.3),
  iPod Updater 2004-04-28 (Mac; 1.4). 1.4 needs no emulator changes.
- Firmware differences found so far: 1.3 programs MMAP slot 0xF000F008 too, and before starting audio it syncs to
  the I2S word clock on GPIO port D bit 6 (emulated as a 44.1 kHz square wave).
- Save and resume: every 20 s, when the tab is hidden and on page close, the worker snapshots both cores, all
  devices, non-empty RAM pages (gzipped, ~1.5 MB) and the disk sectors the firmware wrote. The disk is rebuilt
  byte for byte from the recorded song order, timestamp and settings files. `tools/snaptest.js` checks that a
  restored iPod produces the same audio and screen as the original (0 differences on 1.2, 1.3 and 1.4).
- Mid-song stalls: songs larger than the iPod's RAM buffer (e.g. WAVs converted from AAC or 48 kHz MP3) make the
  firmware refill ~15 MB from disk mid-song, one 16-bit PIO read at a time. The IDE data register now has a fast
  path and a loop hint copies whole PIO transfers on the host: the refill second went from 1.25x to 4x real time in
  Chrome, with output still bit-exact. `tools/perfplay.js` measures a song second by second.
- Block translator (`emu/jit.js`): ARM code that runs often is compiled into JavaScript functions (up to 32
  instructions, ending at branches, after any I/O access, or when code memory is written). It matches the
  interpreter bit for bit (same frames, audio and snapshots in every `tools/boot.js` scenario) and roughly doubles
  speed in V8: scrolling Settings > Legal during MP3 playback (the firmware redraws a screen of text per wheel
  step while both cores decode) went from ~110% to ~230% of real time in headless Chrome. JavaScriptCore keeps the
  generated functions in its baseline tier, where they are slower than the interpreter, so it is only enabled on
  Chromium-based browsers (`ARM_JIT` overrides; jsc tools interpret unless it is set).
- Doze: after a few idle minutes the firmware puts the COP to sleep, waits for 0xCF004050 bit 14 (COP asleep),
  switches the PLL (0xCF004010 bit 12 follows bit 13), and sleeps the CPU until a button interrupt. Both status
  bits are emulated now; before, an idle iPod hung in that wait and a snapshot saved there restored a frozen iPod.
- One tab at a time: all tabs share one saved iPod (IndexedDB), so the page holds a Web Lock while it runs the
  iPod. Other tabs show a notice; "Use it here" asks the running tab over a BroadcastChannel to save and stop, and
  takes the lock from a tab that does not answer within 4 s. `tools/serve.py` serves the folder without caching,
  for testing page changes.
- Wheel: edges are paced by the 32-bit microsecond clock; an idle wheel now restarts from the current time, since
  a stale deadline more than 2^31 us away (36 min of uptime, or a restored snapshot) blocked all wheel input.
- Next: try the remaining 1st/2nd-generation versions (1.0, 1.1, 1.5).
- 3rd generation (2.x): same PP5002 but a touch wheel and touch buttons, a different LCD and memory layout, so it
  needs its own machine model.

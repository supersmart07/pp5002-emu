# Technical notes

How the emulated hardware behaves and why some parts of the emulator work the way they do. Usage and setup are in
[README.md](README.md).

## Hardware map

As observed with iPod Software 1.2 unless noted.

| Address | Device | Notes |
| --- | --- | --- |
| `0x28000000` | SDRAM, 32 MB | `osos` is loaded here; MMAP0 maps logical 0 (and the `0x04000000` alias) onto it |
| `0x40000000` | IRAM, 96 KB | FIQ handler and the MP3 decoder's synthesis filter run from here |
| `0xC0001000` | LCD bridge → HD66753 | `+0x08` index bytes, `+0x10` data bytes; ctl bit 1 = backlight; column words run right to left |
| `0xC0002500` | I²S | `+0x40` FIFO (sample in bits 31–16), interrupt 5 routed to the COP as FIQ |
| `0xC0003000` | IDE | task file at `+0x1E0`; `+0x24` bit 6 = controller ready |
| `0xC0006000` | 2 × 16550 UART | second port polled during playback (remote connector) |
| `0xC0008000` | I²C | WM8731 codec at address `0x34`; register 2 = headphone volume |
| `0xC4000000` | Processor ID | `0x55555555` CPU, `0xAAAAAAAA` COP |
| `0xC8004000` | Mailbox | `+0x00` status, `+0x04` set, `+0x08` clear, `+0x10` COP→CPU (interrupt 18) |
| `0xCF000000` | GPIO A–D | port A: buttons 0–4 (active low), hold bit 5 (high = on), wheel quadrature bits 6–7; port D bit 6: I²S word clock (1.3) |
| `0xCF001000` | Interrupts / timers | `+0x20/24/28/2C` CPU mask/enable/disable/FIQ; timer 1 = IRQ 11, GPIO = 14 |
| `0xCF004000` | System control | `+0x54/58` CPU/COP sleep (`0xCA`) and wake (`0xCE`); `+0x50` bit 14 = COP asleep; `+0x10` PLL (bit 12 locked follows bit 13); `+0x30–3C` chip revision string `PP5002C` |
| `0xF000F000` | MMAP | logical/physical pairs; mask bits 8–13 cover address bits 24–29 |

## Firmware

- **Updater formats.** Mac updaters are MacBinary → UDIF disk image (ADC or zlib chunks) → HFS+ → `pax.gz` → cpio →
  `Firmware`. The Windows `setup.exe` is InstallShield → embedded `.msi` → cabinet (LZX) → `Updater.exe`, which holds
  the firmware image as is. Multi-model updaters (iPod Updater 2004-04-28: `Resources/Updates/Firmware-<model>.<version>`)
  carry one image per model; the page picks the 1st/2nd-generation one. 3rd-generation (2.x) and PP5020 images
  (iPod mini, loaded at `0x10000000`) are recognized and declined.
- **Version number.** The firmware directory's version field still says 1.3 in 1.4, so the version shown comes from
  the OS image itself: a Mac `NumVersion` word stored just before the string `buildID` (`0x01408000` = 1.4).
- **Differences between versions.** 1.3 also programs MMAP slot `0xF000F008`, and before starting audio it waits on
  the I²S word clock on GPIO port D bit 6 (emulated as a 44.1 kHz square wave). 1.4 needed no emulator changes.
- **Doze.** After a few idle minutes the firmware puts the COP to sleep, waits for `0xCF004050` bit 14, switches the
  PLL (`0xCF004010`), and sleeps the CPU until a button interrupt. Without those two status bits an idle iPod hangs
  in that wait for good.
- **Return to Now Playing.** While music plays, the firmware itself goes back to Now Playing after about 10 seconds
  without input, from menus and text screens alike.

## Emulator

- **Accuracy.** MP3 playback matches ffmpeg's decode of the same file (correlation 1.000, about 53 dB SNR on test
  noise); WAV playback is bit exact.
- **Save and resume.** Every 20 s, when the tab is hidden and when the page closes, the worker snapshots both cores,
  all devices, non-empty RAM pages (gzipped, about 1.5 MB) and the disk sectors the firmware wrote. The disk is
  rebuilt byte for byte from the recorded song order, timestamp and settings files. `tools/snaptest.js` checks that
  a restored iPod produces the same audio and screen as the original.
- **Loop hints** (`emu/hints.js`). Found in the firmware by instruction pattern, so they work across versions: idle
  waits put the core to sleep instead of spinning, and the disk's PIO read loop is replaced by one host copy. Songs
  larger than the iPod's RAM buffer make the firmware refill about 15 MB mid-song, one 16-bit read at a time; with the
  hint that refill runs 4× real time in Chrome instead of 1.25×, with identical output.
- **Block translator** (`emu/jit.js`). ARM code that runs often is compiled into JavaScript functions of up to 32
  instructions, ending at branches, after any I/O access, or when code memory is written. Output is identical to the
  interpreter's (same frames, audio and snapshots in every `tools/boot.js` scenario). In V8 it roughly doubles speed:
  scrolling Settings > Legal during MP3 playback, where the firmware redraws a screen of text per wheel step while
  both cores decode, went from about 110% to 230% of real time. JavaScriptCore keeps the thousands of generated
  functions in its baseline tier, where they run slower than the interpreter, so the translator is only enabled in
  Chromium-based browsers. If a page's security policy forbids generated code, it switches itself off and the speed
  meter says "basic core".
- **One tab at a time.** All tabs share one saved iPod in IndexedDB, so the running tab holds a Web Lock. Other tabs
  show a notice; "Use it here" asks the running tab over a BroadcastChannel to save and stop, and takes the lock
  from a tab that does not answer within 4 seconds.
- **iPhone sound.** iOS mutes web audio with the ring/silent switch unless the page plays like a music app, so the
  page sets `navigator.audioSession.type = 'playback'` (older iOS: a silent looping `<audio>` element). Sound starts
  on a completed tap (`pointerup`/`touchend`), resumes from iOS's `interrupted` state after a lock or call, and runs
  at the device rate (48 kHz) with the output ring resampling. Opening the page with `?debug` shows the sound
  engine's state, seconds played and underruns under the status line.
- **Wheel timing.** Wheel edges are paced by the 32-bit microsecond clock. An idle wheel restarts from the current
  time, because a stale deadline more than 2³¹ µs away (36 minutes of uptime, or a restored snapshot) would
  otherwise block all wheel input.

## Next

- Try the remaining 1st/2nd-generation versions (1.0, 1.1, 1.5).
- 3rd generation (2.x): the same PP5002, but a touch wheel, touch buttons, a different LCD and memory layout, so it
  needs its own machine model.

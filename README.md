# iPod Classic Emulator (1st generation)

A browser-based emulator of the original 2001 iPod. It runs Apple's iPod firmware, including the menus and audio decoder, on an emulated PortalPlayer PP5002 with two ARM7TDMI cores.

This whole thing was vibe coded, inspired by Apple's 404 easter egg.

You'll need your own copy of an iPod Software Updater. No Apple software is included, and this project is not affiliated with Apple. Firmware and music are processed and stored in your browser; nothing is uploaded.

## Getting started

Open the page on GitHub Pages, or run it locally using the instructions below.

1. Under **iPod Software**, load an updater for the 1st- or 2nd-generation iPod. You can use a Mac `.dmg` or `.dmg.bin`, a Windows `setup.exe`, or an extracted `Firmware` file.
2. Add music and press **Sync**. MP3s at 44.1 kHz and WAV files are copied directly. Other formats are converted in the browser to 44.1 kHz, 192 kbps MP3.
3. Use the wheel and buttons, or the keyboard:

   | Key | Action |
   | --- | --- |
   | Arrow keys | Scroll |
   | Enter | Select |
   | Esc | Menu |
   | Space | Play/Pause |
   | H | Toggle Hold |

Progress is saved automatically, so you can close the page and resume later. Only one tab can run the emulator at a time.

Chrome and Edge are the fastest options. Safari and Firefox also work, but use the slower interpreter.

## Compatibility

Firmware 1.2, 1.3 and 1.4 have been tested. Working features include music playback, song sync, the wheel and buttons, Hold, the backlight, and save/resume.

Tested updaters:

- iPod 1.2 for Mac
- iPod 1.3 for Windows
- iPod 1.3.1 for Mac (contains the same OS image as 1.3)
- iPod Updater 2004-04-28 for Mac (contains firmware 1.4)

Multi-model updaters are supported; the emulator extracts the 1st/2nd-generation firmware. Third-generation and iPod mini firmware are not supported. Versions 1.0, 1.1 and 1.5 have not yet been tested.

## Running locally

From the project directory:

```sh
python3 tools/serve.py 8741
```

Open <http://localhost:8741>. The server disables caching to make local changes easier to test.

You can also use another static web server. Serve the page over HTTP rather than opening `index.html` directly, since it uses a Web Worker.

## Development

The headless tools use the same emulator through macOS's JavaScriptCore shell (`jsc`). First, extract the firmware from your updater:

```sh
python3 tools/getfw.py "iPod Software 1.2 Updater.dmg.bin"
```

Extracted files go into `fw/`, which is excluded from the repository.

To run a scenario and render its screen dumps:

```sh
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC tools/boot.js -- songs > out.log
python3 tools/frame.py shot.png 2 < out.log
python3 tools/sheet.py sheet.png "shot_*.png"
```

Useful checks:

- **Audio:** the `rec` scenario records the emulated I²S output. It uses `work/test.mp3` by default; set `MP3_PATH` to use another file. `tools/audiocmp.py` compares the recording with an ffmpeg decode.
- **Save/resume:** `$JSC tools/snaptest.js` restores a snapshot into a second emulator and compares the audio and screen output.
- **Performance:** `$JSC tools/perfplay.js -- song.mp3 60` reports emulation speed second by second.

To select another firmware directory, load a file containing `var FW_DIR = 'fw/v13';` before the tool. The block translator is enabled by default in Chromium browsers and disabled in `jsc`; `var ARM_JIT = 1;` overrides that setting.

## Source layout

| Path | Contents |
| --- | --- |
| `index.html`, `web/` | Browser UI, worker, run loop and audio output |
| `emu/arm7.js`, `emu/jit.js` | ARM/Thumb interpreter and ARM block translator |
| `emu/pp5002.js`, `emu/devices.js` | Memory map, core scheduling, interrupts and peripherals |
| `emu/ipod.js`, `emu/hints.js` | System setup, input, snapshots and loop optimizations |
| `emu/hfsplus.js`, `emu/itunesdb.js`, `emu/disk.js` | Disk image, filesystem and music database |
| `emu/updater.js`, `emu/inflate.js`, `emu/cab.js` | Updater parsing and firmware extraction |
| `tools/` | Headless scenarios, firmware extraction, screen rendering and checks |

Hardware details and implementation notes are in [NOTES.md](NOTES.md).

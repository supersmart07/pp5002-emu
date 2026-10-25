// Front end for the 1st-generation iPod emulator: storage, song import, disk sync, input, screen and audio.
'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const canvas = $('#lcd'), ctx2d = canvas.getContext('2d');
  const statusEl = $('#status');
  const status = msg => { statusEl.textContent = msg; };

  // ---------- storage (IndexedDB; falls back to memory when blocked) ----------
  const mem = { kv: new Map(), songs: new Map() };
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise(res => {
      try {
        const r = indexedDB.open('ipod-emulator', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('songs', { keyPath: 'id' }); };
        r.onsuccess = () => res(r.result);
        r.onerror = r.onblocked = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    if (!d) return fn(null);
    return new Promise((res, rej) => {
      try {
        const t = d.transaction(store, mode); const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req && req.result); t.onerror = t.onabort = () => rej(t.error);
      } catch (e) { rej(e); }
    });
  }
  const kvGet = k => tx('kv', 'readonly', s => s ? s.get(k) : { result: mem.kv.get(k) }).catch(() => mem.kv.get(k));
  const kvSet = (k, v) => tx('kv', 'readwrite', s => s ? s.put(v, k) : mem.kv.set(k, v)).catch(() => mem.kv.set(k, v));
  const songsAll = () => tx('songs', 'readonly', s => s ? s.getAll() : { result: [...mem.songs.values()] }).catch(() => [...mem.songs.values()]);
  const songPut = v => tx('songs', 'readwrite', s => s ? s.put(v) : mem.songs.set(v.id, v)).catch(() => mem.songs.set(v.id, v));
  const songDel = id => tx('songs', 'readwrite', s => s ? s.delete(id) : mem.songs.delete(id)).catch(() => mem.songs.delete(id));

  let firmware = null;        // {firmware, osos, version, source}
  let songs = [];             // stored songs
  let deviceFiles = new Map();
  let dirty = false;          // songs changed since the iPod was last synced

  // ---------- screen ----------
  // The firmware's 2-bit gray levels become ink of increasing opacity over the LCD's own (CSS) backlight.
  // Each LCD pixel is drawn as a 3x3 block so the browser's smooth downscale keeps every pixel the same size.
  const S = 3, img = ctx2d.createImageData(160 * S, 128 * S);
  const INK = { off: [0x1F, 0x22, 0x1E], on: [0x16, 0x1E, 0x2C] };
  const ALPHA = [0, 92, 172, 255];
  let lastPx = new Uint8Array(160 * 128), litByIpod = false;
  let alwaysLit = true;
  try { alwaysLit = localStorage.getItem('ipod-emu.light') !== 'off'; } catch (e) {}
  $('#light').checked = alwaysLit;
  function draw(px, backlight) {
    if (px) lastPx = px;
    if (backlight !== undefined) litByIpod = backlight;
    const lit = alwaysLit || litByIpod;
    const ink = lit ? INK.on : INK.off, d = img.data, W = 160 * S;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 160; x++) {
      const a = ALPHA[lastPx[y * 160 + x]];
      for (let dy = 0; dy < S; dy++) {
        let o = ((y * S + dy) * W + x * S) * 4;
        for (let dx = 0; dx < S; dx++, o += 4) { d[o] = ink[0]; d[o + 1] = ink[1]; d[o + 2] = ink[2]; d[o + 3] = a; }
      }
    }
    ctx2d.putImageData(img, 0, 0);
    $('.screen').classList.toggle('lit', lit);
  }
  $('#light').addEventListener('change', e => {
    alwaysLit = e.target.checked;
    try { localStorage.setItem('ipod-emu.light', alwaysLit ? 'on' : 'off'); } catch (err) {}
    draw();
  });
  draw(lastPx, false);

  // ---------- audio: AudioWorklet fed directly by the emulator thread, ScriptProcessor as a fallback ----------
  const audio = { ctx: null, node: null, ring: null, kind: '', muted: false, received: 0 };
  // Safari (and every iOS browser, all WebKit): it runs audio at the device rate (48 kHz on iPhones) and has had
  // bugs with other rates, so it gets the device rate and the ring resamples; other browsers get 44.1 kHz directly
  const ua = navigator.userAgent || '';
  const webkitOnly = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\//.test(ua);
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let silentKeeper = null;
  function startAudio() {
    // iOS pauses audio as 'interrupted' (phone locked, call, another app), not only 'suspended'
    if (audio.ctx) { if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {}); keepPlaybackSession(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    keepPlaybackSession();
    try { audio.ctx = webkitOnly ? new AC() : new AC({ sampleRate: 44100 }); }
    catch (e) { try { audio.ctx = new AC(); } catch (e2) { return; } }
    (async () => {
      try {
        if (!audio.ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('no worklet');
        await audio.ctx.audioWorklet.addModule('web/audio-out.js');
        audio.node = new AudioWorkletNode(audio.ctx, 'ipod-out', { numberOfInputs: 0, outputChannelCount: [2] });
        audio.kind = 'worklet';
      } catch (e) {
        if (typeof AudioRing === 'undefined') await loadScript('web/audio-out.js');
        audio.ring = new AudioRing(audio.ctx.sampleRate);
        const sp = audio.ctx.createScriptProcessor(2048, 0, 2);
        sp.onaudioprocess = ev => audio.ring.render(ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1));
        audio.node = sp; audio.kind = 'script';
      }
      audio.node.connect(audio.ctx.destination);
      setMute(audio.muted);
      connectAudioPort();
    })().catch(() => {});
  }
  // iPhones mute web audio with the ring/silent switch unless the page plays like a music app. Newer Safari has an
  // API for that; older iOS switches to the playback session only while an <audio> element plays, so a silent
  // looping one is kept running there.
  function keepPlaybackSession() {
    try { if (navigator.audioSession) { navigator.audioSession.type = 'playback'; return; } } catch (e) {}
    if (!iOS || silentKeeper) return;
    const n = 4410, b = new Uint8Array(44 + n * 2), dv = new DataView(b.buffer);   // 0.1 s of silence, 16-bit mono WAV
    [...'RIFF'].forEach((c, i) => b[i] = c.charCodeAt(0)); dv.setUint32(4, 36 + n * 2, true);
    [...'WAVEfmt '].forEach((c, i) => b[8 + i] = c.charCodeAt(0)); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, 44100, true); dv.setUint32(28, 88200, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    [...'data'].forEach((c, i) => b[36 + i] = c.charCodeAt(0)); dv.setUint32(40, n * 2, true);
    silentKeeper = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
    silentKeeper.loop = true; silentKeeper.setAttribute('playsinline', '');
    silentKeeper.play().catch(() => { silentKeeper = null; });   // retried on the next tap if refused
  }
  // give the worklet a direct line from the emulator worker so audio never waits on the page
  function connectAudioPort() {
    if (audio.kind !== 'worklet' || !engine || !engine.isWorker) return;
    const ch = new MessageChannel();
    audio.node.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    engine.post({ type: 'audioPort', port: ch.port2 }, [ch.port2]);
  }
  function pushAudio(pcm, gain) {
    audio.received += pcm.length;
    if (audio.kind === 'worklet') audio.node.port.postMessage({ type: 'audio', pcm, gain }, [pcm.buffer]);
    else if (audio.ring) audio.ring.push(pcm, gain);
  }
  function setMute(on) {
    audio.muted = on;
    if (audio.kind === 'worklet') audio.node.port.postMessage({ type: 'mute', on });
    else if (audio.ring) audio.ring.muted = on;
  }
  window.ipodDebug = { audio };
  // browsers allow sound only after an interaction, so the first click or key press anywhere turns it on
  const unlockAudio = () => { startAudio(); if (/(Click|Tap) anywhere to hear it\.$/.test(statusEl.textContent)) status(statusEl.textContent.replace(/ (Click|Tap) anywhere to hear it\./, '')); };
  // a tap only grants permission to start sound once it ends (pointerup / touchend; iOS is strict about this), so
  // those are listened to as well as pointerdown
  for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, true);

  // ---------- emulator engine: a Web Worker, or the page itself if workers are unavailable ----------
  let engine = null, harvestWait = null, debugWait = null, elsewhere = false;
  // set when the block translator could not run here (the page forbids generated code); the speed meter says so,
  // since the iPod then runs about half as fast
  let jitFailed = null;
  const forcePage = /[?&]engine=page/.test(location.search);   // test switch for the fallback path
  const ENGINE_SCRIPTS = ['emu/arm7.js', 'emu/jit.js', 'emu/pp5002.js', 'emu/devices.js', 'emu/hints.js', 'emu/ipod.js', 'web/runner.js'];
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  }
  function onEngineMessage(m) {
    if (m.type === 'frame') { draw(m.px, m.backlight); $('#booting').hidden = true; }
    else if (m.type === 'audio') pushAudio(m.pcm, m.gain);
    else if (m.type === 'stats') { jitFailed = m.jitFailed || null; showSpeed(m.speed); playing = !!m.playing; window.ipodDebug.blocks = m.blocks; window.ipodDebug.jitFailed = jitFailed; }
    else if (m.type === 'harvest' && harvestWait) { harvestWait(m.files); harvestWait = null; }
    else if (m.type === 'debug' && debugWait) { debugWait(m); debugWait = null; }
    else if (m.type === 'snapshot' && snapWait) { snapWait(m.state); snapWait = null; }
    else if (m.type === 'ready') {
      running = true;
      if (m.restored) {
        const silent = m.playing && !(audio.ctx && audio.ctx.state === 'running');
        status(`Picked up where you left off (iPod Software ${firmware.version}).` + (silent ? (iOS ? ' Tap anywhere to hear it.' : ' Click anywhere to hear it.') : ''));
      }
    }
    else if (m.type === 'restoreFailed') { kvSet('snapshot', null); boot(null); }
    else if (m.type === 'error') status('Emulator error: ' + m.message);
  }
  function tryWorker() {
    return new Promise(res => {
      let w;
      try { w = new Worker('web/worker.js?v=' + Date.now()); } catch (e) { res(null); return; }
      const fail = () => { clearTimeout(timer); w.terminate(); res(null); };
      const timer = setTimeout(fail, 4000);
      w.onerror = fail;
      w.onmessage = e => {
        if (e.data.type !== 'pong') return;
        clearTimeout(timer);
        w.onerror = ev => status('The emulator stopped: ' + (ev.message || 'unknown error'));
        w.onmessage = ev => onEngineMessage(ev.data);
        res({ isWorker: true, post: (m, t) => w.postMessage(m, t || []), stop: () => w.terminate() });
      };
      w.postMessage({ type: 'ping' });
    });
  }
  async function mainThreadEngine() {
    for (const src of ENGINE_SCRIPTS) if (!document.querySelector(`script[src="${src}"]`)) await loadScript(src);
    let alive = true;
    const runner = createRunner(m => { if (alive) onEngineMessage(m); }, fn => setTimeout(() => { if (alive) fn(); }, 4), 12);
    return { post: m => runner.handle(m), stop: () => { alive = false; runner.handle({ type: 'stop' }); } };
  }
  function stopEngine() { if (engine) { engine.stop(); engine = null; } }
  // Disks are built in a fixed song order with a recorded timestamp and settings files, so a snapshot's disk
  // can be rebuilt byte for byte; the snapshot then only carries the sectors the iPod itself wrote.
  const ordered = list => [...list].sort((x, y) => (x.addedAt - y.addedAt) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  let bootSeq = 0, bootInfo = null, running = false;
  async function boot(snap) {
    const seq = ++bootSeq;
    stopEngine();
    running = false; bootInfo = null;
    if (!firmware) return;
    status(snap ? 'Resuming…' : 'Building the iPod disk…');
    const byId = new Map(songs.map(s => [s.id, s]));
    const list = snap ? snap.songIds.map(id => byId.get(id)) : ordered(songs);
    const info = { version: firmware.version, songIds: list.map(s => s.id),
      buildTime: snap ? snap.buildTime : Date.now(), extra: snap ? snap.extra : [...deviceFiles] };
    const built = IPodDisk.build(firmware.firmware, list.map(s => ({ ...s, data: new Uint8Array(s.data) })), { name: 'iPod', extra: new Map(info.extra), time: info.buildTime });
    let eng = forcePage ? null : await tryWorker();
    if (!eng) {
      try { eng = await mainThreadEngine(); }
      catch (e) { status('The emulator could not start: ' + e.message); return; }
    }
    if (seq !== bootSeq) { eng.stop(); return; }
    engine = eng;
    draw(new Uint8Array(160 * 128), false); $('#booting').hidden = false;
    const osos = firmware.osos.slice().buffer;
    engine.post({ type: 'start', osos, disk: built.disk.buffer, hfsOffset: built.hfsOffset, hold: holdOn, restore: snap ? snap.state : null }, [osos, built.disk.buffer]);
    connectAudioPort();
    bootInfo = info;
    // songs added or removed since the snapshot's sync still need a Sync
    dirty = !!snap && (songs.length !== list.length);
    renderSongs();
    status(`iPod Software ${firmware.version} is running with ${songs.length} song${songs.length === 1 ? '' : 's'}.`);
  }
  function harvest() {
    if (!engine) return Promise.resolve(null);
    return new Promise(res => {
      harvestWait = res; engine.post({ type: 'harvest' });
      setTimeout(() => { if (harvestWait === res) { harvestWait = null; res(null); } }, 3000);
    });
  }
  async function saveDevice() {
    const files = await harvest();
    if (files && files.length) { deviceFiles = new Map(files); await kvSet('device', files); }
  }
  setInterval(() => { if (engine && !document.hidden) saveDevice(); }, 30000);

  // ---------- save and resume ----------
  // Snapshots: every 20 s while idle, at most once a minute while a song plays (its RAM is ~30 MB of audio),
  // and whenever the tab is hidden or the page closes.
  let snapWait = null, snapping = false, playing = false, lastSnap = 0;
  function requestSnapshot() {
    if (!engine) return Promise.resolve(null);
    return new Promise(res => {
      snapWait = res; engine.post({ type: 'snapshot' });
      setTimeout(() => { if (snapWait === res) { snapWait = null; res(null); } }, 5000);
    });
  }
  async function saveSnapshot() {
    if (!engine || !running || !bootInfo || snapping) return;
    snapping = true;
    try {
      const info = bootInfo, state = await requestSnapshot();
      if (state && info === bootInfo) { await kvSet('snapshot', { ...info, state, savedAt: Date.now() }); lastSnap = Date.now(); }
    } finally { snapping = false; }
  }
  async function forgetSnapshot() { await kvSet('snapshot', null); }
  setInterval(() => { if (!document.hidden && (!playing || Date.now() - lastSnap > 60000)) saveSnapshot(); }, 20000);
  window.ipodDebug.saveSnapshot = saveSnapshot;
  window.ipodDebug.query = () => new Promise(res => { debugWait = res; if (engine) engine.post({ type: 'debug' }); });
  window.ipodDebug.flags = () => ({ engine: !!engine, running, bootInfo: !!bootInfo, snapping });
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveSnapshot(); });
  function showSpeed(speed) {
    const pct = Math.round(speed * 100);
    window.ipodDebug.speed = speed;   // uncapped, for testing
    $('#speed').textContent = engine ? `${Math.min(pct, 100)}% speed${jitFailed ? ' · basic core' : ''}` : '';
    $('#speed').title = jitFailed ? 'The faster emulator core is unavailable here: ' + jitFailed : '';
    $('#speed').classList.toggle('slow', pct < 90);
  }

  // ---------- input ----------
  const send = m => { if (engine) engine.post(Object.assign({ type: 'input' }, m)); };
  // Menu + Play held together for 5 seconds (real time) resets the iPod, as on the hardware
  const held = new Set(); let resetTimer = null;
  const press = (button, down) => {
    if (elsewhere) return;
    startAudio(); send({ op: 'press', button, down });
    if (down) held.add(button); else held.delete(button);
    const combo = held.has('menu') && held.has('play') && !holdOn;
    if (combo && !resetTimer) resetTimer = setTimeout(() => { resetTimer = null; if (held.has('menu') && held.has('play')) { held.clear(); resetIpod(); } }, 5000);
    if (!combo && resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  };
  const turn = steps => { startAudio(); send({ op: 'turn', steps }); };
  let holdOn = false;
  function setHold(on) {
    holdOn = on; $('#hold').setAttribute('aria-pressed', String(on));
    send({ op: 'hold', on });
  }
  $('#hold').addEventListener('click', () => setHold(!holdOn));

  document.querySelectorAll('[data-btn]').forEach(b => {
    const name = b.dataset.btn;
    b.addEventListener('pointerdown', e => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (err) {} b.classList.add('down'); press(name, true); });
    const up = () => { if (b.classList.contains('down')) { b.classList.remove('down'); press(name, false); } };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); press(name, true); } });
    b.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); press(name, false); } });
  });

  // iOS starts its text-selection gesture from a held touch even where nothing is selectable, so the click wheel takes
  // its touches itself (its buttons and wheel use pointer events, and sound unlocks on touchend, which still fires);
  // the rest of the iPod still scrolls the page
  $('.ring').addEventListener('touchstart', e => e.preventDefault(), { passive: false });

  // scroll wheel: one quadrature edge per 4 degrees of rotation
  const wheel = $('#wheel');
  let drag = null;
  wheel.addEventListener('pointerdown', e => {
    if (e.target.closest('[data-btn]')) return;
    const r = wheel.getBoundingClientRect();
    drag = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, acc: 0 };
    drag.last = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180 / Math.PI;
    try { wheel.setPointerCapture(e.pointerId); } catch (err) {}
    startAudio();
  });
  wheel.addEventListener('pointermove', e => {
    if (!drag) return;
    const a = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180 / Math.PI;
    let d = a - drag.last; if (d > 180) d -= 360; if (d < -180) d += 360;
    drag.last = a; drag.acc += d;
    const n = Math.trunc(drag.acc / 4);
    if (n) { drag.acc -= n * 4; turn(n); }
  });
  const endDrag = () => { drag = null; };
  wheel.addEventListener('pointerup', endDrag); wheel.addEventListener('pointercancel', endDrag);
  let wacc = 0;
  $('.face').addEventListener('wheel', e => {
    e.preventDefault(); wacc += e.deltaY;
    const n = Math.trunc(wacc / 12);
    if (n) { wacc -= n * 12; turn(n); }
  }, { passive: false });

  const keyMap = { Enter: 'select', Escape: 'menu', Backspace: 'menu', ' ': 'play', ArrowLeft: 'prev', ArrowRight: 'next' };
  const keysDown = new Set();
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || elsewhere) return;
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || ((t === 'BUTTON' || t === 'A') && (e.key === 'Enter' || e.key === ' '))) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); turn(e.key === 'ArrowDown' ? 6 : -6); return; }
    if (e.key === 'h' || e.key === 'H') { setHold(!holdOn); return; }
    const b = keyMap[e.key]; if (!b) return;
    e.preventDefault();
    if (!keysDown.has(e.key)) { keysDown.add(e.key); press(b, true); }
  });
  document.addEventListener('keyup', e => {
    const b = keyMap[e.key];
    if (b && keysDown.has(e.key)) { keysDown.delete(e.key); press(b, false); }
  });

  // ---------- firmware ----------
  async function loadUpdater(file) {
    status(`Reading ${file.name}…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = Updater.extract(bytes);
      // settings files written by one software version are not handed to another
      if (firmware && firmware.version !== r.version) { deviceFiles = new Map(); await kvSet('device', []); }
      firmware = { firmware: r.firmware, osos: r.osos, version: r.version, source: file.name };
      await kvSet('firmware', firmware);
      await forgetSnapshot();
      renderFirmware();
      boot(null);
    } catch (err) {
      status(String(err.message || err));
    }
  }
  function renderFirmware() {
    const has = !!firmware;
    $('#fw-empty').hidden = has; $('#fw-loaded').hidden = !has;
    $('#nofw').hidden = has;
    if (has) $('#fw-name').textContent = `iPod Software ${firmware.version}`, $('#fw-src').textContent = `from ${firmware.source}`;
    $('#music').classList.toggle('disabled', !has);
  }

  // ---------- songs ----------
  const latin1 = new TextDecoder('latin1');
  function id3(b) {
    const out = {};
    const txt = d => {
      const enc = d[0]; let s = d.subarray(1);
      try {
        if (enc === 1) s = new TextDecoder(s[0] === 0xFE ? 'utf-16be' : 'utf-16le').decode(s[0] === 0xFE || s[0] === 0xFF ? s.subarray(2) : s);
        else if (enc === 2) s = new TextDecoder('utf-16be').decode(s);
        else if (enc === 3) s = new TextDecoder('utf-8').decode(s);
        else s = latin1.decode(s);
      } catch (e) { return ''; }
      return s.split('\0')[0].trim();
    };
    let tagEnd = 0;
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
      const ver = b[3], size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
      tagEnd = 10 + size + ((b[5] & 0x10) ? 10 : 0);
      let p = 10;
      const keys = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TRCK: 'track', TRK: 'track', TCON: 'genre', TCO: 'genre' };
      const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
      while (p + hdr < 10 + size) {
        const id = String.fromCharCode(...b.subarray(p, p + idLen));
        if (!/^[A-Z0-9]+$/.test(id)) break;
        const sz = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? (b[p + 4] << 21) | (b[p + 5] << 14) | (b[p + 6] << 7) | b[p + 7] : ((b[p + 4] << 24) >>> 0) + (b[p + 5] << 16) + (b[p + 6] << 8) + b[p + 7];
        const k = keys[id];
        if (k && sz > 1) { const v = txt(b.subarray(p + hdr, p + hdr + sz)); if (v) out[k] = k === 'track' ? parseInt(v, 10) || 0 : v.replace(/^\((\d+)\)$/, ''); }
        p += hdr + sz;
      }
    }
    return { tags: out, audioStart: tagEnd };
  }
  function mp4Tags(b) {
    const out = {}, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const kids = (s, e, cb) => { let p = s; while (p + 8 <= e) { const sz = dv.getUint32(p); if (sz < 8 || p + sz > e) break; cb(String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), p, p + sz); p += sz; } };
    const keys = { '\xa9nam': 'title', '\xa9ART': 'artist', aART: 'albumArtist', '\xa9alb': 'album', trkn: 'track', '\xa9gen': 'genre' };
    kids(0, b.length, (t, s, e) => { if (t !== 'moov') return;
      kids(s + 8, e, (t1, s1, e1) => { if (t1 !== 'udta') return;
        kids(s1 + 8, e1, (t2, s2, e2) => { if (t2 !== 'meta') return;
          kids(s2 + 12, e2, (t3, s3, e3) => { if (t3 !== 'ilst') return;
            kids(s3 + 8, e3, (t4, s4, e4) => { const k = keys[t4]; if (!k) return;
              kids(s4 + 8, e4, (t5, s5, e5) => { if (t5 !== 'data') return;
                const v = b.subarray(s5 + 16, e5);
                if (k === 'track') out.track = v.length >= 4 ? (v[2] << 8) | v[3] : 0;
                else out[k] = new TextDecoder().decode(v).trim();
              }); }); }); }); }); });
    if (!out.artist && out.albumArtist) out.artist = out.albumArtist;
    return out;
  }
  function nameGuess(name) {
    let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim(), track = 0, artist = '';
    const m = base.match(/^(\d{1,3})[\s.\-]+(.+)$/); if (m) { track = +m[1]; base = m[2]; }
    const parts = base.split(' - ');
    if (parts.length >= 2) { artist = parts[0].trim(); base = parts.slice(1).join(' - ').trim(); }
    return { title: base || name, artist, track };
  }
  function mp3Rate(b, start) {
    for (let p = start; p < Math.min(b.length - 4, start + 65536); p++) {
      if (b[p] === 0xFF && (b[p + 1] & 0xE0) === 0xE0) {
        const ver = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, sr = (b[p + 2] >> 2) & 3;
        if (layer !== 1 || sr === 3 || ver === 1) continue;
        return { mpeg1: ver === 3, rate: [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]][ver][sr] };
      }
    }
    return null;
  }
  function wavInfo(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 44 || dv.getUint32(0) !== 0x52494646 || dv.getUint32(8) !== 0x57415645) return null;
    let p = 12, fmt = null, data = 0;
    while (p + 8 <= b.length) {
      const id = dv.getUint32(p), sz = dv.getUint32(p + 4, true);
      if (id === 0x666D7420) fmt = { pcm: dv.getUint16(p + 8, true), ch: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
      if (id === 0x64617461) { data = sz; break; }
      p += 8 + sz + (sz & 1);
    }
    return fmt && Object.assign(fmt, { data });
  }
  function encodeWav(L, R) {
    const n = L.length, b = new Uint8Array(44 + n * 4), dv = new DataView(b.buffer);
    const w = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 44100, true);
    dv.setUint32(28, 44100 * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    return b;
  }
  let decodeCtx = null;
  async function decodeAudio(bytes) {
    decodeCtx = decodeCtx || new (window.AudioContext || window.webkitAudioContext)();
    return await decodeCtx.decodeAudioData(bytes.slice().buffer);
  }
  async function to44k(buffer) {
    let b = buffer;
    if (b.sampleRate !== 44100 || b.numberOfChannels !== 2) {
      const off = new OfflineAudioContext(2, Math.ceil(b.duration * 44100), 44100);
      const src = off.createBufferSource(); src.buffer = b; src.connect(off.destination); src.start();
      b = await off.startRendering();
    }
    return b;
  }
  async function toWav(buffer) {
    const b = await to44k(buffer);
    return encodeWav(b.getChannelData(0), b.getChannelData(b.numberOfChannels > 1 ? 1 : 0));
  }
  // Songs the iPod cannot play as they are become 44.1 kHz, 192 kbps MP3 (lamejs from cdnjs, loaded on demand):
  // about 1/7 the size of WAV, so a song fits in the iPod's 32 MB buffer and plays without mid-song disk refills.
  const MP3_KBPS = 192;
  let lamePromise = null;
  function loadLame() {
    if (!lamePromise) lamePromise = loadScript('https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js')
      .then(() => (typeof lamejs.Mp3Encoder === 'function' ? lamejs : new lamejs()))
      .catch(e => { lamePromise = null; throw e; });
    return lamePromise;
  }
  async function toMp3(buffer, progress) {
    const lame = await loadLame();
    const b = await to44k(buffer);
    const fl = b.getChannelData(0), fr = b.getChannelData(b.numberOfChannels > 1 ? 1 : 0), n = fl.length;
    const i16 = f => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i]; o[i] = v < 0 ? v * 32768 : v * 32767; } return o; };
    const L = i16(fl), R = i16(fr);
    const enc = new lame.Mp3Encoder(2, 44100, MP3_KBPS), parts = [];
    const STEP = 1152, CHUNK = STEP * 200;   // ~5 s of audio between yields to the page
    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(n, start + CHUNK);
      for (let i = start; i < end; i += STEP) { const out = enc.encodeBuffer(L.subarray(i, Math.min(i + STEP, end)), R.subarray(i, Math.min(i + STEP, end))); if (out.length) parts.push(out); }
      if (progress) progress(end / n);
      await new Promise(r => setTimeout(r, 0));
    }
    const tail = enc.flush(); if (tail.length) parts.push(tail);
    const len = parts.reduce((s, p) => s + p.length, 0), mp3 = new Uint8Array(len);
    let o = 0; for (const p of parts) { mp3.set(p, o); o += p.length; }
    return mp3;
  }
  // convert to MP3, falling back to WAV when the encoder cannot be loaded
  async function convert(buffer, progress) {
    try { return { kind: 'mp3', data: await toMp3(buffer, progress) }; }
    catch (e) { return { kind: 'wav', data: await toWav(buffer) }; }
  }

  async function importSong(file, progress) {
    const raw = new Uint8Array(await file.arrayBuffer());
    const guess = nameGuess(file.name);
    let tags = {}, kind, data, ms;
    const isMp3 = /\.mp3$/i.test(file.name) || file.type === 'audio/mpeg';
    if (isMp3) {
      const t = id3(raw); tags = t.tags;
      const fr = mp3Rate(raw, t.audioStart);
      const buffer = await decodeAudio(raw);
      ms = buffer.duration * 1000;
      if (fr && fr.mpeg1 && fr.rate === 44100) { kind = 'mp3'; data = raw.slice(t.audioStart); }
      else ({ kind, data } = await convert(buffer, progress));
    } else {
      if (/\.(m4a|mp4|aac|alac)$/i.test(file.name)) tags = mp4Tags(raw);
      const w = wavInfo(raw);
      if (w && w.pcm === 1 && w.ch === 2 && w.rate === 44100 && w.bits === 16) { kind = 'wav'; data = raw; ms = w.data / 4 / 44.1; }
      else { const buffer = await decodeAudio(raw); ({ kind, data } = await convert(buffer, progress)); ms = buffer.duration * 1000; }
    }
    return {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
      title: tags.title || guess.title, artist: tags.artist || guess.artist || 'Unknown Artist', album: tags.album || 'Unknown Album',
      genre: tags.genre || '', track: tags.track || guess.track || 0, ms: Math.round(ms), kind, size: data.length,
      bitrate: kind === 'mp3' ? Math.round(data.length * 8 / Math.max(ms, 1)) : 1411,
      data: data.buffer.byteLength === data.length ? data.buffer : data.slice().buffer, addedAt: Date.now(), source: file.name
    };
  }
  async function addFiles(list) {
    const files = [...list].filter(f => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|aiff?|ogg|oga|opus|flac|webm)$/i.test(f.name));
    if (!files.length) { status('No audio files found. Try MP3, AAC, WAV, AIFF, OGG or FLAC.'); return; }
    let added = 0, failed = 0;
    for (let i = 0; i < files.length; i++) {
      const label = `Importing ${i + 1} of ${files.length}: ${files[i].name}`;
      status(label);
      try { const s = await importSong(files[i], f => status(`${label} (converting to MP3, ${Math.round(f * 100)}%)`)); await songPut(s); songs.push(s); added++; }
      catch (e) { failed++; }
    }
    dirty = dirty || added > 0;
    renderSongs();
    status(`Added ${added} song${added === 1 ? '' : 's'}${failed ? `; ${failed} could not be read by this browser` : ''}. Press Sync to put them on the iPod.`);
  }
  async function removeSong(id) {
    await songDel(id);
    songs = songs.filter(s => s.id !== id);
    dirty = true; renderSongs();
  }
  const fmtTime = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderSongs() {
    const list = $('#songs');
    const total = songs.reduce((t, s) => t + s.size, 0);
    $('#song-count').textContent = songs.length ? `${songs.length} song${songs.length === 1 ? '' : 's'} · ${(total / 1e6).toFixed(1)} MB` : 'No songs yet';
    list.innerHTML = songs.length ? [...songs].sort((a, b) => a.title.localeCompare(b.title)).map(s => `
      <li><div class="meta"><span class="t">${esc(s.title)}</span><span class="a">${esc(s.artist)} · ${fmtTime(s.ms)} · ${s.kind.toUpperCase()}</span></div>
      <button class="rm" type="button" data-id="${esc(s.id)}" aria-label="Remove ${esc(s.title)}">Remove</button></li>`).join('') : '';
    $('#sync').disabled = !firmware || !dirty;
    $('#sync').textContent = dirty ? 'Sync to iPod' : 'iPod is up to date';
  }
  $('#songs').addEventListener('click', e => { const b = e.target.closest('.rm'); if (b) removeSong(b.dataset.id); });
  $('#sync').addEventListener('click', async () => {
    status('Syncing… the iPod will restart.');
    await saveDevice();
    await forgetSnapshot();
    boot(null);
  });

  // file pickers and drag-and-drop
  const fwPick = $('#fw-pick'), songPick = $('#song-pick');
  $('#fw-choose').addEventListener('click', () => fwPick.click());
  $('#fw-replace').addEventListener('click', () => fwPick.click());
  fwPick.addEventListener('change', () => { if (fwPick.files[0]) loadUpdater(fwPick.files[0]); fwPick.value = ''; });
  $('#add-songs').addEventListener('click', () => songPick.click());
  songPick.addEventListener('change', () => { addFiles(songPick.files); songPick.value = ''; });
  let depth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    if (elsewhere) return;
    const files = [...e.dataTransfer.files];
    const fw = files.find(f => /\.(dmg|bin|img|exe)$|^Firmware/i.test(f.name) && !/^audio\//.test(f.type));
    if (fw) loadUpdater(fw); else if (firmware) addFiles(files); else status('Load the iPod Software Updater first.');
  });
  // a reset reboots the iPod: songs and its own settings stay, the saved running state is dropped
  async function resetIpod() {
    if (!firmware) return;
    status('Restarting the iPod…');
    await saveDevice(); await forgetSnapshot();
    boot(null);
  }
  $('#reset').addEventListener('click', resetIpod);

  // Erase everything: firmware, songs, settings files and saved state, back to a first visit
  const clearStore = name => tx(name, 'readwrite', s => s ? s.clear() : mem[name].clear()).catch(() => mem[name].clear());
  $('#erase').addEventListener('click', () => { $('#erase-confirm').hidden = false; $('#erase').hidden = true; $('#erase-yes').focus(); });
  $('#erase-no').addEventListener('click', () => { $('#erase-confirm').hidden = true; $('#erase').hidden = false; });
  $('#erase-yes').addEventListener('click', async () => {
    bootSeq++; stopEngine(); running = false; bootInfo = null;
    await clearStore('kv'); await clearStore('songs');
    try { localStorage.removeItem('ipod-emu.light'); } catch (e) {}
    firmware = null; songs = []; deviceFiles = new Map(); dirty = false;
    alwaysLit = true; $('#light').checked = true;
    draw(new Uint8Array(160 * 128), false); $('#booting').hidden = true;
    showSpeed(0); renderFirmware(); renderSongs();
    $('#erase-confirm').hidden = true; $('#erase').hidden = false;
    status('Everything was erased. Load the iPod Software Updater to start.');
  });
  $('#mute').addEventListener('click', () => { setMute(!audio.muted); $('#mute').setAttribute('aria-pressed', String(audio.muted)); $('#mute').textContent = audio.muted ? 'Unmute' : 'Mute'; });

  // ---------- start ----------
  // load firmware, songs and settings from storage and boot, resuming the saved state when it still fits
  async function loadAndBoot() {
    try {
      const fw = await kvGet('firmware');
      firmware = fw && fw.osos ? { firmware: new Uint8Array(fw.firmware), osos: new Uint8Array(fw.osos), version: fw.version, source: fw.source } : null;
      songs = (await songsAll()) || [];
      const dev = await kvGet('device');
      deviceFiles = dev ? new Map(dev) : new Map();
    } catch (e) { /* storage unavailable: start empty */ }
    renderFirmware(); renderSongs();
    let snap = null;
    try { snap = await kvGet('snapshot'); } catch (e) { /* none */ }
    const have = new Set(songs.map(s => s.id));
    const usable = snap && snap.state && firmware && snap.version === firmware.version && snap.songIds.every(id => have.has(id));
    if (firmware) boot(usable ? snap : null); else status('Load the iPod Software Updater to start.');
  }

  // ---------- one tab at a time ----------
  // Every tab of this page shares one saved iPod, so only the tab holding a Web Lock runs it; the others show a
  // notice. "Use it here" asks the running tab (over a BroadcastChannel) to save and stop, then takes the lock;
  // a tab that does not answer within a few seconds (frozen in the background, say) has the lock taken from it.
  const LOCK = 'ipod-emulator';
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ipod-emulator') : null;
  const canLock = !!(navigator.locks && navigator.locks.request);
  let releaseLock = null;
  // resolves true once this tab holds the lock, false if it was not available (ifAvailable)
  function takeLock(opts) {
    return new Promise(res => {
      let granted = false;
      navigator.locks.request(LOCK, opts, lock => {
        if (!lock) { res(false); return; }
        granted = true; res(true);
        return new Promise(r => { releaseLock = r; });
      }).catch(() => {   // a held lock was taken by another tab (an aborted queued request lands here too)
        if (granted) { releaseLock = null; goElsewhere(); }
        res(false);
      });
    });
  }
  function goElsewhere() {
    bootSeq++; stopEngine(); running = false; bootInfo = null; playing = false;
    elsewhere = true; document.body.classList.add('elsewhere');
    $('#elsewhere').hidden = false; $('#away').hidden = false; $('#booting').hidden = true; $('#nofw').hidden = true;
    draw(new Uint8Array(160 * 128), false); showSpeed(0);
    status('This iPod is running in another tab.');
  }
  function comeBack() {
    elsewhere = false; document.body.classList.remove('elsewhere');
    $('#elsewhere').hidden = true; $('#away').hidden = true;
    loadAndBoot();
  }
  async function handOff() {   // another tab wants the iPod: save it, stop, and let go
    if (!releaseLock) return;
    while (snapping) await new Promise(r => setTimeout(r, 50));
    await saveSnapshot(); await saveDevice();
    const r = releaseLock; releaseLock = null;
    goElsewhere(); r();
  }
  if (channel) channel.onmessage = e => { if (e.data && e.data.type === 'take-over') handOff(); };
  $('#take-over').addEventListener('click', async () => {
    $('#take-over').disabled = true; status('Moving the iPod to this tab…');
    if (channel) channel.postMessage({ type: 'take-over' });
    const queued = new AbortController();
    const waited = await Promise.race([takeLock({ signal: queued.signal }), new Promise(r => setTimeout(() => r(null), 4000))]);
    if (waited === null && !releaseLock) { queued.abort(); await takeLock({ steal: true }); }   // the other tab did not answer
    $('#take-over').disabled = false;
    comeBack();
  });
  // ?debug in the page address shows the sound engine's state under the status line (for checking phones)
  if (/[?&#]debug\b/.test(location.href)) {
    const line = document.createElement('p'); line.className = 'status'; line.style.opacity = '.7'; statusEl.after(line);
    let out = null;   // what the sound processor reports: seconds played, buffered, underruns
    setInterval(() => {
      if (audio.kind === 'worklet') { audio.node.port.onmessage = e => { if (e.data.type === 'stats') out = e.data; }; audio.node.port.postMessage({ type: 'stats' }); }
      else if (audio.ring) out = { played: audio.ring.r / 44100, fill: audio.ring.fill(), underruns: audio.ring.underruns };
      const c = audio.ctx, s = navigator.audioSession;
      line.textContent = `audio: ${audio.kind || 'not started'}, ${c ? c.state + ', ' + c.sampleRate + ' Hz' : 'no context'}` +
        `, session ${s ? s.type : (silentKeeper ? 'audio element' : 'default')}, muted ${audio.muted}` +
        (out ? `, played ${out.played.toFixed(1)} s, buffered ${Math.round(out.fill / 44.1)} ms, underruns ${out.underruns}` : '') +
        `, core ${window.ipodDebug.blocks == null ? 'interpreter' : 'blocks ' + window.ipodDebug.blocks}`;
    }, 1000);
  }
  // test hooks, local only (for devices without a file picker at hand): ?fw=<path on this server> loads that updater,
  // ?song=<path> adds that song and syncs it
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname), qs = new URLSearchParams(location.search);
  const fwParam = local && qs.get('fw'), songParam = local && qs.get('song');
  (async () => {
    if (canLock && !(await takeLock({ ifAvailable: true }))) {   // another tab runs it: show what is stored, behind the notice
      try { const fw = await kvGet('firmware'); if (fw && fw.osos) firmware = { firmware: new Uint8Array(fw.firmware), osos: new Uint8Array(fw.osos), version: fw.version, source: fw.source }; songs = (await songsAll()) || []; } catch (e) {}
      renderFirmware(); renderSongs(); goElsewhere();
      return;
    }
    if (fwParam && !(await kvGet('firmware').catch(() => null))) await loadUpdater(new File([await (await fetch(fwParam)).blob()], fwParam.split('/').pop()));
    else await loadAndBoot();
    if (songParam && firmware && !songs.length) {
      await addFiles([new File([await (await fetch(songParam)).blob()], songParam.split('/').pop())]);
      $('#sync').click();
    }
  })();
  addEventListener('pagehide', () => { if (!elsewhere) { saveSnapshot(); saveDevice(); } });
})();

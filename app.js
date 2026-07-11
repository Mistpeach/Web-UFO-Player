// ============================================================
// app.js - UFO-TW Controller (Pure JS, zero dependencies)
// ============================================================

// ---------- BLE ----------
const UFO_SERVICE = '40ee0200-63ec-4b7f-8ce7-712efd55b90e';
const UFO_CHAR    = '40ee0202-63ec-4b7f-8ce7-712efd55b90e';

// ---------- State ----------
let bleChar = null;
let isFlipped = false;
let playlist = [];
let script = [];
let lastCmd = { left: 0, right: 0 };
let currentIdx = -1;
let syncTimer = null;

const $ = id => document.getElementById(id);
const player = $('player');

// ==================== BLE ====================

async function ble_connect() {
  console.log('ble_connect() called');
  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'UFO-TW' }],
      optionalServices: [UFO_SERVICE]
    });
    console.log('Device selected:', dev.name);
    const srv = await dev.gatt.connect();
    dev.addEventListener('gattserverdisconnected', () => {
      bleChar = null;
      $('bleLabel').textContent = '未连接';
      $('bleLabel').className = 'badge off';
      console.log('BLE disconnected');
    });
    const svc = await srv.getPrimaryService(UFO_SERVICE);
    bleChar = await svc.getCharacteristic(UFO_CHAR);
    $('bleLabel').textContent = '已连接';
    $('bleLabel').className = 'badge on';
    console.log('BLE ready');
  } catch (e) {
    console.log('BLE error:', e.message || e);
  }
}

function ble_send(l, r) {
  if (!bleChar) return;
  if (isFlipped) [l, r] = [r, l];
  const enc = v => v < 0 ? ((~v + 129) & 0xFF) : (v & 0xFF);
  try {
    bleChar.writeValueWithoutResponse(new Uint8Array([0x05, enc(l), enc(r)]));
    lastCmd.left = l;
    lastCmd.right = r;
  } catch (e) { console.log('BLE write err:', e); }
}

// ==================== FOLDER ====================

async function folder_open() {
  console.log('folder_open() called');
  try {
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    console.log('Folder selected:', dir.name);
    const map = {};
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file') map[name] = h;
    }
    console.log('Files found:', Object.keys(map).length);

    const mExts = new Set(['.mp4','.webm','.mkv','.mov','.avi','.mp3','.wav','.ogg','.flac','.m4a']);
    const groups = new Map();
    for (const [name, h] of Object.entries(map)) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.substring(0, dot) : name;
      const ext  = dot > 0 ? name.substring(dot).toLowerCase() : '';
      if (!groups.has(base)) groups.set(base, {});
      const g = groups.get(base);
      if (mExts.has(ext))    g.media = h;
      else if (ext === '.csv') g.csv = h;
      else if (ext === '.vtt') g.vtt = h;
    }

    playlist = [];
    for (const [base, g] of groups) {
      if (g.media) playlist.push({ base, mh: g.media, ch: g.csv || null, vh: g.vtt || null });
    }
    playlist.sort((a, b) => a.base.localeCompare(b.base));
    render_playlist();
    console.log('Playlist built:', playlist.length, 'items');
    if (playlist.length > 0) pl_select(0);
  } catch (e) {
    if (e.name !== 'AbortError') console.log('Folder err:', e);
  }
}

function render_playlist() {
  const el = $('playlist');
  if (!playlist.length) {
    el.innerHTML = '<div style="padding:20px;color:#666;">未找到媒体文件</div>';
    return;
  }
  el.innerHTML = playlist.map((p, i) =>
    `<div class="pl-item" data-idx="${i}" onclick="pl_select(${i})">${p.base}</div>`
  ).join('');
  console.log('Playlist rendered');
}

async function pl_select(idx) {
  const p = playlist[idx];
  if (!p) return;
  console.log('pl_select:', idx, p.base);

  // Track current index
  currentIdx = idx;

  // Highlight
  document.querySelectorAll('.pl-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.pl-item[data-idx="${idx}"]`)?.classList.add('active');

  // Media
  const file = await p.mh.getFile();
  const url = URL.createObjectURL(file);
  player.src = url;
  player.removeAttribute('hidden');
  player.style.display = 'block';
  $('placeholder').style.display = 'none';
  console.log('Media set:', file.name, file.type, file.size);
  player.onerror = () => {
    console.log('Media load error');
    $('actionText').textContent = '加载媒体失败';
    $('placeholder').style.display = '';
    player.style.display = 'none';
  };
  player.onloadedmetadata = () => {
    console.log('Media metadata loaded, duration:', player.duration);
  };

  // Subtitle
  player.querySelectorAll('track').forEach(t => t.remove());
  if (p.vh) {
    const vf = await p.vh.getFile();
    const trk = document.createElement('track');
    trk.kind = 'subtitles'; trk.label = '字幕';
    trk.src = URL.createObjectURL(vf);
    trk.track.mode = 'hidden';
    trk.track.addEventListener('cuechange', () => {
      const cues = trk.track.activeCues;
      const display = $('subDisplay');
      if (cues && cues.length > 0) {
        display.textContent = cues[0].text;
        display.style.display = '';
      } else {
        display.style.display = 'none';
      }
    });
    player.appendChild(trk);
  }

  // CSV
  if (p.ch) await load_csv(p.ch);
  else { script = []; $('actionText').textContent = '无脚本'; }
}

async function load_csv(h) {
  const file = await h.getFile();
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  script = [];
  for (const line of lines) {
    const cols = line.split(',').map(v => v.trim());
    if (cols.length < 3) continue;
    const ts = parseInt(cols[0]) * 100;
    if (cols.length >= 5) {
      let l = parseInt(cols[2]); if (cols[1] === '1') l = -l;
      let r = parseInt(cols[4]); if (cols[3] === '1') r = -r;
      script.push({ ts, left: l, right: r });
    } else {
      let p = parseInt(cols[2]); if (cols[1] === '1') p = -p;
      script.push({ ts, left: p, right: p });
    }
  }
  script.sort((a, b) => a.ts - b.ts);
  $('actionText').textContent = `脚本: ${script.length} 条`;
  draw_waveform();
  console.log('CSV loaded:', script.length, 'actions');
}

// ---------- Waveform Canvas ----------
function draw_waveform() {
  if (!script.length) return;
  const canvas = $('waveCanvas');
  const wrap = $('waveWrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W === 0) return;
  canvas.width = W; canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const totalMs = script[script.length - 1].ts;
  if (totalMs <= 0) return;

  const barW = Math.max(1, Math.floor(W / 800));
  const bars = Math.floor(W / barW);
  const binMs = totalMs / bars;

  const peaks = new Array(bars).fill(0);
  let si = 0;
  for (let b = 0; b < bars; b++) {
    const tEnd = (b + 1) * binMs;
    while (si < script.length && script[si].ts < tEnd) {
      const i = Math.max(Math.abs(script[si].left), Math.abs(script[si].right)) / 127;
      if (i > peaks[b]) peaks[b] = i;
      si++;
    }
  }

  for (let b = 0; b < bars; b++) {
    const p = peaks[b];
    if (p === 0) continue;
    const barH = Math.max(1, Math.floor(p * H));
    const y = H - barH;
    const alpha = 0.4 + p * 0.6;
    ctx.fillStyle = p > 0.7 ? `rgba(255,80,80,${alpha})` : `rgba(83,52,131,${alpha})`;
    ctx.fillRect(b * barW, y, barW - 1, barH);
  }

  $('wavePos').style.left = '0px';
}

function update_wave_pos() {
  if (!player.duration || !script.length) return;
  const totalMs = script[script.length - 1].ts;
  const ratio = player.currentTime * 1000 / totalMs;
  $('wavePos').style.left = (Math.min(1, ratio) * $('waveWrap').clientWidth) + 'px';
}

window.addEventListener('resize', () => { if (script.length) draw_waveform(); });

// ==================== SYNC ====================

function get_cmd(ms) {
  if (!script.length) return { left: 0, right: 0 };
  if (ms < script[0].ts) return { left: 0, right: 0 };
  let lo = 0, hi = script.length - 1, idx = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ms >= script[m].ts) { idx = m; lo = m + 1; }
    else hi = m - 1;
  }
  return { left: script[idx].left, right: script[idx].right };
}

player.addEventListener('play', () => {
  console.log('play');
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!player.currentTime || !script.length) return;
    const cmd = get_cmd(player.currentTime * 1000);
    if (cmd.left !== lastCmd.left || cmd.right !== lastCmd.right) {
      ble_send(cmd.left, cmd.right);
      $('actionText').textContent =
        `左:${cmd.left<0?'反':'正'}${Math.abs(cmd.left)} 右:${cmd.right<0?'反':'正'}${Math.abs(cmd.right)}`;
    }
  }, 50);
});

player.addEventListener('pause', () => {
  console.log('pause');
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  ble_send(0, 0);
});

player.addEventListener('ended', () => {
  console.log('ended');
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  ble_send(0, 0);
  // Auto-play next
  const next = currentIdx + 1;
  if (next < playlist.length) {
    console.log('Auto-playing next:', next);
    pl_select(next).then(() => {
      player.play().catch(() => {});
    });
  }
});

player.addEventListener('timeupdate', () => {
  if (!player.duration) return;
  $('timeText').textContent =
    fmt_time(player.currentTime) + ' / ' + fmt_time(player.duration);
  update_wave_pos();
});

// ==================== UTIL ====================

function fmt_time(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function flip_toggle() {
  isFlipped = !isFlipped;
  const btn = $('btnFlip');
  btn.classList.toggle('flip-on', isFlipped);
  btn.textContent = isFlipped ? '🔀 已交换左右电机' : '🔀 交换左右电机';
}

function show_tutorial() {
  $('tutorialOverlay').style.display = 'flex';
}
function hide_tutorial() {
  $('tutorialOverlay').style.display = 'none';
}

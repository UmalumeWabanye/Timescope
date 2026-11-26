// Timescope — upload photos of yourself over the years and play them back as a timelapse.

const $ = (sel, el = document) => el.querySelector(sel);

const FORMATS = {
  square: [1080, 1080],
  portrait: [1080, 1350],
  story: [1080, 1920],
  landscape: [1920, 1080],
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SETTINGS_KEY = 'timescope.settings.v1';
const IDENTITY = { x: 0, y: 0, scale: 1, rotate: 0 };

// ---------------------------------------------------------------- state

const DEFAULT_SETTINGS = { hold: 0.6, format: 'square', fade: true, showDate: true, loop: true, birthday: '' };
const settings = loadSettings();

let photos = []; // sorted by date
const images = new Map(); // file -> HTMLImageElement (decoded)

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const player = { playing: false, t: 0, last: 0 };
let exporting = null; // { rec, cancelled }

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

// ---------------------------------------------------------------- helpers

async function api(method, url, body) {
  const opts = { method };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    // Session expired or signed out in another tab.
    location.assign('/login');
    throw new Error('Signed out');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5000 : 2600);
}

const sortPhotos = () =>
  photos.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

const pad2 = (n) => String(n).padStart(2, '0');
const localISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function formatDate(iso, withYear = true) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

function ageOn(dateIso) {
  if (!settings.birthday) return null;
  const [by, bm, bd] = settings.birthday.split('-').map(Number);
  const [y, m, d] = dateIso.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age >= 0 ? age : null;
}

// Range inputs paint their filled portion from --p.
function syncRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  el.style.setProperty('--p', `${((Number(el.value) - min) / (max - min || 1)) * 100}%`);
}
document.addEventListener('input', (e) => e.target.matches?.('input[type="range"]') && syncRange(e.target));

const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function loadImage(photo) {
  if (images.has(photo.file)) return Promise.resolve(images.get(photo.file));
  const img = new Image();
  img.src = `/uploads/${photo.file}`;
  return img
    .decode()
    .then(() => {
      images.set(photo.file, img);
      return img;
    })
    .catch(() => null);
}
const ensureImages = () => Promise.all(photos.map(loadImage));

// ---------------------------------------------------------------- EXIF date

// Reads DateTimeOriginal (or DateTime) from a JPEG's EXIF block. Returns "YYYY-MM-DD" or null.
async function exifDate(file) {
  try {
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && off + 10 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) {
        return parseTiffDate(v, off + 10);
      }
      off += 2 + len;
    }
  } catch {
    /* malformed EXIF — fall back to file date */
  }
  return null;
}

function parseTiffDate(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const readIfd = (ifdOff) => {
    const tags = {};
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      tags[u16(e)] = { count: u32(e + 4), valOff: e + 8 };
    }
    return tags;
  };
  const ascii = (t) => {
    const o = t.count > 4 ? u32(t.valOff) : t.valOff;
    let s = '';
    for (let i = 0; i < t.count - 1; i++) s += String.fromCharCode(v.getUint8(start + o + i));
    return s;
  };
  const ifd0 = readIfd(u32(4));
  let raw;
  if (ifd0[0x8769]) {
    const exif = readIfd(u32(ifd0[0x8769].valOff));
    if (exif[0x9003]) raw = ascii(exif[0x9003]);
  }
  if (!raw && ifd0[0x0132]) raw = ascii(ifd0[0x0132]);
  const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
  return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---------------------------------------------------------------- drawing

function drawPhoto(c, photo, W, H, alpha = 1, transform = photo.transform) {
  const img = images.get(photo.file);
  if (!img) return;
  const t = { ...IDENTITY, ...transform };
  const u = Math.min(W, H);
  const cover = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const s = cover * t.scale;
  c.save();
  c.globalAlpha = alpha;
  c.translate(W / 2 + t.x * u, H / 2 + t.y * u);
  c.rotate((t.rotate * Math.PI) / 180);
  c.scale(s, s);
  c.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  c.restore();
}

function drawOverlay(c, W, H, photo, progress) {
  const u = Math.min(W, H);
  const pad = u * 0.055;
  const g = c.createLinearGradient(0, H - u * 0.32, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
  c.fillStyle = g;
  c.fillRect(0, H - u * 0.32, W, u * 0.32);

  const [year] = photo.date.split('-');
  const age = ageOn(photo.date);
  c.save();
  c.fillStyle = '#fff';
  c.textBaseline = 'alphabetic';
  c.shadowColor = 'rgba(0,0,0,0.3)';
  c.shadowBlur = u * 0.012;
  c.font = `600 ${Math.round(u * 0.075)}px ${SANS}`;
  c.fillText(year, pad, H - pad - u * 0.042);
  c.globalAlpha = 0.82;
  c.font = `500 ${Math.round(u * 0.027)}px ${SANS}`;
  c.fillText(formatDate(photo.date, false) + (age !== null ? ` · Age ${age}` : ''), pad, H - pad);
  c.restore();

  // Thin progress line along the bottom edge
  const bh = Math.max(2, Math.round(u * 0.004));
  c.fillStyle = 'rgba(255,255,255,0.2)';
  c.fillRect(0, H - bh, W, bh);
  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.fillRect(0, H - bh, W * clamp(progress, 0, 1), bh);
}

// Year markers under the scrubber; clicking one jumps to that year's first photo.
function renderTicks() {
  const root = $('#ticks');
  root.replaceChildren();
  const n = photos.length;
  if (n < 2) return;
  const years = [];
  photos.forEach((p, i) => {
    const y = p.date.slice(0, 4);
    if (!years.length || years.at(-1).year !== y) years.push({ year: y, index: i });
  });
  years.forEach(({ year, index }) => {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'tick';
    tick.style.setProperty('--f', String(index / n));
    tick.textContent = year;
    tick.setAttribute('aria-label', `Jump to ${year}`);
    tick.addEventListener('click', () => {
      if (exporting) return;
      pause();
      player.t = index * holdMs();
      render();
    });
    root.append(tick);
  });
  layoutTicks();
}

// Only label a year when there's room since the last labelled one; others stay as bare ticks.
function layoutTicks() {
  const root = $('#ticks');
  const width = root.clientWidth;
  let lastX = -Infinity;
  for (const tick of root.children) {
    const x = Number(tick.style.getPropertyValue('--f')) * width;
    const show = x - lastX >= 44;
    tick.classList.toggle('unlabelled', !show);
    if (show) lastX = x;
  }
}
new ResizeObserver(layoutTicks).observe($('#ticks'));

const holdMs = () => settings.hold * 1000;
const fadeMs = () => (settings.fade ? Math.min(holdMs() * 0.6, 700) : 0);
const totalMs = () => photos.length * holdMs();

// Draws the frame at time t; returns the index of the photo being "shown".
function renderFrame(c, W, H, t) {
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  const n = photos.length;
  if (!n) return 0;
  const h = holdMs();
  const f = fadeMs();
  const i = clamp(Math.floor(t / h), 0, n - 1);
  const local = t - i * h;
  drawPhoto(c, photos[i], W, H, 1);
  let shown = i;
  if (f && i < n - 1 && local > h - f) {
    const a = easeInOut((local - (h - f)) / f);
    drawPhoto(c, photos[i + 1], W, H, a);
    if (a >= 0.5) shown = i + 1;
  }
  if (settings.showDate) drawOverlay(c, W, H, photos[shown], n > 1 ? t / totalMs() : 1);
  return shown;
}

// ---------------------------------------------------------------- player

const playBtn = $('#play');
const scrub = $('#scrub');
const counter = $('#counter');

function sizeCanvas() {
  const [W, H] = FORMATS[settings.format] || FORMATS.square;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
}

function render() {
  const shown = renderFrame(ctx, canvas.width, canvas.height, player.t);
  const total = totalMs();
  scrub.max = String(Math.max(1, total));
  scrub.value = String(Math.min(player.t, total));
  syncRange(scrub);
  counter.textContent = photos.length ? `${shown + 1} / ${photos.length}` : '0 / 0';
}

function tick(now) {
  if (!player.playing) return;
  player.t += now - player.last;
  player.last = now;
  const total = totalMs();
  if (player.t >= total) {
    if (exporting) {
      player.t = total - 1;
      render();
      pause();
      exporting.rec.stop();
      return;
    }
    if (settings.loop) player.t %= total;
    else {
      player.t = total - 1;
      render();
      pause();
      return;
    }
  }
  render();
  requestAnimationFrame(tick);
}

function play() {
  if (!photos.length || player.playing) return;
  if (player.t >= totalMs() - 1) player.t = 0;
  player.playing = true;
  player.last = performance.now();
  playBtn.classList.add('is-playing');
  playBtn.setAttribute('aria-label', 'Pause');
  requestAnimationFrame(tick);
}

function pause() {
  player.playing = false;
  playBtn.classList.remove('is-playing');
  playBtn.setAttribute('aria-label', 'Play');
}

function step(dir) {
  pause();
  const h = holdMs();
  const i = clamp(Math.floor(player.t / h) + dir, 0, photos.length - 1);
  player.t = i * h;
  render();
}

playBtn.addEventListener('click', () => (player.playing ? pause() : play()));
scrub.addEventListener('input', () => {
  if (exporting) return;
  pause();
  player.t = Number(scrub.value);
  render();
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || exporting) return;
  if (e.target.closest('input, select, textarea, button')) return;
  if (!photos.length) return;
  if (e.key === ' ') {
    e.preventDefault();
    player.playing ? pause() : play();
  } else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
});

// ---------------------------------------------------------------- settings panel

const optSpeed = $('#opt-speed');
const optFormat = $('#opt-format');
const optBirthday = $('#opt-birthday');
const optFade = $('#opt-fade');
const optDate = $('#opt-date');
const optLoop = $('#opt-loop');

optSpeed.value = String(settings.hold);
if (!optSpeed.value) optSpeed.value = String((settings.hold = DEFAULT_SETTINGS.hold));
optFormat.value = settings.format;
optBirthday.value = settings.birthday;
optFade.checked = settings.fade;
optDate.checked = settings.showDate;
optLoop.checked = settings.loop;

function onSetting(apply) {
  return () => {
    apply();
    saveSettings();
    sizeCanvas();
    render();
    renderGallery();
  };
}

optSpeed.addEventListener('change', () => {
  // Keep the same photo on screen when the speed changes.
  const index = Math.floor(player.t / holdMs());
  settings.hold = Number(optSpeed.value);
  player.t = index * holdMs();
  saveSettings();
  render();
});
optFormat.addEventListener('change', onSetting(() => (settings.format = optFormat.value)));
optBirthday.addEventListener('change', onSetting(() => (settings.birthday = optBirthday.value)));
optFade.addEventListener('change', onSetting(() => (settings.fade = optFade.checked)));
optDate.addEventListener('change', onSetting(() => (settings.showDate = optDate.checked)));
optLoop.addEventListener('change', onSetting(() => (settings.loop = optLoop.checked)));

// ---------------------------------------------------------------- export video

const exportBtn = $('#export');

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function setExportUI(on) {
  exportBtn.classList.toggle('recording', on);
  $('span', exportBtn).textContent = on ? 'Recording… click to cancel' : 'Export video';
  for (const el of [optSpeed, optFormat, optBirthday, optFade, optDate, optLoop, scrub, playBtn]) el.disabled = on;
}

async function exportVideo() {
  if (exporting) {
    exporting.cancelled = true;
    pause();
    exporting.rec.stop();
    return;
  }
  if (!photos.length) return;
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
    toast("This browser can't record video. Try a recent Chrome, Edge, Firefox or Safari.", true);
    return;
  }
  pause();
  await ensureImages();

  const mimeType = pickMimeType();
  const stream = canvas.captureStream(30);
  let rec;
  try {
    rec = new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: 10_000_000 });
  } catch (err) {
    toast(`Couldn't start recording: ${err.message}`, true);
    return;
  }
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve) => (rec.onstop = resolve));

  exporting = { rec, cancelled: false };
  setExportUI(true);
  player.t = 0;
  render();
  rec.start(250);
  play();
  await stopped;

  const { cancelled } = exporting;
  exporting = null;
  stream.getTracks().forEach((t) => t.stop());
  setExportUI(false);
  if (cancelled) {
    toast('Export cancelled');
    return;
  }
  const type = rec.mimeType || mimeType || 'video/webm';
  const blob = new Blob(chunks, { type });
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `timescope-${localISODate(new Date())}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast(`Saved ${a.download}`);
}

exportBtn.addEventListener('click', exportVideo);

// ---------------------------------------------------------------- gallery & page

function renderGallery() {
  const years = new Map();
  for (const p of photos) {
    const y = p.date.slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(p);
  }
  const root = $('#years');
  root.replaceChildren();
  for (const [year, list] of years) {
    const section = document.createElement('section');
    section.className = 'year';
    const head = document.createElement('div');
    head.className = 'year-head';
    const h3 = document.createElement('h3');
    h3.textContent = year;
    const count = document.createElement('span');
    const age = ageOn(list[0].date);
    count.textContent = `${list.length} photo${list.length === 1 ? '' : 's'}${age !== null ? ` · age ${age}` : ''}`;
    head.append(h3, count);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const p of list) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.setAttribute('aria-label', `Edit photo from ${formatDate(p.date)}`);
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = `/uploads/${p.file}`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatDate(p.date);
      if (p.caption) {
        const small = document.createElement('small');
        small.textContent = p.caption;
        meta.append(small);
      }
      card.append(img, meta);
      card.addEventListener('click', () => openEditor(p.id));
      grid.append(card);
    }
    section.append(head, grid);
    root.append(section);
  }
}

function renderPage() {
  const has = photos.length > 0;
  $('#empty').hidden = has;
  $('#player').hidden = !has;
  $('#gallery').hidden = !has;
  if (has) {
    const first = photos[0].date.slice(0, 4);
    const last = photos.at(-1).date.slice(0, 4);
    $('#span-label').textContent =
      `${photos.length} photo${photos.length === 1 ? '' : 's'} · ${first === last ? first : `${first} – ${last}`}`;
  }
  player.t = Math.min(player.t, Math.max(0, totalMs() - 1));
  sizeCanvas();
  render();
  renderTicks();
  renderGallery();
}

async function refresh() {
  photos = await api('GET', '/api/photos');
  sortPhotos();
  renderPage();
  await ensureImages();
  render();
}

// ---------------------------------------------------------------- adding photos

const review = $('#review');
const reviewList = $('#review-list');
const reviewUploadBtn = $('#review-upload');
let staged = [];
let uploading = false;

const isHeic = (f) => /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
const isSupported = (f) => /^image\/(jpeg|png|webp|gif|avif)$/.test(f.type);

async function stageFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || isHeic(f));
  if (!files.length) {
    toast('Those files are not images.', true);
    return;
  }
  for (const s of staged) URL.revokeObjectURL(s.url);
  staged = await Promise.all(
    files.map(async (file) => {
      if (!isSupported(file)) {
        return {
          file,
          url: '',
          date: '',
          note: isHeic(file) ? 'HEIC isn’t supported — export it as JPEG first' : 'Unsupported image type',
          status: 'failed',
        };
      }
      const exif = await exifDate(file);
      return {
        file,
        url: URL.createObjectURL(file),
        date: exif || localISODate(new Date(file.lastModified)),
        note: exif ? 'Date from camera' : 'Date from file — please check',
        status: 'pending',
      };
    }),
  );
  staged.sort((a, b) => a.date.localeCompare(b.date));
  renderReview();
  if (!review.open) review.showModal();
}

function renderReview() {
  const pending = staged.filter((s) => s.status === 'pending');
  $('#review-title').textContent = `Add ${pending.length} photo${pending.length === 1 ? '' : 's'}`;
  reviewUploadBtn.disabled = uploading || !pending.length;
  reviewList.replaceChildren();
  staged.forEach((s, idx) => {
    const li = document.createElement('li');
    li.className = `review-item ${s.status === 'done' ? 'done' : ''} ${s.status === 'failed' ? 'failed' : ''}`;
    const img = document.createElement('img');
    img.alt = '';
    if (s.url) img.src = s.url;
    const info = document.createElement('div');
    info.className = 'name';
    info.textContent = s.file.name;
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = s.note;
    info.append(src);
    const date = document.createElement('input');
    date.type = 'date';
    date.value = s.date;
    date.required = true;
    date.disabled = uploading || s.status !== 'pending';
    date.max = localISODate(new Date());
    date.addEventListener('change', () => (s.date = date.value));
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn ghost';
    rm.setAttribute('aria-label', `Remove ${s.file.name}`);
    rm.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    rm.disabled = uploading;
    rm.addEventListener('click', () => {
      if (s.url) URL.revokeObjectURL(s.url);
      staged.splice(idx, 1);
      if (!staged.length) review.close();
      else renderReview();
    });
    li.append(img, info, date, rm);
    reviewList.append(li);
  });
}

reviewUploadBtn.addEventListener('click', async () => {
  const pending = staged.filter((s) => s.status === 'pending');
  if (pending.some((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s.date))) {
    toast('Every photo needs a date.', true);
    return;
  }
  uploading = true;
  renderReview();
  const status = $('#review-status');
  let ok = 0;
  for (const [i, s] of pending.entries()) {
    status.textContent = `Uploading ${i + 1} of ${pending.length}…`;
    const fd = new FormData();
    fd.append('date', s.date);
    fd.append('photo', s.file);
    try {
      const photo = await api('POST', '/api/photos', fd);
      photos.push(photo);
      s.status = 'done';
      s.note = 'Added';
      ok++;
    } catch (err) {
      s.status = 'failed';
      s.note = err.message;
    }
    renderReview();
  }
  uploading = false;
  status.textContent = '';
  sortPhotos();
  renderPage();
  ensureImages().then(render);
  const failed = staged.filter((s) => s.status === 'failed').length;
  if (!failed) {
    review.close();
    toast(`Added ${ok} photo${ok === 1 ? '' : 's'} to your timeline`);
  } else {
    renderReview();
    toast(`${ok} added, ${failed} couldn’t be added`, true);
  }
});

review.addEventListener('cancel', (e) => uploading && e.preventDefault());
review.addEventListener('close', () => {
  for (const s of staged) if (s.url) URL.revokeObjectURL(s.url);
  staged = [];
});

for (const input of document.querySelectorAll('#file-input, .file-input-alt')) {
  input.addEventListener('change', () => {
    if (input.files.length) stageFiles(input.files);
    input.value = '';
  });
}

// Drag and drop anywhere on the page
const dropOverlay = $('#drop-overlay');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || uploading) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  if (!uploading && e.dataTransfer.files.length) stageFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- editor (align / date / delete)

const editor = $('#editor');
const edCanvas = $('#editor-canvas');
const edCtx = edCanvas.getContext('2d');
const edScale = $('#ed-scale');
const edRotate = $('#ed-rotate');
const edOnion = $('#ed-onion');
const edOnionAmt = $('#ed-onion-amt');
const edGuides = $('#ed-guides');
const edDate = $('#ed-date');
const edCaption = $('#ed-caption');
const ed = { photo: null, ref: null, draft: { ...IDENTITY } };

async function openEditor(id) {
  const idx = photos.findIndex((p) => p.id === id);
  if (idx === -1) return;
  pause();
  ed.photo = photos[idx];
  ed.ref = photos[idx - 1] || photos[idx + 1] || null;
  ed.draft = { ...IDENTITY, ...ed.photo.transform };
  edDate.value = ed.photo.date;
  edCaption.value = ed.photo.caption || '';
  edOnion.disabled = edOnionAmt.disabled = !ed.ref;
  $('#ed-onion + span').textContent = !ed.ref
    ? 'Previous photo overlay (add another photo first)'
    : photos[idx - 1]
      ? 'Show previous photo faded on top'
      : 'Show next photo faded on top';
  syncEditorSliders();

  const [W, H] = FORMATS[settings.format] || FORMATS.square;
  edCanvas.width = Math.round(W * 0.6);
  edCanvas.height = Math.round(H * 0.6);
  editor.showModal();
  await Promise.all([loadImage(ed.photo), ed.ref && loadImage(ed.ref)]);
  renderEditor();
}

function syncEditorSliders() {
  edScale.value = String(ed.draft.scale);
  edRotate.value = String(ed.draft.rotate);
  for (const el of [edScale, edRotate, edOnionAmt]) syncRange(el);
}

function renderEditor() {
  if (!ed.photo) return;
  const W = edCanvas.width;
  const H = edCanvas.height;
  edCtx.fillStyle = '#000';
  edCtx.fillRect(0, 0, W, H);
  drawPhoto(edCtx, ed.photo, W, H, 1, ed.draft);
  if (ed.ref && edOnion.checked) drawPhoto(edCtx, ed.ref, W, H, Number(edOnionAmt.value));
  if (edGuides.checked) {
    const u = Math.min(W, H);
    edCtx.save();
    edCtx.strokeStyle = 'rgba(255,255,255,0.7)';
    edCtx.lineWidth = Math.max(1, u / 400);
    edCtx.setLineDash([u / 60, u / 80]);
    edCtx.beginPath();
    edCtx.moveTo(W / 2, 0);
    edCtx.lineTo(W / 2, H);
    edCtx.moveTo(0, H * 0.42);
    edCtx.lineTo(W, H * 0.42);
    edCtx.stroke();
    edCtx.setLineDash([]);
    edCtx.strokeStyle = 'rgba(255,255,255,0.35)';
    edCtx.beginPath();
    edCtx.ellipse(W / 2, H * 0.47, u * 0.2, u * 0.27, 0, 0, Math.PI * 2);
    edCtx.stroke();
    edCtx.restore();
  }
}

edScale.addEventListener('input', () => {
  ed.draft.scale = Number(edScale.value);
  renderEditor();
});
edRotate.addEventListener('input', () => {
  ed.draft.rotate = Number(edRotate.value);
  renderEditor();
});
for (const el of [edOnion, edOnionAmt, edGuides]) el.addEventListener('input', renderEditor);
$('#ed-reset').addEventListener('click', () => {
  ed.draft = { ...IDENTITY };
  syncEditorSliders();
  renderEditor();
});

let drag = null;
edCanvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, start: { ...ed.draft } };
  edCanvas.setPointerCapture(e.pointerId);
  edCanvas.classList.add('dragging');
});
edCanvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const rect = edCanvas.getBoundingClientRect();
  const ratio = edCanvas.width / rect.width;
  const u = Math.min(edCanvas.width, edCanvas.height);
  ed.draft.x = clamp(drag.start.x + ((e.clientX - drag.x) * ratio) / u, -2, 2);
  ed.draft.y = clamp(drag.start.y + ((e.clientY - drag.y) * ratio) / u, -2, 2);
  renderEditor();
});
const endDrag = () => {
  drag = null;
  edCanvas.classList.remove('dragging');
};
edCanvas.addEventListener('pointerup', endDrag);
edCanvas.addEventListener('pointercancel', endDrag);
edCanvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    ed.draft.scale = clamp(ed.draft.scale * Math.exp(-e.deltaY * 0.0015), 0.5, 4);
    syncEditorSliders();
    renderEditor();
  },
  { passive: false },
);

$('#ed-save').addEventListener('click', async () => {
  if (!edDate.reportValidity()) return;
  const btn = $('#ed-save');
  btn.disabled = true;
  try {
    const updated = await api('PATCH', `/api/photos/${ed.photo.id}`, {
      date: edDate.value,
      caption: edCaption.value,
      transform: ed.draft,
    });
    Object.assign(ed.photo, updated);
    sortPhotos();
    // Jump the player to the edited photo so the change is visible.
    player.t = photos.indexOf(ed.photo) * holdMs();
    renderPage();
    editor.close();
    toast('Saved');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#ed-delete').addEventListener('click', async () => {
  if (!confirm(`Delete the photo from ${formatDate(ed.photo.date)}? This can't be undone.`)) return;
  try {
    await api('DELETE', `/api/photos/${ed.photo.id}`);
    photos = photos.filter((p) => p !== ed.photo);
    images.delete(ed.photo.file);
    editor.close();
    renderPage();
    toast('Photo deleted');
  } catch (err) {
    toast(err.message, true);
  }
});

// Enter in a text field would otherwise submit the dialog form via its first button (Close).
for (const el of [edCaption, edDate]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#ed-save').click();
    }
  });
}

editor.addEventListener('close', () => {
  ed.photo = ed.ref = null;
});

// ---------------------------------------------------------------- boot

api('GET', '/api/session')
  .then(({ authEnabled }) => ($('#logout').hidden = !authEnabled))
  .catch(() => {});

refresh().catch((err) => {
  toast(`Couldn't load your photos: ${err.message}`, true);
  $('#empty').hidden = false;
});

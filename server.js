import express from 'express';
import multer from 'multer';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'photos.json');
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

if (IS_PROD && !APP_PASSWORD) {
  console.error('APP_PASSWORD must be set when NODE_ENV=production. Refusing to start without a login.');
  process.exit(1);
}
if (!APP_PASSWORD) {
  console.warn('APP_PASSWORD is not set, so login is disabled. That is fine on your own machine only.');
}

const ALLOWED_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

await fs.mkdir(UPLOAD_DIR, { recursive: true });

// ---------- tiny JSON "database" ----------
let photos = [];
try {
  photos = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

let writeChain = Promise.resolve();
function save() {
  // Serialise writes and write atomically so a crash never leaves a half-written file.
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      const tmp = `${DB_FILE}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(photos, null, 2));
      await fs.rename(tmp, DB_FILE);
    });
  return writeChain;
}

const sorted = () =>
  [...photos].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

// ---------- validation ----------
const isValidDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function cleanTransform(t) {
  if (!t || typeof t !== 'object') return null;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    x: clamp(num(t.x, 0), -2, 2),
    y: clamp(num(t.y, 0), -2, 2),
    scale: clamp(num(t.scale, 1), 0.2, 6),
    rotate: clamp(num(t.rotate, 0), -180, 180),
  };
}

const cleanCaption = (c) => (typeof c === 'string' ? c.trim().slice(0, 200) : '');

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${ALLOWED_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    const err = new Error(
      `Unsupported image type (${file.mimetype || 'unknown'}). Use JPEG, PNG, WebP, GIF or AVIF.`,
    );
    err.status = 415;
    cb(err);
  },
});

// ---------- auth ----------
// Single-user login. The session is a signed, expiring cookie, so no session store is needed.
// Without SESSION_SECRET the key is derived from the password, so changing the password signs everyone out.
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.createHash('sha256').update(`timescope-session:${APP_PASSWORD}`).digest('hex');
const SESSION_COOKIE = 'ts_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const sign = (value) => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
const makeToken = () => {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp)}`;
};
function isValidToken(token) {
  if (typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!/^\d+$/.test(exp || '') || !sig || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
const isSignedIn = (req) => !APP_PASSWORD || isValidToken(readCookie(req, SESSION_COOKIE));
const passwordMatches = (input) => {
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
};

// Brute-force protection: 10 wrong passwords per IP locks that IP out for 15 minutes.
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, resetAt }
function isLockedOut(ip) {
  const f = failures.get(ip);
  if (f && Date.now() > f.resetAt) failures.delete(ip);
  return (failures.get(ip)?.count ?? 0) >= MAX_FAILURES;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() > f.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + LOCK_MS });
  else f.count++;
}
setInterval(() => {
  for (const [ip, f] of failures) if (Date.now() > f.resetAt) failures.delete(ip);
}, LOCK_MS).unref();

// ---------- app ----------
const app = express();
// Hosting platforms terminate HTTPS at a proxy; trust it so req.secure and req.ip are correct.
if (IS_PROD || process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

app.get('/login', (req, res) => {
  if (isSignedIn(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  if (!APP_PASSWORD) return res.redirect(303, '/');
  if (isLockedOut(req.ip)) return res.redirect(303, '/login?error=locked');
  if (!passwordMatches(req.body?.password ?? '')) {
    recordFailure(req.ip);
    return res.redirect(303, '/login?error=wrong');
  }
  failures.delete(req.ip);
  res.cookie(SESSION_COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_MS,
    path: '/',
  });
  res.redirect(303, '/');
});

app.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect(303, APP_PASSWORD ? '/login' : '/');
});

// Everything below requires a session (the login page's stylesheet is the only exception).
app.use((req, res, next) => {
  if (isSignedIn(req) || req.path === '/styles.css') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  res.redirect('/login');
});

app.get('/api/session', (_req, res) => res.json({ authEnabled: Boolean(APP_PASSWORD) }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { immutable: true, maxAge: '365d' }));

app.get('/api/photos', (_req, res) => {
  res.json(sorted());
});

app.post('/api/photos', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo received.' });
  const { date } = req.body;
  if (!isValidDate(date)) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
  }
  const photo = {
    id: randomUUID(),
    file: req.file.filename,
    originalName: req.file.originalname.slice(0, 255),
    date,
    caption: cleanCaption(req.body.caption),
    transform: { x: 0, y: 0, scale: 1, rotate: 0 },
    createdAt: new Date().toISOString(),
  };
  photos.push(photo);
  await save();
  res.status(201).json(photo);
});

app.patch('/api/photos/:id', async (req, res) => {
  const photo = photos.find((p) => p.id === req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });
  const { date, caption, transform } = req.body ?? {};
  if (date !== undefined) {
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date.' });
    photo.date = date;
  }
  if (caption !== undefined) photo.caption = cleanCaption(caption);
  if (transform !== undefined) {
    const t = cleanTransform(transform);
    if (!t) return res.status(400).json({ error: 'Invalid transform.' });
    photo.transform = t;
  }
  await save();
  res.json(photo);
});

app.delete('/api/photos/:id', async (req, res) => {
  const idx = photos.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Photo not found.' });
  const [photo] = photos.splice(idx, 1);
  await save();
  await fs.unlink(path.join(UPLOAD_DIR, photo.file)).catch(() => {});
  res.status(204).end();
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is larger than 40 MB.' : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`Timescope running at http://localhost:${PORT}`);
  console.log(`Photos are stored in ${DATA_DIR}`);
});

# Timescope

Store photos of yourself over the years and watch them play back as a timelapse.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Requires Node 20+.

## What it does

- **Add photos**: pick files or drag them onto the page. The date is read from the photo's camera (EXIF) data when present, otherwise from the file date. You can check or change every date before uploading.
- **Timeline**: photos are grouped by year, in date order. Click one to change its date, add a note, or delete it.
- **Line up faces**: in the editor, drag, zoom and tilt each photo so your face sits in the same spot. The previous photo is shown faded on top so you can match it, and dashed guides mark the eye line.
- **Timelapse player**: play, pause and scrub, with speed, crossfade, date overlay, loop, and frame shape (square, 4:5, 9:16, 16:9). Add your birthday to show your age on each frame. Keyboard: Space plays or pauses, ←/→ step between photos.
- **Export video**: records the timelapse to an MP4 (or WebM, depending on the browser) and downloads it. Keep the tab visible while it records.

## Where photos are stored

Everything lives in `data/` (ignored by git):

- `data/uploads/`: the original image files
- `data/photos.json`: dates, notes and alignment for each photo

Back up that folder to keep your timeline safe. Set `DATA_DIR=/path/to/folder` to store it somewhere else (for example a synced drive), and `PORT` to change the port.

Supported formats: JPEG, PNG, WebP, GIF, AVIF. iPhone HEIC photos need to be exported as JPEG first. Setting *Settings → Camera → Formats → Most Compatible* on the phone does this automatically.

## Login

Set `APP_PASSWORD` to require a password. Signing in keeps you signed in for 30 days on that browser. After 10 wrong attempts from one address, sign-in is blocked for 15 minutes.

```bash
APP_PASSWORD='a long passphrase' npm start
```

- Without `APP_PASSWORD`, there is no login. That's fine on your own machine.
- With `NODE_ENV=production`, the server refuses to start without a password.
- Changing the password signs out every browser.
- Optionally set `SESSION_SECRET` to a long random string (e.g. `openssl rand -hex 32`).

## Deploying (Railway)

The app saves photos to disk, so the host must provide a **persistent volume**. Without one, every redeploy deletes your photos.

1. Push this folder to a GitHub repository.
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
3. Open the service → **Settings → Volumes → Add volume**, mount path `/data`.
4. **Variables**:
   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_PASSWORD` | a long passphrase |
   | `SESSION_SECRET` | output of `openssl rand -hex 32` |
   | `DATA_DIR` | `/data` |
5. **Settings → Networking → Generate domain**. Optionally set the health check path to `/healthz`.

Railway runs `npm install` and `npm start` automatically and supplies `PORT` and HTTPS.

**Backups:** the volume is the only copy of your photos. Enable Railway's volume backups, or download the photos from time to time.

**Other hosts:** Fly.io (with a volume), Render (with a persistent disk) or any VPS work the same way: set the same variables and point `DATA_DIR` at the persistent disk. Vercel and Netlify won't work, because they can't keep uploaded files.

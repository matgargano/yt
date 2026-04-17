# yt-channel-search

Full-text search across every video in a YouTube channel — or every episode of
a podcast RSS feed — with deep links that jump straight to the matching
timestamp.

Pure Node.js: single Express process, SQLite FTS5 for the index, vanilla JS +
Tailwind CDN for the UI. Local Whisper (`whisper-cli`) transcription fallback
for sources without captions.

## Features

- **YouTube**: paste a channel URL, `@handle`, or `UC…` ID; every upload is
  listed, transcripts fetched, indexed.
- **Podcast**: paste an RSS feed URL (or local path); every episode is ingested
  as a row, then transcribed locally with Whisper.
- Result cards open a sticky player (YouTube iframe or HTML5 `<audio>`) that
  seeks directly to the matched timestamp.
- Per-channel "Transcribe missing" that runs `yt-dlp` + `whisper-cli` for
  captionless videos or `curl` + `ffmpeg` + `whisper-cli` for podcast episodes.
- Killswitch (`READ_ONLY`) + optional admin password for public deployments.
- Atomic DB upload endpoint so you can ingest/transcribe locally and push the
  finished SQLite file to the server.

## Prerequisites

- Node.js 18+.
- A **YouTube Data API v3** key (only required if you ingest YouTube channels).
  Not needed for podcast-only or read-only deployments.
- For local transcription: `yt-dlp`, `ffmpeg`, `whisper-cli`
  (`brew install yt-dlp ffmpeg whisper-cpp`), plus a whisper model file at
  `~/models/whisper/ggml-large-v3.bin` (or another search path — see
  `transcribe.js`).

## Local setup

```bash
npm install
cp .env.example .env            # add YOUTUBE_API_KEY
npm start                       # http://localhost:3000
```

SQLite lives at `data/search.db`. The directory is created on first run.

## Environment variables

| Name               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `YOUTUBE_API_KEY`  | Required for YouTube ingest. Not needed in read-only mode.               |
| `READ_ONLY`        | `true` → hard killswitch. Every mutation route returns 403, admin incl.  |
| `ADMIN_PASSWORD`   | When set (and not read-only), all mutations require HTTP Basic auth.     |
| `PORT`             | Default `3000`.                                                          |
| `WHISPER_MODEL`    | Default `large-v3`.                                                      |

Behavior summary:

- **No flags set** — dev mode, writes wide open.
- **`ADMIN_PASSWORD` only** — writes require the password (sign in from UI).
- **`READ_ONLY=true`** — all writes 403, including admin. Flip off to do work.

---

## Deploying to Fly.io

Fly is a good fit here: Node + native `better-sqlite3` + a persistent volume
for the SQLite file, all on one small machine.

### 0. Install flyctl and sign in

```bash
brew install flyctl
fly auth login
```

### 1. Create the app and volume

From the repo root:

```bash
fly launch --no-deploy --copy-config --name yt-channel-search --region ord
fly volumes create data --size 3 --region ord
```

`--copy-config` uses the repo's `fly.toml` as-is. The volume backs
`/app/data/search.db`.

### 2. Pick a mode and set secrets

Pick **one** of these.

#### Option A — Public, read-only (no writes possible from anyone)

```bash
fly secrets set READ_ONLY=true
```

No API key needed. No admin password needed. The UI shows a "read-only" banner
and hides all admin controls. `GET /api/search` is open; every other route is
403.

To sync data, you turn the killswitch off temporarily (see **Syncing the DB**
below).

#### Option B — Public search, admin writes behind a password (recommended)

```bash
fly secrets set \
  ADMIN_PASSWORD=$(openssl rand -hex 24) \
  YOUTUBE_API_KEY=your-youtube-api-key
```

Save the password — you'll need it to sign in from the UI and to push DBs.
Print it back out with `fly secrets list` (values aren't shown; you'll need to
store it yourself when you set it).

Leave `READ_ONLY` unset. Anonymous users can search; ingest/transcribe/delete
require basic auth.

### 3. Deploy

```bash
fly deploy
fly open
```

First boot will show an empty app — that's expected. Next step pushes your
data.

### 4. Push your local DB up

You've already ingested and transcribed locally (that's where whisper +
yt-dlp live). Upload the finished file:

```bash
curl --fail -u admin:YOUR_ADMIN_PASSWORD \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @data/search.db \
  https://yt-channel-search.fly.dev/api/admin/upload-db
```

Server response includes `"restarting": true` — the process exits and Fly
restarts it against the new file automatically (~2 sec).

If you deployed in **Option A (read-only)**, the upload endpoint is 403. Turn
the killswitch off, upload, turn it back on:

```bash
fly secrets unset READ_ONLY
# upload via curl as above
fly secrets set READ_ONLY=true
```

(Each secret change triggers a restart — ~15s downtime per flip.)

### 5. Verify

Open the app, run a search, confirm results. If you deployed in Option B and
want to admin from the UI, click **Sign in** and paste the admin password; the
password is stored in `localStorage` and attached to admin requests as
`Authorization: Basic …`.

---

## Syncing the DB going forward

Workflow: ingest + transcribe locally, then push up.

```bash
# on your laptop
npm start
# index channels / podcasts, click Transcribe missing, wait
# then:
curl --fail -u admin:$ADMIN_PASSWORD \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @data/search.db \
  https://yt-channel-search.fly.dev/api/admin/upload-db
```

Alternative (no endpoint, bypass app entirely):

```bash
fly ssh sftp shell
> put data/search.db /app/data/search.db
> quit
fly apps restart yt-channel-search
```

---

## API

| Method | Path                         | Auth | Purpose                               |
| ------ | ---------------------------- | ---- | ------------------------------------- |
| GET    | `/api/config`                | —    | `{ read_only, admin_required }`.      |
| GET    | `/api/search?q=…`            | —    | Full-text search results.             |
| GET    | `/api/channels`              | —    | Indexed channels + totals.            |
| GET    | `/api/health`                | —    | Liveness check.                       |
| GET    | `/api/admin/check`           | W    | Validate admin credentials.           |
| POST   | `/api/ingest`                | W    | NDJSON stream. Body `{ channelUrl }`. |
| POST   | `/api/ingest-podcast`        | W    | NDJSON stream. Body `{ rssUrl }`.     |
| POST   | `/api/transcribe-missing`    | W    | NDJSON stream. Body `{ channel_id }`. |
| DELETE | `/api/channels/:channelId`   | W    | Drop a channel + its segments.        |
| POST   | `/api/admin/upload-db`       | W    | Raw SQLite body, atomic swap + exit.  |

`W` = writable: 403 when `READ_ONLY=true`, else requires HTTP Basic auth if
`ADMIN_PASSWORD` is set.

## Project layout

```
yt-channel-search/
  server.js            Express app, auth middleware, routes
  db.js                SQLite + FTS5 setup, helpers, migrations
  ingest.js            YouTube channel resolve + transcript ingest
  ingest-podcast.js    RSS parser + episode ingest
  transcribe.js        yt-dlp / curl + ffmpeg + whisper-cli pipeline
  public/index.html    Single-file UI (Tailwind CDN, vanilla JS)
  Dockerfile
  fly.toml
  data/                SQLite + whisper tmp (mounted volume in prod)
```

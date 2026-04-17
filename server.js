import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { rename, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { search, getChannels, getTotals, deleteChannel } from './db.js';
import { ingestChannel } from './ingest.js';
import { ingestPodcast } from './ingest-podcast.js';
import { transcribeMissing } from './transcribe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve('data');
const DB_PATH = path.join(DATA_DIR, 'search.db');

const READ_ONLY = process.env.READ_ONLY === 'true' || process.env.READ_ONLY === '1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

if (!READ_ONLY && !process.env.YOUTUBE_API_KEY) {
  console.error(
    '\nERROR: YOUTUBE_API_KEY is not set.\n' +
      'Copy .env.example to .env and add a YouTube Data API v3 key, then restart.\n' +
      '(Set READ_ONLY=true to run without a key — search only, no ingest.)\n'
  );
  process.exit(1);
}

if (READ_ONLY) {
  console.log('[server] READ_ONLY=true — all mutations disabled');
}
if (ADMIN_PASSWORD) {
  console.log('[server] ADMIN_PASSWORD set — mutations require basic auth');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireWritable(req, res, next) {
  if (READ_ONLY) {
    return res.status(403).json({ error: 'Server is in read-only mode' });
  }
  if (!ADMIN_PASSWORD) return next();
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Basic' || !token) {
    res.setHeader('WWW-Authenticate', 'Basic realm="admin"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
  if (pass !== ADMIN_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="admin"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  next();
}

function formatTimestamp(secondsInput) {
  const s = Math.floor(Number(secondsInput) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = n => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

app.post('/api/ingest', requireWritable, async (req, res) => {
  const { channelUrl } = req.body || {};
  if (!channelUrl || typeof channelUrl !== 'string') {
    return res.status(400).json({ error: 'channelUrl is required' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = obj => {
    res.write(JSON.stringify(obj) + '\n');
  };

  try {
    for await (const event of ingestChannel(channelUrl)) {
      write(event);
    }
  } catch (e) {
    write({ type: 'error', message: e.message || String(e) });
  } finally {
    res.end();
  }
});

app.post('/api/ingest-podcast', requireWritable, async (req, res) => {
  const { rssUrl } = req.body || {};
  if (!rssUrl || typeof rssUrl !== 'string') {
    return res.status(400).json({ error: 'rssUrl is required' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    for await (const event of ingestPodcast(rssUrl)) {
      write(event);
    }
  } catch (e) {
    write({ type: 'error', message: e.message || String(e) });
  } finally {
    res.end();
  }
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString();
  const channelId = req.query.channel_id
    ? req.query.channel_id.toString()
    : null;

  if (!q.trim()) return res.json({ results: [] });

  try {
    const rows = search(q, channelId);
    const results = rows.map(r => ({
      video_id: r.video_id,
      title: r.title,
      thumbnail_url: r.thumbnail_url,
      start_seconds: r.start_seconds,
      start_seconds_floor: Math.floor(r.start_seconds || 0),
      timestamp: formatTimestamp(r.start_seconds),
      text: r.text,
      snippet: r.snippet,
      published_at: r.published_at,
      channel_id: r.channel_id,
      channel_name: r.channel_name,
      kind: r.kind || 'youtube',
      media_url: r.media_url || null,
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/transcribe-missing', requireWritable, async (req, res) => {
  const body = req.body || {};
  const channelId = body.channel_id || body.channelId || null;
  const videoIds = Array.isArray(body.video_ids) ? body.video_ids : null;
  const model = body.model || undefined;

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    await transcribeMissing({ channelId, videoIds, model }, evt => write(evt));
  } catch (e) {
    write({ type: 'error', message: e.message || String(e) });
  } finally {
    res.end();
  }
});

app.get('/api/channels', (req, res) => {
  try {
    res.json({ channels: getChannels(), totals: getTotals() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/channels/:channelId', requireWritable, (req, res) => {
  try {
    deleteChannel(req.params.channelId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/upload-db', requireWritable, async (req, res) => {
  const tmpPath = DB_PATH + '.upload';
  try {
    await pipeline(req, createWriteStream(tmpPath));
    const info = await stat(tmpPath);
    if (info.size < 4096) {
      await unlink(tmpPath).catch(() => {});
      return res.status(400).json({ error: 'upload too small to be a sqlite db' });
    }
    await rename(tmpPath, DB_PATH);
    for (const ext of ['-wal', '-shm']) {
      await unlink(DB_PATH + ext).catch(() => {});
    }
    res.json({ ok: true, size_bytes: info.size, restarting: true });
    setTimeout(() => {
      console.log('[server] DB swapped, exiting for restart');
      process.exit(0);
    }, 250);
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ read_only: READ_ONLY, admin_required: !!ADMIN_PASSWORD && !READ_ONLY });
});

app.get('/api/admin/check', requireWritable, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`yt-channel-search listening on http://localhost:${PORT}`);
});

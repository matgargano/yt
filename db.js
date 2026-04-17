import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'search.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    title TEXT,
    channel_id TEXT,
    channel_name TEXT,
    published_at TEXT,
    thumbnail_url TEXT,
    transcript_status TEXT DEFAULT 'ok',
    transcript_fail_reason TEXT,
    kind TEXT DEFAULT 'youtube',
    media_url TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);

  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    start_seconds REAL NOT NULL,
    text TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
    text,
    content='segments',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
    INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
  END;
`);

const existingCols = new Set(
  db.prepare('PRAGMA table_info(videos)').all().map(c => c.name)
);
if (!existingCols.has('transcript_status')) {
  db.exec("ALTER TABLE videos ADD COLUMN transcript_status TEXT DEFAULT 'ok'");
}
if (!existingCols.has('transcript_fail_reason')) {
  db.exec('ALTER TABLE videos ADD COLUMN transcript_fail_reason TEXT');
}
if (!existingCols.has('kind')) {
  db.exec("ALTER TABLE videos ADD COLUMN kind TEXT DEFAULT 'youtube'");
}
if (!existingCols.has('media_url')) {
  db.exec('ALTER TABLE videos ADD COLUMN media_url TEXT');
}

const orphanReset = db
  .prepare(
    `UPDATE videos
       SET transcript_status = 'fail',
           transcript_fail_reason = COALESCE(transcript_fail_reason, 'process did not finish')
     WHERE transcript_status = 'transcribing'`
  )
  .run();
if (orphanReset.changes > 0) {
  console.log(
    `[db] reset ${orphanReset.changes} orphaned 'transcribing' row(s) → 'fail'`
  );
}

export function videoExists(id) {
  return !!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(id);
}

const insertVideoStmt = db.prepare(`
  INSERT OR REPLACE INTO videos
    (id, title, channel_id, channel_name, published_at, thumbnail_url,
     transcript_status, transcript_fail_reason, kind, media_url)
  VALUES (@id, @title, @channel_id, @channel_name, @published_at, @thumbnail_url,
          @transcript_status, @transcript_fail_reason, @kind, @media_url)
`);

export function insertVideo(v) {
  insertVideoStmt.run({
    transcript_status: 'ok',
    transcript_fail_reason: null,
    kind: 'youtube',
    media_url: null,
    ...v,
  });
}

const markVideoStatusStmt = db.prepare(
  'UPDATE videos SET transcript_status = ?, transcript_fail_reason = ? WHERE id = ?'
);

export function markVideoStatus(videoId, status, reason = null) {
  markVideoStatusStmt.run(status, reason, videoId);
}

const deleteSegmentsForVideoStmt = db.prepare(
  'DELETE FROM segments WHERE video_id = ?'
);

export function deleteSegmentsForVideo(videoId) {
  deleteSegmentsForVideoStmt.run(videoId);
}

export function getFailedVideos({ channelId = null, videoIds = null } = {}) {
  if (videoIds && videoIds.length) {
    const placeholders = videoIds.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT id, title, channel_id, channel_name, transcript_fail_reason, kind, media_url
         FROM videos WHERE id IN (${placeholders}) ORDER BY published_at DESC`
      )
      .all(...videoIds);
  }
  if (channelId) {
    return db
      .prepare(
        `SELECT id, title, channel_id, channel_name, transcript_fail_reason, kind, media_url
         FROM videos WHERE channel_id = ? AND transcript_status = 'fail'
         ORDER BY published_at DESC`
      )
      .all(channelId);
  }
  return db
    .prepare(
      `SELECT id, title, channel_id, channel_name, transcript_fail_reason, kind, media_url
       FROM videos WHERE transcript_status = 'fail' ORDER BY published_at DESC`
    )
    .all();
}

const insertSegmentStmt = db.prepare(
  'INSERT INTO segments (video_id, start_seconds, text) VALUES (?, ?, ?)'
);

const insertSegmentsTx = db.transaction((videoId, segments) => {
  for (const s of segments) {
    if (!s.text || !s.text.trim()) continue;
    insertSegmentStmt.run(videoId, s.start_seconds, s.text);
  }
});

export function insertSegments(videoId, segments) {
  insertSegmentsTx(videoId, segments);
}

function buildFtsQuery(q) {
  const tokens = q
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/["*()]/g, ''))
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens.map(t => `"${t}"`).join(' ');
}

export function search(query, channelId = null) {
  if (!query || !query.trim()) return [];
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const params = [ftsQuery];
  let sql = `
    SELECT
      v.id          AS video_id,
      v.title       AS title,
      v.thumbnail_url,
      v.published_at,
      v.channel_id,
      v.channel_name,
      v.kind,
      v.media_url,
      s.start_seconds,
      s.text,
      snippet(segments_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet
    FROM segments_fts f
    JOIN segments s ON s.id = f.rowid
    JOIN videos   v ON v.id = s.video_id
    WHERE segments_fts MATCH ?
  `;
  if (channelId) {
    sql += ' AND v.channel_id = ?';
    params.push(channelId);
  }
  sql += ' ORDER BY rank LIMIT 300';

  return db.prepare(sql).all(...params);
}

export function getChannels() {
  return db.prepare(`
    SELECT
      v.channel_id,
      v.channel_name,
      MAX(v.kind) AS kind,
      COUNT(DISTINCT v.id) AS video_count,
      COUNT(s.id)          AS segment_count,
      SUM(CASE WHEN v.transcript_status = 'fail' THEN 1 ELSE 0 END) AS fail_count,
      SUM(CASE WHEN v.transcript_status = 'transcribing' THEN 1 ELSE 0 END) AS transcribing_count
    FROM videos v
    LEFT JOIN segments s ON s.video_id = v.id
    GROUP BY v.channel_id, v.channel_name
    ORDER BY v.channel_name COLLATE NOCASE
  `).all();
}

export function getTotals() {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM videos)   AS videos,
      (SELECT COUNT(*) FROM segments) AS segments
  `).get();
}

export function deleteChannel(channelId) {
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM segments
      WHERE video_id IN (SELECT id FROM videos WHERE channel_id = ?)
    `).run(channelId);
    db.prepare('DELETE FROM videos WHERE channel_id = ?').run(channelId);
  });
  tx();
  db.exec(`INSERT INTO segments_fts(segments_fts) VALUES('rebuild')`);
}

export default db;

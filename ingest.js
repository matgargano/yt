import { YoutubeTranscript } from 'youtube-transcript/dist/youtube-transcript.esm.js';
import { videoExists, insertVideo, insertSegments } from './db.js';

const API = 'https://www.googleapis.com/youtube/v3';

function apiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY is not set');
  return key;
}

async function yt(route, params) {
  const url = new URL(API + route);
  url.searchParams.set('key', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason;
    const message = data?.error?.message || res.statusText;
    const err = new Error(
      reason === 'quotaExceeded'
        ? 'YouTube API quota exceeded'
        : `YouTube API error: ${message}`
    );
    err.reason = reason;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function resolveChannelId(channelUrl) {
  const input = channelUrl.trim();

  const idMatch = input.match(/channel\/(UC[\w-]{20,})/);
  if (idMatch) return idMatch[1];
  if (/^UC[\w-]{20,}$/.test(input)) return input;

  let handle = null;
  const handleInUrl = input.match(/youtube\.com\/@([\w.\-]+)/i);
  if (handleInUrl) handle = handleInUrl[1];
  else if (input.startsWith('@')) handle = input.slice(1);

  if (handle) {
    const data = await yt('/channels', { part: 'id', forHandle: '@' + handle });
    if (data.items?.length) return data.items[0].id;
    const searched = await yt('/search', {
      part: 'snippet',
      type: 'channel',
      q: handle,
      maxResults: '1',
    });
    if (searched.items?.length) return searched.items[0].snippet.channelId;
  }

  const userMatch = input.match(/\/user\/([\w.\-]+)/i);
  if (userMatch) {
    const data = await yt('/channels', { part: 'id', forUsername: userMatch[1] });
    if (data.items?.length) return data.items[0].id;
  }

  const cMatch = input.match(/\/c\/([\w.\-]+)/i);
  if (cMatch) {
    const searched = await yt('/search', {
      part: 'snippet',
      type: 'channel',
      q: cMatch[1],
      maxResults: '1',
    });
    if (searched.items?.length) return searched.items[0].snippet.channelId;
  }

  const fallback = await yt('/search', {
    part: 'snippet',
    type: 'channel',
    q: input,
    maxResults: '1',
  });
  if (fallback.items?.length) return fallback.items[0].snippet.channelId;

  throw new Error(`Could not resolve channel: ${channelUrl}`);
}

async function getChannelMeta(channelId) {
  const data = await yt('/channels', {
    part: 'contentDetails,snippet',
    id: channelId,
  });
  if (!data.items?.length) throw new Error('Channel not found: ' + channelId);
  const item = data.items[0];
  return {
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    channelName: item.snippet.title,
  };
}

async function* listPlaylistVideos(playlistId) {
  let pageToken;
  do {
    const data = await yt('/playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
      pageToken,
    });
    for (const item of data.items || []) {
      const vid = item.contentDetails?.videoId;
      if (!vid) continue;
      const thumbs = item.snippet?.thumbnails || {};
      yield {
        id: vid,
        title: item.snippet?.title || '(untitled)',
        published_at:
          item.contentDetails.videoPublishedAt ||
          item.snippet?.publishedAt ||
          null,
        thumbnail_url:
          thumbs.medium?.url ||
          thumbs.high?.url ||
          thumbs.default?.url ||
          `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
      };
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
}

export async function* ingestChannel(channelUrl) {
  yield { type: 'status', message: `Resolving channel: ${channelUrl}` };

  let channelId;
  try {
    channelId = await resolveChannelId(channelUrl);
  } catch (e) {
    yield { type: 'error', message: e.message };
    return;
  }

  let meta;
  try {
    meta = await getChannelMeta(channelId);
  } catch (e) {
    yield { type: 'error', message: e.message };
    return;
  }

  yield {
    type: 'status',
    message: `Channel: ${meta.channelName} (${channelId}) — fetching video list`,
    channel_id: channelId,
    channel_name: meta.channelName,
  };

  let total = 0;
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for await (const v of listPlaylistVideos(meta.uploadsPlaylistId)) {
      total++;

      if (videoExists(v.id)) {
        skipped++;
        yield { type: 'skip', video_id: v.id, title: v.title };
        continue;
      }

      const baseRow = {
        id: v.id,
        title: v.title,
        channel_id: channelId,
        channel_name: meta.channelName,
        published_at: v.published_at,
        thumbnail_url: v.thumbnail_url,
      };

      try {
        const raw = await YoutubeTranscript.fetchTranscript(v.id);
        const segments = (raw || [])
          .map(r => ({
            start_seconds: Number(r.offset || 0) / 1000,
            text: (r.text || '').replace(/\s+/g, ' ').trim(),
          }))
          .filter(s => s.text.length > 0);

        if (!segments.length) {
          failed++;
          insertVideo({
            ...baseRow,
            transcript_status: 'fail',
            transcript_fail_reason: 'empty transcript',
          });
          yield {
            type: 'fail',
            video_id: v.id,
            title: v.title,
            reason: 'empty transcript',
          };
          continue;
        }

        insertVideo({ ...baseRow, transcript_status: 'ok' });
        insertSegments(v.id, segments);

        indexed++;
        yield {
          type: 'indexed',
          video_id: v.id,
          title: v.title,
          segments: segments.length,
        };
      } catch (e) {
        failed++;
        const reason = (e && e.message) || String(e);
        console.error(`[ingest] ${v.id} failed: ${reason}`);
        try {
          insertVideo({
            ...baseRow,
            transcript_status: 'fail',
            transcript_fail_reason: reason,
          });
        } catch (writeErr) {
          console.error(`[ingest] failed to record fail row for ${v.id}: ${writeErr.message}`);
        }
        yield { type: 'fail', video_id: v.id, title: v.title, reason };
      }
    }
  } catch (e) {
    yield { type: 'error', message: e.message };
  }

  yield {
    type: 'done',
    channel_id: channelId,
    channel_name: meta.channelName,
    total,
    indexed,
    skipped,
    failed,
  };
}

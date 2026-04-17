import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { videoExists, insertVideo } from './db.js';

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function hash(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function parseRSS(xml) {
  const channelBlock = xml.match(/<channel>([\s\S]*?)(?=<item>|<\/channel>)/)?.[1] || xml;
  const channelTitle = decodeEntities(
    channelBlock.match(/<title>([\s\S]*?)<\/title>/)?.[1] || 'Unknown podcast'
  ).trim();
  const channelImage = decodeEntities(
    channelBlock.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>/)?.[1] ||
      channelBlock.match(/<itunes:image[^>]*href="([^"]+)"/)?.[1] ||
      ''
  ).trim();

  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const body = m[1];
    const title = decodeEntities(body.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim();
    const enclosure = (body.match(/<enclosure[^>]*url="([^"]+)"/)?.[1] || '').trim();
    const guidRaw = (body.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || '').trim();
    const pubDate = (body.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
    const itemImage = (body.match(/<itunes:image[^>]*href="([^"]+)"/)?.[1] || '').trim();
    if (!enclosure) continue;
    const guid = guidRaw || enclosure;
    items.push({
      id: 'p_' + hash(guid),
      title: title || '(untitled episode)',
      media_url: enclosure,
      published_at: pubDate ? new Date(pubDate).toISOString() : null,
      thumbnail_url: itemImage || channelImage || null,
    });
  }
  return { channelTitle, channelImage, items };
}

async function loadFeed(input) {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const res = await fetch(trimmed);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${trimmed}`);
    return await res.text();
  }
  return await readFile(trimmed, 'utf8');
}

export async function* ingestPodcast(rssInput) {
  yield { type: 'status', message: `Loading feed: ${rssInput}` };

  let xml;
  try {
    xml = await loadFeed(rssInput);
  } catch (e) {
    yield { type: 'error', message: e.message };
    return;
  }

  const feed = parseRSS(xml);
  const channelId = 'p_' + hash(rssInput);

  yield {
    type: 'status',
    message: `Feed: ${feed.channelTitle} — ${feed.items.length} episodes`,
    channel_id: channelId,
    channel_name: feed.channelTitle,
  };

  let total = 0;
  let indexed = 0;
  let skipped = 0;

  for (const ep of feed.items) {
    total++;

    if (videoExists(ep.id)) {
      skipped++;
      yield { type: 'skip', video_id: ep.id, title: ep.title };
      continue;
    }

    insertVideo({
      id: ep.id,
      title: ep.title,
      channel_id: channelId,
      channel_name: feed.channelTitle,
      published_at: ep.published_at,
      thumbnail_url: ep.thumbnail_url,
      transcript_status: 'fail',
      transcript_fail_reason: 'awaiting transcription',
      kind: 'podcast',
      media_url: ep.media_url,
    });

    indexed++;
    yield { type: 'indexed', video_id: ep.id, title: ep.title };
  }

  yield {
    type: 'done',
    channel_id: channelId,
    channel_name: feed.channelTitle,
    total,
    indexed,
    skipped,
    failed: 0,
  };
}

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  getFailedVideos,
  insertSegments,
  markVideoStatus,
  deleteSegmentsForVideo,
} from './db.js';

const TMP_ROOT = path.resolve('data', 'whisper_tmp');
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const PROGRESS_THROTTLE_MS = 2000;
const DEFAULT_MODEL = process.env.WHISPER_MODEL || 'large-v3';

function which(cmd) {
  return new Promise(resolve => {
    const proc = spawn('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', d => (out += d.toString()));
    proc.on('close', code => resolve(code === 0 ? out.trim() : null));
    proc.on('error', () => resolve(null));
  });
}

async function detectWhisper() {
  if (await which('whisper-cli')) return 'whisper-cli';
  return null;
}

function modelSearchPaths(model) {
  return [
    path.join(os.homedir(), 'models', 'whisper', `ggml-${model}.bin`),
    path.join(process.cwd(), 'models', `ggml-${model}.bin`),
    path.join(os.homedir(), '.cache', 'whisper', `ggml-${model}.bin`),
    `/opt/homebrew/share/whisper-cpp/models/ggml-${model}.bin`,
  ];
}

function findModel(model) {
  for (const p of modelSearchPaths(model)) {
    if (existsSync(p)) return p;
  }
  return null;
}

function runProc(cmd, args, { timeoutMs, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, timeoutMs);
    }
    const handleStream = (stream, key) => {
      let buf = '';
      stream.on('data', d => {
        const chunk = d.toString();
        if (key === 'stderr') stderr += chunk;
        else stdout += chunk;
        if (onLine) {
          buf += chunk;
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) onLine(trimmed);
          }
        }
      });
    };
    handleStream(proc.stdout, 'stdout');
    handleStream(proc.stderr, 'stderr');
    proc.on('error', err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else if (code === null) reject(new Error(`${cmd} killed (timeout)`));
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-1000)}`));
    });
  });
}

async function downloadAudioYoutube(videoId, audioBasePath, log) {
  await runProc(
    'yt-dlp',
    [
      '-x',
      '--audio-format', 'wav',
      '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
      '--no-playlist',
      '--no-warnings',
      '-q',
      '--progress',
      '-o', `${audioBasePath}.%(ext)s`,
      '--', `https://www.youtube.com/watch?v=${videoId}`,
    ],
    { timeoutMs: DOWNLOAD_TIMEOUT_MS, onLine: log }
  );
  const wavPath = `${audioBasePath}.wav`;
  if (!existsSync(wavPath)) {
    throw new Error(`yt-dlp finished but audio file missing: ${wavPath}`);
  }
  const info = await stat(wavPath);
  return { wavPath, sizeMB: (info.size / (1024 * 1024)).toFixed(1) };
}

async function downloadAudioPodcast(mediaUrl, audioBasePath, log) {
  const rawPath = `${audioBasePath}.src`;
  await runProc(
    'curl',
    ['-fSL', '--retry', '3', '--retry-delay', '2', '-o', rawPath, mediaUrl],
    { timeoutMs: DOWNLOAD_TIMEOUT_MS, onLine: log }
  );
  if (!existsSync(rawPath)) {
    throw new Error(`curl finished but source file missing: ${rawPath}`);
  }
  const wavPath = `${audioBasePath}.wav`;
  await runProc(
    'ffmpeg',
    ['-y', '-loglevel', 'warning', '-i', rawPath, '-ar', '16000', '-ac', '1', wavPath],
    { timeoutMs: DOWNLOAD_TIMEOUT_MS, onLine: log }
  );
  if (!existsSync(wavPath)) {
    throw new Error(`ffmpeg finished but wav missing: ${wavPath}`);
  }
  try { await rm(rawPath, { force: true }); } catch {}
  const info = await stat(wavPath);
  return { wavPath, sizeMB: (info.size / (1024 * 1024)).toFixed(1) };
}

async function whisperTranscribe(wavPath, outputBase, modelPath, log) {
  await runProc(
    'whisper-cli',
    ['-m', modelPath, '-oj', '-of', outputBase, '-f', wavPath],
    { timeoutMs: TRANSCRIBE_TIMEOUT_MS, onLine: log }
  );
  const jsonPath = `${outputBase}.json`;
  if (!existsSync(jsonPath)) {
    throw new Error(`whisper-cli produced no JSON at ${jsonPath}`);
  }
  return jsonPath;
}

function parseWhisperJson(raw) {
  const data = JSON.parse(raw);
  const items = Array.isArray(data?.transcription) ? data.transcription : [];
  const segments = [];
  for (const item of items) {
    const msFrom = item?.offsets?.from;
    const text = (item?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = typeof msFrom === 'number' ? msFrom / 1000 : 0;
    segments.push({ start_seconds: start, text });
  }
  return segments;
}

export async function transcribeMissing(
  { channelId = null, videoIds = null, model = DEFAULT_MODEL } = {},
  onEvent = () => {}
) {
  onEvent({ type: 'status', message: `Local Whisper transcription starting (model: ${model})` });

  const ytDlp = await which('yt-dlp');
  if (!ytDlp) {
    onEvent({ type: 'error', message: 'yt-dlp not found in PATH. Install with: brew install yt-dlp' });
    return;
  }
  const ffmpeg = await which('ffmpeg');
  if (!ffmpeg) {
    onEvent({ type: 'error', message: 'ffmpeg not found in PATH. Install with: brew install ffmpeg' });
    return;
  }
  const tool = await detectWhisper();
  if (!tool) {
    onEvent({ type: 'error', message: 'whisper-cli not found in PATH. Install with: brew install whisper-cpp' });
    return;
  }
  const modelPath = findModel(model);
  if (!modelPath) {
    onEvent({
      type: 'error',
      message:
        `Whisper model "${model}" not found. Searched:\n  ` +
        modelSearchPaths(model).join('\n  ') +
        `\nDownload with:\n  mkdir -p ~/models/whisper\n  curl -L -o ~/models/whisper/ggml-${model}.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`,
    });
    return;
  }

  const targets = getFailedVideos({ channelId, videoIds });
  if (!targets.length) {
    onEvent({ type: 'status', message: 'No failed videos to transcribe.' });
    onEvent({ type: 'done', total: 0, indexed: 0, failed: 0 });
    return;
  }

  onEvent({ type: 'status', message: `Found ${targets.length} video(s) to transcribe.` });
  await mkdir(TMP_ROOT, { recursive: true });

  let indexed = 0;
  let failed = 0;

  for (const v of targets) {
    const tmpDir = path.join(TMP_ROOT, v.id);
    const audioBase = path.join(tmpDir, 'audio');
    const outBase = path.join(tmpDir, 'output');

    onEvent({ type: 'start', video_id: v.id, title: v.title });
    markVideoStatus(v.id, 'transcribing', null);

    try {
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });

      let lastDlAt = 0;
      const dlLog = line => {
        if (line.length > 800) return;
        const now = Date.now();
        if (now - lastDlAt < PROGRESS_THROTTLE_MS) return;
        if (!/(%|download|destination|extract)/i.test(line)) return;
        lastDlAt = now;
        onEvent({ type: 'progress', video_id: v.id, message: line });
      };

      let lastWhAt = 0;
      const whLog = line => {
        if (line.length > 800) return;
        const now = Date.now();
        if (now - lastWhAt < PROGRESS_THROTTLE_MS) return;
        if (!/(%|progress)/i.test(line)) return;
        lastWhAt = now;
        onEvent({ type: 'progress', video_id: v.id, message: line });
      };

      onEvent({ type: 'status', message: `↓ ${v.id} downloading audio…` });
      const { wavPath, sizeMB } =
        v.kind === 'podcast'
          ? await downloadAudioPodcast(v.media_url, audioBase, dlLog)
          : await downloadAudioYoutube(v.id, audioBase, dlLog);
      onEvent({ type: 'status', message: `↓ ${v.id} downloaded ${sizeMB} MB` });

      onEvent({ type: 'status', message: `🎙 ${v.id} transcribing with ${tool} (${model})…` });
      const t0 = Date.now();
      const jsonPath = await whisperTranscribe(wavPath, outBase, modelPath, whLog);
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

      const raw = await readFile(jsonPath, 'utf8');
      const segments = parseWhisperJson(raw);

      if (!segments.length) {
        failed++;
        markVideoStatus(v.id, 'fail', 'whisper produced no segments');
        onEvent({ type: 'fail', video_id: v.id, title: v.title, reason: 'whisper produced no segments' });
        continue;
      }

      deleteSegmentsForVideo(v.id);
      insertSegments(v.id, segments);
      markVideoStatus(v.id, 'ok', null);
      indexed++;
      onEvent({
        type: 'indexed',
        video_id: v.id,
        title: v.title,
        segments: segments.length,
        elapsed_seconds: Number(elapsedSec),
      });
    } catch (e) {
      failed++;
      const reason = (e && e.message) || String(e);
      console.error(`[transcribe] ${v.id} failed: ${reason}`);
      markVideoStatus(v.id, 'fail', reason.slice(0, 500));
      onEvent({ type: 'fail', video_id: v.id, title: v.title, reason });
    } finally {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  onEvent({
    type: 'done',
    total: targets.length,
    indexed,
    failed,
    channel_id: channelId,
  });
}

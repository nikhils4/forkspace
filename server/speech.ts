import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from './store.ts';

// Accurate dictation, on this Mac. The browser writes words live while you speak; when you stop,
// the recording is transcribed again by Whisper (whisper.cpp) and that text replaces the live
// one. Nothing leaves the machine. Needs `whisper-cli` (brew install whisper-cpp) and ffmpeg;
// without them dictation keeps working the old way.

const MODEL_NAME = process.env.FORKSPACE_WHISPER_MODEL || 'ggml-large-v3-turbo-q5_0.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
const MODELS = path.join(HOME, 'models');
const MODEL = path.join(MODELS, MODEL_NAME);
const PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function which(name: string): string | null {
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...PATHS]) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

let download: { done: number; total: number; error?: string } | null = null;

export interface SpeechStatus {
  /** ready: Whisper will transcribe. downloading: fetching the model. missing: tools not installed. */
  state: 'ready' | 'downloading' | 'missing';
  progress?: number;
  need?: string[];
  error?: string;
}

export function speechStatus(): SpeechStatus {
  const need = [!which('whisper-cli') && 'whisper-cpp', !which('ffmpeg') && 'ffmpeg'].filter(Boolean) as string[];
  if (need.length) return { state: 'missing', need };
  if (fs.existsSync(MODEL)) return { state: 'ready' };
  if (download && !download.error) return { state: 'downloading', progress: download.total ? download.done / download.total : 0 };
  return { state: 'downloading', progress: 0, error: download?.error };
}

/** Fetch the model once (about 550 MB). Safe to call often. */
export function ensureModel() {
  if (fs.existsSync(MODEL) || (download && !download.error)) return;
  download = { done: 0, total: 0 };
  const part = `${MODEL}.part`;
  void (async () => {
    try {
      fs.mkdirSync(MODELS, { recursive: true });
      const r = await fetch(MODEL_URL);
      if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
      download!.total = Number(r.headers.get('content-length') ?? 0);
      const out = fs.createWriteStream(part);
      for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
        download!.done += chunk.length;
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      }
      await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));
      fs.renameSync(part, MODEL);
      download = null;
      console.log('  Dictation: Whisper model ready');
    } catch (e: any) {
      fs.rmSync(part, { force: true });
      download = { done: 0, total: 0, error: String(e?.message ?? e) };
    }
  })();
}

const run = (cmd: string, args: string[], timeout: number) =>
  new Promise<string>((res, rej) =>
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? rej(new Error(stderr?.toString().slice(-300) || err.message)) : res(stdout.toString()))),
  );

/**
 * Transcribe a recording. `hint` primes Whisper with words it should expect (file names, the
 * project's name, recent requests), which is what fixes most misheard technical terms.
 * Returns null when Whisper isn't available yet.
 */
export async function transcribe(audio: Buffer, opts: { lang?: string; hint?: string }): Promise<string | null> {
  const whisper = which('whisper-cli');
  const ffmpeg = which('ffmpeg');
  if (!whisper || !ffmpeg) return null;
  if (!fs.existsSync(MODEL)) {
    ensureModel();
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-dict-'));
  try {
    const src = path.join(dir, 'in');
    const wav = path.join(dir, 'in.wav');
    fs.writeFileSync(src, audio);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 30_000);
    const lang = /^[a-z]{2}$/.test(opts.lang ?? '') ? opts.lang! : 'auto';
    const args = ['-m', MODEL, '-f', wav, '-l', lang, '-nt', '-np', '-t', String(Math.max(2, Math.min(8, os.cpus().length - 2)))];
    if (opts.hint?.trim()) args.push('--prompt', opts.hint.trim().slice(0, 800));
    const out = await run(whisper, args, 120_000);
    const text = out
      .split('\n')
      .map((l) => l.trim())
      // Whisper's markers for silence or noise.
      .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)[^\]]*\]$/i.test(l) && !/^\((silence|music|noise)\)$/i.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

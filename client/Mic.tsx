import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { getToken, request, toast } from './store.ts';

// Dictation for the message box. The browser's speech recognition writes words as you speak,
// and the audio is recorded at the same time. When you stop, Whisper on this Mac transcribes the
// recording (primed with this project's file names), and that text replaces the live one. Then a
// quick pass fixes names, adds punctuation and drops filler words. Without Whisper, the live text
// gets the quick pass alone.

const Recognition: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
const Recorder: typeof MediaRecorder | null = typeof window !== 'undefined' && 'MediaRecorder' in window ? MediaRecorder : null;
export const micSupported = () => !!Recognition || !!Recorder;
const auth = () => ({ authorization: `Bearer ${getToken() ?? ''}` });

// Once per page: ask whether Whisper is ready (this also starts fetching its model).
let told = false;
function checkWhisper() {
  if (told) return;
  told = true;
  fetch('/api/dictation', { headers: auth() })
    .then((r) => r.json())
    .then((st) => {
      if (st?.state === 'downloading') toast('Getting the speech model for more accurate dictation (about 550 MB, once). Until it is ready, dictation works as before.');
    })
    .catch(() => {});
}

/** Whisper's text for the recording, or null when it isn't available. */
async function whisper(audio: Blob, boardId: string, before: string): Promise<string | null> {
  if (!audio.size) return null;
  const q = new URLSearchParams({ board: boardId, lang: (navigator.language || 'en').slice(0, 2).toLowerCase(), before: before.slice(-600) });
  const r = await Promise.race([
    fetch(`/api/dictation?${q}`, { method: 'POST', body: audio, headers: auth() }).then((x) => x.json()),
    new Promise<null>((res) => setTimeout(() => res(null), 45000)),
  ]).catch(() => null);
  return typeof r?.text === 'string' && r.text.trim() ? r.text.trim() : null;
}

/** Join recognised phrases with exactly one space between them. */
const join = (a: string, b: string) => (!a ? b.replace(/^\s+/, '') : !b ? a : /\s$/.test(a) || /^\s/.test(b) ? a.replace(/\s+$/, '') + ' ' + b.replace(/^\s+/, '') : `${a} ${b}`);

const tidy = (boardId: string, before: string, text: string) =>
  Promise.race([
    request<{ text: string }>({ type: 'tidyDictation', boardId, text, before }).then((r) => r?.text || text),
    new Promise<string>((res) => setTimeout(() => res(text), 9000)),
  ]).catch(() => text);

interface Session {
  /** Stop listening and return the finished text (tidied). Nothing more is written to the box. */
  finish: () => Promise<string>;
}
let active: Session | null = null;

/** Send was pressed while dictating: stop, tidy, and hand back the text to send (null if not dictating). */
export async function stopDictation(): Promise<string | null> {
  const s = active;
  active = null;
  return s ? s.finish() : null;
}

export function MicButton({ text, setText, onStop, boardId }: { text: string; setText: (v: string) => void; onStop?: () => void; boardId: string }) {
  const [state, setState] = useState<'off' | 'on' | 'tidying'>('off');
  const session = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const latest = useRef(text);
  latest.current = text;

  useEffect(() => () => session.current?.abort(), []);
  if (!micSupported()) return null;

  const start = () => {
    const base = text && !/\s$/.test(text) ? `${text} ` : text;
    let finalText = '';
    let earlier = ''; // finished text from earlier recognisers (they restart after pauses)
    let interim = '';
    let userStopped = false;
    let done = false; // no more writes to the box
    let rec: any = null;
    let ended: () => void = () => {};
    const endedP = () => new Promise<void>((res) => (ended = res));
    let waitEnd = Recognition ? endedP() : Promise.resolve();

    // The recording Whisper transcribes when you stop.
    const chunks: Blob[] = [];
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    const recorded = new Promise<Blob>((resolve) => {
      if (!Recorder || !navigator.mediaDevices?.getUserMedia) return resolve(new Blob());
      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then((s) => {
          stream = s;
          if (done || userStopped) {
            s.getTracks().forEach((t) => t.stop());
            return resolve(new Blob());
          }
          const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => Recorder.isTypeSupported?.(t));
          recorder = new Recorder(s, type ? { mimeType: type } : undefined);
          recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          recorder.onstop = () => {
            s.getTracks().forEach((t) => t.stop());
            resolve(new Blob(chunks, { type: recorder?.mimeType }));
          };
          recorder.start(1000);
        })
        .catch(() => resolve(new Blob()));
    });
    const stopRecording = () => {
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        else stream?.getTracks().forEach((t) => t.stop());
      } catch {}
    };
    checkWhisper();

    const listen = () => {
      const r = new Recognition();
      r.lang = navigator.language || 'en-US';
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      // Rebuild from the full list each time: browsers can resend phrases they already finished.
      let mine = '';
      r.onresult = (e: any) => {
        if (done) return;
        mine = '';
        interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) mine = join(mine, t);
          else interim = join(interim, t);
        }
        setText(base + join(join(earlier, mine), interim));
        finalText = join(earlier, mine);
      };
      r.onerror = (e: any) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          userStopped = true;
          toast('Allow the microphone for Forkspace in your browser to dictate.', 'error');
        } else if (e.error === 'network') {
          userStopped = true;
          toast('Dictation needs an internet connection in this browser.', 'error');
        } else if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Dictation stopped: ${e.error}`, 'error');
      };
      // Browsers end recognition after a pause; keep listening until you stop it.
      r.onend = () => {
        if (interim) finalText = join(finalText, interim);
        interim = '';
        earlier = finalText;
        if (!userStopped && !done) {
          try {
            listen();
            return;
          } catch {}
        }
        ended();
      };
      rec = r;
      r.start();
    };

    const wrapUp = async (): Promise<string> => {
      userStopped = true;
      try {
        rec?.stop();
      } catch {}
      stopRecording();
      // Let the last words arrive, but never hang.
      await Promise.race([waitEnd, new Promise((r) => setTimeout(r, 1500))]);
      setState('tidying');
      const audio = await Promise.race([recorded, new Promise<Blob>((r) => setTimeout(() => r(new Blob()), 2000))]);
      const heard = await whisper(audio, boardId, base);
      if (heard) return base + heard;
      const raw = finalText.trim();
      if (!raw) return base.replace(/\s+$/, '');
      const clean = await tidy(boardId, base, raw);
      return base + clean;
    };

    // You pressed stop: tidy, and update the box if you haven't changed it meanwhile.
    const stop = async () => {
      if (active !== sess) return;
      active = null;
      const raw = base + finalText;
      const out = await wrapUp();
      done = true;
      if (latest.current.replace(/\s+$/, '') === raw.replace(/\s+$/, '') || latest.current.startsWith(base + finalText.trim())) setText(out);
      setState('off');
      session.current = null;
      onStop?.();
    };
    const sess: Session = {
      finish: async () => {
        const out = await wrapUp();
        done = true;
        setState('off');
        session.current = null;
        return out;
      },
    };
    active = sess;
    session.current = {
      stop,
      abort: () => {
        done = true;
        userStopped = true;
        stopRecording();
        try {
          rec?.abort();
        } catch {}
      },
    };
    try {
      if (Recognition) listen();
      setState('on');
    } catch {
      active = null;
      session.current = null;
      toast('Could not start the microphone.', 'error');
    }
  };

  return (
    <button
      type="button"
      className={`mic-btn ${state === 'on' ? 'on' : ''} ${state === 'tidying' ? 'tidying' : ''}`}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      disabled={state === 'tidying'}
      onClick={() => (state === 'on' ? session.current?.stop() : state === 'off' && start())}
      aria-label={state === 'on' ? 'Stop dictation' : state === 'tidying' ? 'Fixing what was heard' : 'Dictate'}
      aria-pressed={state === 'on'}
      title={state === 'on' ? 'Listening… click to stop' : state === 'tidying' ? 'Fixing misheard words…' : 'Dictate'}
    >
      {state === 'on' ? (
        <span className="mic-wave" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : state === 'tidying' ? (
        <span className="spinner" />
      ) : (
        <Icon name="mic" size={17} />
      )}
    </button>
  );
}

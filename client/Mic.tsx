import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { request, toast } from './store.ts';

// Dictation for the message box. The browser's speech recognition writes words as you speak;
// when you stop, a quick pass fixes what it misheard (using this project's file names and
// your recent prompts), adds punctuation and drops filler words.

const Recognition: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
export const micSupported = () => !!Recognition;

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
  if (!Recognition) return null;

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
    let waitEnd = endedP();

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
      // Let the last words arrive, but never hang.
      await Promise.race([waitEnd, new Promise((r) => setTimeout(r, 1500))]);
      const raw = finalText.trim();
      if (!raw) return base.replace(/\s+$/, '');
      setState('tidying');
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
        try {
          rec?.abort();
        } catch {}
      },
    };
    try {
      listen();
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

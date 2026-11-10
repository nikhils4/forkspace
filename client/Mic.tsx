import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { toast } from './store.ts';

// Dictation for the message box, with the speech recognition built into the browser
// (Chrome and Safari, the same engines their own dictation uses). Words appear as you speak.

const Recognition: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
export const micSupported = () => !!Recognition;

/** The dictation in progress, if any: sending stops it without writing anything back. */
let active: { cancel: () => void } | null = null;
export function stopDictation() {
  active?.cancel();
  active = null;
}

export function MicButton({ text, setText, onStop }: { text: string; setText: (v: string) => void; onStop?: () => void }) {
  const [on, setOn] = useState(false);
  const rec = useRef<any>(null);
  const base = useRef('');
  const finalText = useRef('');

  useEffect(() => () => rec.current?.abort?.(), []);

  if (!Recognition) return null;

  const stop = () => {
    rec.current?.stop();
  };
  // Send was pressed: stop listening and leave the (now sent, cleared) box alone.
  const cancelled = useRef(false);
  const start = () => {
    const r = new Recognition();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    base.current = text && !/\s$/.test(text) ? `${text} ` : text;
    finalText.current = '';
    r.onresult = (e: any) => {
      if (cancelled.current) return; // sent already: late words never come back into the box
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText.current += t;
        else interim += t;
      }
      setText(base.current + finalText.current + interim);
    };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Allow the microphone for Forkspace in your browser to dictate.', 'error');
      else if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Dictation stopped: ${e.error}`, 'error');
    };
    r.onend = () => {
      setOn(false);
      rec.current = null;
      if (active?.cancel === cancel) active = null;
      if (cancelled.current) return;
      setText((base.current + finalText.current).replace(/\s+$/, ''));
      onStop?.();
    };
    cancelled.current = false;
    const cancel = () => {
      cancelled.current = true;
      setOn(false);
      try {
        r.abort();
      } catch {}
    };
    active = { cancel };
    rec.current = r;
    try {
      r.start();
      setOn(true);
    } catch {
      toast('Could not start the microphone.', 'error');
    }
  };

  return (
    <button
      type="button"
      className={`mic-btn ${on ? 'on' : ''}`}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (on ? stop() : start())}
      aria-label={on ? 'Stop dictation' : 'Dictate'}
      aria-pressed={on}
      title={on ? 'Listening… click to stop' : 'Dictate'}
    >
      {on ? (
        <span className="mic-wave" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon name="mic" size={17} />
      )}
    </button>
  );
}

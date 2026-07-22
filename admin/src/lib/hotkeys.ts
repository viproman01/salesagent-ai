export type HotkeyHandler = (e: KeyboardEvent) => void;

export interface ChordBinding {
  combo: string;
  handler: HotkeyHandler;
}

export interface SequenceBinding {
  keys: string[];
  handler: HotkeyHandler;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);

function matchCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+').map(s => s.trim());
  const key = parts.pop()!;
  const needMod   = parts.includes('mod');
  const needShift = parts.includes('shift');
  const needAlt   = parts.includes('alt');
  if (needMod && !(isMac ? e.metaKey : e.ctrlKey)) return false;
  if (!needMod && (e.metaKey || e.ctrlKey)) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt   !== e.altKey)   return false;
  return e.key.toLowerCase() === key;
}

const SEQ_TIMEOUT_MS = 1000;

export function attachHotkeys(chords: ChordBinding[], sequences: SequenceBinding[]) {
  let buffer: string[] = [];
  let timer: number | undefined;

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    for (const c of chords) {
      if (matchCombo(e, c.combo)) {
        e.preventDefault();
        c.handler(e);
        buffer = [];
        return;
      }
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      buffer.push(e.key.toLowerCase());
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => { buffer = []; }, SEQ_TIMEOUT_MS);

      for (const s of sequences) {
        if (s.keys.length <= buffer.length) {
          const tail = buffer.slice(-s.keys.length).join('');
          if (tail === s.keys.join('')) {
            e.preventDefault();
            s.handler(e);
            buffer = [];
            return;
          }
        }
      }
    }
  };

  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    if (timer) clearTimeout(timer);
  };
}

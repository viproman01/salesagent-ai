import { useEffect } from 'react';
import { attachHotkeys, type ChordBinding, type SequenceBinding } from '../lib/hotkeys';

export function useHotkeys(chords: ChordBinding[], sequences: SequenceBinding[] = []) {
  useEffect(() => attachHotkeys(chords, sequences), [chords, sequences]);
}

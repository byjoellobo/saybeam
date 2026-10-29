/**
 * Whisper is trained on subtitled video, so on silence, music or room noise it
 * sometimes "hears" stock phrases. We drop a segment only when its entire text
 * is one of these. Phrases a speaker really says ("Thank you.", "Bye.") are not
 * on the list: losing a genuine closing line is worse than an odd extra one.
 */
const STOCK_PHRASES = new Set([
  'you',
  'thanks for watching',
  'thank you for watching',
  'thanks for watching the video',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'music',
  'applause',
  'silence',
  'subtitles by the amara org community',
  'transcribed by https otter ai',
]);

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[[\]()♪♫*.,!?'"…:;-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function isLikelyHallucination(text: string): boolean {
  const n = normalise(text);
  if (!n) return true;
  return STOCK_PHRASES.has(n);
}

/** Collapse a phrase repeated many times in a row ("I'm sorry. I'm sorry. I'm sorry...") to one copy. */
export function collapseRepeats(text: string, maxRepeats = 2): string {
  const words = text.trim().split(/\s+/);
  const same = (a: number, b: number, size: number): boolean => {
    for (let k = 0; k < size; k++) if (words[a + k]?.toLowerCase() !== words[b + k]?.toLowerCase()) return false;
    return true;
  };
  for (let size = 1; size <= 6; size++) {
    const out: string[] = [];
    let i = 0;
    while (i < words.length) {
      let repeats = 1;
      while (i + (repeats + 1) * size <= words.length && same(i, i + repeats * size, size)) repeats++;
      if (repeats > maxRepeats) {
        out.push(...words.slice(i, i + size));
        i += repeats * size;
      } else {
        out.push(words[i] as string);
        i += 1;
      }
    }
    if (out.length < words.length) return collapseRepeats(out.join(' '), maxRepeats);
  }
  return words.join(' ');
}

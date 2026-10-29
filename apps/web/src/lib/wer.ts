/**
 * Word and character error rate, for the field-test bench.
 *
 * WER = (substitutions + deletions + insertions) / reference words, computed
 * with a Levenshtein alignment over normalised tokens. Normalisation follows
 * common ASR practice (case, punctuation, hyphens) and accepts an optional
 * equivalence map for spelling variants that are not errors, which matters for
 * romanised Hindi in code-mixed speech ("nahin" vs "nahi", "ok" vs "okay").
 */
export type AlignOp =
  | { readonly type: 'ok'; readonly ref: string; readonly hyp: string }
  | { readonly type: 'sub'; readonly ref: string; readonly hyp: string }
  | { readonly type: 'del'; readonly ref: string }
  | { readonly type: 'ins'; readonly hyp: string };

export interface WerResult {
  readonly wer: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  readonly refWords: number;
  readonly hypWords: number;
  readonly ops: readonly AlignOp[];
}

export interface NormalizeOptions {
  /** token -> canonical token, applied after lowercasing. */
  readonly equivalences?: Readonly<Record<string, string>>;
  /**
   * Spell out digits ("12" -> "twelve") so "chapter 4" and "chapter four" match.
   * On by default: engines differ in number formatting, not in what they heard.
   */
  readonly spellNumbers?: boolean;
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** English words for 0..999999 ("204" -> "two hundred four"). Larger numbers are left as digits. */
export function numberToWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return null;
  if (n < 20) return ONES[n] ?? null;
  if (n < 100) return [TENS[Math.floor(n / 10)], n % 10 ? ONES[n % 10] : ''].filter(Boolean).join(' ');
  if (n < 1000) return [`${ONES[Math.floor(n / 100)]} hundred`, n % 100 ? numberToWords(n % 100) : ''].filter(Boolean).join(' ');
  return [`${numberToWords(Math.floor(n / 1000))} thousand`, n % 1000 ? numberToWords(n % 1000) : ''].filter(Boolean).join(' ');
}

export function normalizeTokens(text: string, opts: NormalizeOptions = {}): string[] {
  const eq = opts.equivalences ?? {};
  const spell = opts.spellNumbers ?? true;
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/(\d),(?=\d{3}\b)/g, '$1')
      .replace(/[-‐-―/]/g, ' ')
      .replace(/[^\p{L}\p{M}\p{N}'\s]/gu, ' ')
      .split(/\s+/)
      .map((t) => t.replace(/^'+|'+$/g, ''))
      .filter(Boolean)
      .flatMap((t) => {
        const words = spell && /^\d+$/.test(t) ? numberToWords(Number(t)) : null;
        return words ? words.split(' ') : [t];
      })
      // "and" inside spoken numbers ("two hundred and four") is dropped on both sides.
      .filter((t, i, all) => !(t === 'and' && all[i - 1] === 'hundred'))
      .map((t) => eq[t] ?? t)
  );
}

/** Parse "a = b" lines into an equivalence map (both sides lowercased). */
export function parseEquivalences(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(line);
    if (m?.[1] && m[2]) map[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  return map;
}

export function align<T>(ref: readonly T[], hyp: readonly T[], same: (a: T, b: T) => boolean = (a, b) => a === b): Array<'ok' | 'sub' | 'del' | 'ins'> {
  const n = ref.length;
  const m = hyp.length;
  const width = m + 1;
  const d = new Uint32Array((n + 1) * width);
  for (let i = 0; i <= n; i++) d[i * width] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = same(ref[i - 1] as T, hyp[j - 1] as T) ? 0 : 1;
      d[i * width + j] = Math.min((d[(i - 1) * width + j] ?? 0) + 1, (d[i * width + j - 1] ?? 0) + 1, (d[(i - 1) * width + j - 1] ?? 0) + cost);
    }
  }
  const ops: Array<'ok' | 'sub' | 'del' | 'ins'> = [];
  let i = n;
  let j = m;
  // Backtrace preferring exact matches, then deletions/insertions, then
  // substitutions: equal-cost alignments read far better for humans that way.
  while (i > 0 || j > 0) {
    const here = d[i * width + j] ?? 0;
    const diag = i > 0 && j > 0 ? (d[(i - 1) * width + j - 1] ?? 0) : Infinity;
    const isMatch = i > 0 && j > 0 && same(ref[i - 1] as T, hyp[j - 1] as T);
    if (isMatch && here === diag) {
      ops.push('ok');
      i--;
      j--;
    } else if (i > 0 && here === (d[(i - 1) * width + j] ?? 0) + 1) {
      ops.push('del');
      i--;
    } else if (j > 0 && here === (d[i * width + j - 1] ?? 0) + 1) {
      ops.push('ins');
      j--;
    } else {
      ops.push('sub');
      i--;
      j--;
    }
  }
  return ops.reverse();
}

export function wordErrorRate(reference: string, hypothesis: string, opts: NormalizeOptions = {}): WerResult {
  const ref = normalizeTokens(reference, opts);
  const hyp = normalizeTokens(hypothesis, opts);
  const kinds = align(ref, hyp);
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (const k of kinds) {
    if (k === 'ok') ops.push({ type: 'ok', ref: ref[i++] ?? '', hyp: hyp[j++] ?? '' });
    else if (k === 'sub') {
      substitutions++;
      ops.push({ type: 'sub', ref: ref[i++] ?? '', hyp: hyp[j++] ?? '' });
    } else if (k === 'del') {
      deletions++;
      ops.push({ type: 'del', ref: ref[i++] ?? '' });
    } else {
      insertions++;
      ops.push({ type: 'ins', hyp: hyp[j++] ?? '' });
    }
  }
  const errors = substitutions + deletions + insertions;
  return {
    wer: ref.length ? errors / ref.length : hyp.length ? 1 : 0,
    substitutions,
    deletions,
    insertions,
    refWords: ref.length,
    hypWords: hyp.length,
    ops,
  };
}

/** Character error rate over normalised text with spaces removed (useful for scripts without spaces). */
export function charErrorRate(reference: string, hypothesis: string, opts: NormalizeOptions = {}): number {
  const ref = [...normalizeTokens(reference, opts).join('')];
  const hyp = [...normalizeTokens(hypothesis, opts).join('')];
  if (!ref.length) return hyp.length ? 1 : 0;
  const errors = align(ref, hyp).filter((k) => k !== 'ok').length;
  return errors / ref.length;
}

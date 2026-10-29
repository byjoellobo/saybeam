/**
 * Word replacements, a Web Captioner favourite: fix names, jargon and
 * recurring mis-hearings before captions leave the speaker's device.
 * One rule per line: "from => to" (also accepts "->" or "=").
 */
export interface Replacement {
  readonly from: string;
  readonly to: string;
}

export function parseReplacements(text: string): Replacement[] {
  const rules: Replacement[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^(.+?)\s*(?:=>|->|=)\s*(.*)$/.exec(line.trim());
    const from = m?.[1]?.trim();
    if (from && m) rules.push({ from, to: (m[2] ?? '').trim() });
  }
  return rules;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CompiledReplacements {
  readonly apply: (text: string) => string;
  readonly count: number;
}

/**
 * Compile rules once. Matching is case-insensitive on whole words or phrases;
 * longer phrases win over shorter ones that overlap them.
 */
export function compileReplacements(rules: readonly Replacement[]): CompiledReplacements {
  const sorted = [...rules].filter((r) => r.from).sort((a, b) => b.from.length - a.from.length);
  if (!sorted.length) return { apply: (t) => t, count: 0 };
  const key = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ');
  const lookup = new Map(sorted.map((r) => [key(r.from), r.to]));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.map((r) => escapeRegex(r.from).replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return {
    count: sorted.length,
    apply: (text) =>
      text
        .replace(pattern, (match) => lookup.get(key(match)) ?? match)
        .replace(/\s{2,}/g, ' ')
        .trim(),
  };
}

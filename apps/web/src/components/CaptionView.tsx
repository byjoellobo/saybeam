import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PartialCaption, Segment } from '@caption-room/protocol';
import type { ListenerPrefs } from '../lib/storage';

interface CaptionViewProps {
  readonly segments: readonly Segment[];
  readonly partial: PartialCaption | null;
  readonly prefs: ListenerPrefs;
  readonly hasMore: boolean;
  readonly onLoadEarlier: () => void;
  /** Clock offset (server minus local), to show local times. */
  readonly clockOffset: number;
}

const PARAGRAPH_GAP_MS = 5000;
/** Paragraph breaks also fall on fixed seq boundaries, so they do not shift as old lines scroll out of memory. */
const PARAGRAPH_EVERY = 8;
const RENDER_WINDOW = 600;
const STAGE_SEGMENTS = 3;

interface Paragraph {
  readonly key: number;
  readonly segments: Segment[];
}

function toParagraphs(segments: readonly Segment[]): Paragraph[] {
  const out: Paragraph[] = [];
  let prevTs = -Infinity;
  for (const s of segments) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && s.ts - prevTs < PARAGRAPH_GAP_MS && s.seq % PARAGRAPH_EVERY !== 0) last.segments.push(s);
    else out.push({ key: s.seq, segments: [s] });
    prevTs = s.ts;
  }
  return out;
}

/**
 * The listener's caption surface. Follows live text while the reader is at
 * the bottom; once they scroll back to re-read, it stops moving and offers a
 * "jump to live" button with a count of new lines.
 */
export function CaptionView({ segments, partial, prefs, hasMore, onLoadEarlier, clockOffset }: CaptionViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [windowSize, setWindowSize] = useState(RENDER_WINDOW);
  const newestSeen = useRef(segments[segments.length - 1]?.seq ?? 0);
  const jumping = useRef(false);
  const lastSeq = segments[segments.length - 1]?.seq ?? 0;

  const visible = useMemo(() => segments.slice(Math.max(0, segments.length - windowSize)), [segments, windowSize]);
  const paragraphs = useMemo(() => toParagraphs(prefs.layout === 'stage' ? segments.slice(-STAGE_SEGMENTS) : visible), [visible, segments, prefs.layout]);
  const showPartial = prefs.showPartial && partial?.text;
  const newestFinal = segments[segments.length - 1];

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom || prefs.layout === 'stage') el.scrollTop = el.scrollHeight;
  }, [lastSeq, partial?.text, prefs.fontSize, prefs.layout, atBottom]);

  // Count only genuinely new lines (not older history loaded at the top).
  useEffect(() => {
    const prev = newestSeen.current;
    newestSeen.current = Math.max(prev, lastSeq);
    if (atBottom || lastSeq <= prev) return;
    const added = segments.filter((s) => s.seq > prev && s.text).length;
    if (added) setUnseen((n) => n + added);
  }, [lastSeq, atBottom, segments]);

  const jumpToLive = () => {
    const el = scroller.current;
    jumping.current = true;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setAtBottom(true);
    setUnseen(0);
  };

  const timeOf = (s: Segment) => new Date(s.ts - clockOffset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div class="caption-wrap">
      <div
        class={`captions layout-${prefs.layout} align-${prefs.align}`}
        ref={scroller}
        tabIndex={0}
        aria-label="Live captions"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          // Ignore the intermediate scroll events of our own smooth jump to live.
          if (jumping.current) {
            if (bottom) jumping.current = false;
            return;
          }
          if (bottom !== atBottom) setAtBottom(bottom);
          if (bottom) setUnseen(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'End') jumpToLive();
        }}
      >
        {prefs.layout === 'scroll' && (hasMore || segments.length > windowSize) && (
          <div class="load-earlier">
            <button
              type="button"
              class="btn btn-small btn-ghost"
              onClick={() => {
                if (segments.length > windowSize) setWindowSize((n) => n + RENDER_WINDOW);
                else onLoadEarlier();
              }}
            >
              Show earlier captions
            </button>
          </div>
        )}
        {paragraphs.length === 0 && !showPartial && <p class="caption-empty">Waiting for the speaker to start...</p>}
        {paragraphs.map((p) => (
          <p class="caption-para" key={p.key}>
            {prefs.showTimes && p.segments[0] && <span class="caption-time">{timeOf(p.segments[0])}</span>}
            {p.segments.map((s) => (
              <span key={s.seq} class={s.edited ? 'seg edited' : 'seg'}>
                {s.text}{' '}
              </span>
            ))}
          </p>
        ))}
        {showPartial && (
          <p class="caption-para partial" aria-hidden="true">
            {partial?.text}
          </p>
        )}
      </div>
      {!atBottom && prefs.layout === 'scroll' && (
        <button type="button" class="jump-live" onClick={jumpToLive}>
          <span aria-hidden="true">↓</span> Back to live{unseen > 0 ? ` (${unseen} new)` : ''}
        </button>
      )}
      {prefs.announce && (
        <div class="sr-only" aria-live="polite" aria-atomic="true">
          {newestFinal?.text}
        </div>
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PartialCaption, Segment } from '@saybeam/protocol';
import { Icon } from './Icon';
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
/** How long after a gesture the view counts as being moved by the reader. */
const USER_INTENT_MS = 1500;

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
  const scroller = useRef<HTMLElement>(null);
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

  /** Last scroll position we set or saw: layout growth never moves the view up, only the reader does. */
  const lastTop = useRef(0);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  following.current = atBottom || prefs.layout === 'stage';
  /** When the reader last touched, wheeled, clicked or pressed a key here (event timeStamp clock). */
  const lastIntent = useRef(Number.NEGATIVE_INFINITY);
  /** Older captions are being added above: keep the reader where they are. */
  const holdPosition = useRef(false);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const pinToLive = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };

  // Content can grow with no new caption at all: web fonts arriving after the first
  // layout, a rotated phone, a longer partial line. While following, stay on live,
  // but never fight a reader who has just started to scroll back.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!following.current || jumping.current) return;
      if (holdPosition.current) {
        holdPosition.current = false;
        return;
      }
      if (performance.now() - lastIntent.current < USER_INTENT_MS) return;
      pinToLive();
    });
    observer.observe(inner);
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(jumpTimer.current);
    };
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom || prefs.layout === 'stage') {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
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
    // Only flag a jump when there is somewhere to scroll; otherwise no scroll event would clear it.
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
      jumping.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(() => {
        jumping.current = false;
        // Captions may have grown during the smooth scroll: finish on the true bottom.
        if (following.current) pinToLive();
      }, 1500);
    }
    setAtBottom(true);
    setUnseen(0);
  };

  /**
   * Only the reader can stop the captions following. Layout changes (a partial
   * line growing, a webfont arriving) also fire scroll events, but they never
   * move the view up. So following stops when the view moves up (any input:
   * touch, wheel, scrollbar, keyboard, screen reader, find in page) or right
   * after an explicit gesture.
   */
  const markIntent = (e?: Event) => {
    lastIntent.current = e?.timeStamp ?? performance.now();
  };
  const bottomSlack = Math.max(48, prefs.fontSize * prefs.lineHeight * 1.5);

  const timeOf = (s: Segment) => new Date(s.ts - clockOffset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div class="caption-wrap">
      {/* A scrollable region must be keyboard reachable so people can scroll back with arrow keys. */}
      <section
        class={`captions layout-${prefs.layout} align-${prefs.align}`}
        ref={scroller}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions need a tab stop (WCAG 2.1.1)
        tabIndex={0}
        aria-label="Live captions, press End to jump to the latest"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < bottomSlack;
          // Ignore the intermediate scroll events of our own smooth jump to live.
          if (jumping.current) {
            if (bottom) jumping.current = false;
            return;
          }
          const movedUp = el.scrollTop < lastTop.current - 1;
          lastTop.current = el.scrollTop;
          const recentGesture = e.timeStamp - lastIntent.current < USER_INTENT_MS;
          if (!bottom && atBottom && !movedUp && !recentGesture) {
            el.scrollTop = el.scrollHeight; // not the reader: stay pinned to the newest line
            lastTop.current = el.scrollTop;
            return;
          }
          if (bottom !== atBottom) setAtBottom(bottom);
          if (bottom) setUnseen(0);
        }}
        onWheel={markIntent}
        onTouchStart={markIntent}
        onTouchMove={markIntent}
        onPointerDown={markIntent}
        onMouseDown={markIntent}
        onFocusIn={markIntent}
        onKeyDown={(e) => {
          if (e.key === 'End') jumpToLive();
          else markIntent(e);
        }}
      >
        <div class="captions-content" ref={content}>
          {prefs.layout === 'scroll' && (hasMore || segments.length > windowSize) && (
            <div class="load-earlier">
              <button
                type="button"
                class="btn btn-small btn-ghost"
                onClick={() => {
                  holdPosition.current = true;
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
      </section>
      {!atBottom && prefs.layout === 'scroll' && (
        <button type="button" class="jump-live" onClick={jumpToLive}>
          <Icon name="arrowDown" /> Back to live{unseen > 0 ? ` (${unseen} new)` : ''}
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

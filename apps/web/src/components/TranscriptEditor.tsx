import { useEffect, useRef, useState } from 'preact/hooks';
import type { FinalMsg, PartialCaption, Segment } from '@saybeam/protocol';
import { formatTimestamp } from '@saybeam/protocol';

interface TranscriptEditorProps {
  readonly segments: readonly Segment[];
  /** Speaker's finals not yet confirmed by the server. */
  readonly pending?: readonly FinalMsg[];
  readonly partial: PartialCaption | null;
  readonly onCorrect: (seq: number, text: string) => void;
  readonly hasMore?: boolean;
  readonly onLoadEarlier?: () => void;
  readonly emptyHint?: string;
  /** Auto-scroll to the newest line while the reader is at the bottom. */
  readonly follow?: boolean;
}

/**
 * Scrolling transcript where any line can be fixed in place: click or press
 * Enter on a line, edit, Enter to save, Escape to cancel. Empty text removes
 * the line for everyone (useful for Whisper's "Thanks for watching!").
 */
export function TranscriptEditor({ segments, pending = [], partial, onCorrect, hasMore, onLoadEarlier, emptyHint, follow = true }: TranscriptEditorProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const confirmed = new Set(segments.map((s) => s.id));
  const unsent = pending.filter((p) => !confirmed.has(p.id));

  useEffect(() => {
    const el = listRef.current;
    if (el && follow && stick.current && editing === null) el.scrollTop = el.scrollHeight;
  }, [segments.length, unsent.length, partial?.text, editing, follow]);

  // Web fonts arrive after the first layout and make lines taller: stay on the newest line.
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      const el = listRef.current;
      if (live && el && follow && stick.current) el.scrollTop = el.scrollHeight;
    });
    return () => {
      live = false;
    };
  }, [follow]);

  // Focus once when editing starts, not on every live re-render (that would steal focus from Save).
  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);

  const begin = (s: Segment) => {
    setEditing(s.seq);
    setDraft(s.text);
  };
  const commit = (s: Segment) => {
    if (draft.trim() !== s.text) onCorrect(s.seq, draft.trim());
    setEditing(null);
  };

  return (
    <ol
      class="transcript caption-screen"
      ref={listRef}
      aria-label="Transcript"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      {hasMore && onLoadEarlier && (
        <li class="transcript-more">
          <button type="button" class="btn btn-small btn-ghost" onClick={onLoadEarlier}>
            Load earlier lines
          </button>
        </li>
      )}
      {segments.length === 0 && unsent.length === 0 && !partial && <li class="transcript-empty">{emptyHint ?? 'Captions will appear here.'}</li>}
      {segments.map((s) =>
        editing === s.seq ? (
          <li key={s.seq} class="line editing">
            <textarea
              class="line-input"
              value={draft}
              rows={Math.max(2, Math.ceil(draft.length / 60))}
              aria-label={`Edit caption ${s.seq}`}
              ref={inputRef}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commit(s);
                } else if (e.key === 'Escape') setEditing(null);
              }}
            />
            <div class="row gap-sm">
              <button type="button" class="btn btn-small btn-primary" onClick={() => commit(s)}>
                Save
              </button>
              <button type="button" class="btn btn-small" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-small btn-danger"
                onClick={() => {
                  onCorrect(s.seq, '');
                  setEditing(null);
                }}
              >
                Remove line
              </button>
            </div>
          </li>
        ) : (
          <li key={s.seq} class={`line${s.edited ? ' edited' : ''}${s.text ? '' : ' removed'}`}>
            {/* A real button: announced as editable, and Enter or Space work everywhere. */}
            <button type="button" class="line-button" onClick={() => begin(s)} title="Click to correct">
              {s.startMs !== undefined && <span class="line-time">{formatTimestamp(s.startMs, '.').slice(0, 8)}</span>}
              <span class="line-text">{s.text || 'Removed'}</span>
              {s.edited && <span class="badge">edited</span>}
              <span class="sr-only">, correct this line</span>
            </button>
          </li>
        ),
      )}
      {unsent.map((p) => (
        <li key={p.id} class="line unsent" title="Waiting for the connection; will be sent automatically">
          <span class="line-text">{p.text}</span>
          <span class="badge badge-warn">sending</span>
        </li>
      ))}
      {partial?.text && (
        <li class="line partial" aria-hidden="true">
          <span class="line-text">{partial.text}</span>
        </li>
      )}
    </ol>
  );
}

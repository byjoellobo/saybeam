import type { RoomStatus } from '@caption-room/protocol';
import type { ConnectionState } from '../lib/room-client';

interface StatusPillProps {
  readonly connection: ConnectionState;
  readonly status: RoomStatus;
  readonly speakerOnline?: boolean;
  /** Label for the healthy state (the speaker console says "Connected" until captioning starts). */
  readonly liveLabel?: string;
}

/** One compact, screen-reader-friendly line about what is happening. */
export function StatusPill({ connection, status, speakerOnline, liveLabel = 'Live' }: StatusPillProps) {
  let tone: 'live' | 'wait' | 'off' = 'live';
  let label = liveLabel;
  if (connection === 'connecting') {
    tone = 'wait';
    label = 'Connecting';
  } else if (connection === 'reconnecting') {
    tone = 'wait';
    label = 'Reconnecting';
  } else if (connection === 'closed' || connection === 'idle') {
    tone = 'off';
    label = 'Offline';
  } else if (status === 'ended') {
    tone = 'off';
    label = 'Ended';
  } else if (status === 'paused') {
    tone = 'wait';
    label = 'Paused';
  } else if (speakerOnline === false) {
    tone = 'wait';
    label = 'Waiting for speaker';
  }
  return (
    <span class={`pill pill-${tone}`} role="status" aria-live="polite">
      <span class="pill-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { Role } from '@saybeam/protocol';
import { RoomClient, type ClientSnapshot } from './room-client';
import { useReconnectNudges } from './browser';

export interface UseRoomOptions {
  readonly code: string;
  readonly role: Role;
  readonly token?: string | undefined;
  readonly maxSegments?: number;
  /** Skip connecting until this is true (e.g. waiting for a token). */
  readonly enabled?: boolean;
}

export function useRoom(opts: UseRoomOptions): { client: RoomClient; snap: ClientSnapshot } {
  const { code, role, token, maxSegments, enabled = true } = opts;
  const client = useMemo(
    () =>
      new RoomClient({
        code,
        role,
        ...(token ? { token } : {}),
        ...(maxSegments ? { maxSegments } : {}),
        storage: typeof localStorage === 'undefined' ? null : localStorage,
      }),
    [code, role, token, maxSegments],
  );
  const [snap, setSnap] = useState<ClientSnapshot>(client.snapshot);

  useEffect(() => {
    const unsubscribe = client.subscribe(setSnap);
    if (enabled) client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client, enabled]);

  const nudge = useCallback(() => client.nudge(), [client]);
  useReconnectNudges(nudge);
  return { client, snap };
}

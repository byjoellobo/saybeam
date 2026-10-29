import type { CreateRoomRequest, CreateRoomResponse, RoomStatus, ServerInfo } from '@caption-room/protocol';

const TIMEOUT_MS = 12_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'content-type': 'application/json', ...init.headers } });
  } catch {
    throw new ApiError('Could not reach the Caption Room server. Check your connection and try again.', 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `Request failed (${res.status}).`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

let infoPromise: Promise<ServerInfo> | null = null;

/** Cloud or LAN, plus the address listeners should use. Cached for the page's lifetime. */
export function fetchInfo(): Promise<ServerInfo> {
  infoPromise ??= request<ServerInfo>('/api/info').catch(() => ({ mode: 'cloud', version: 'unknown', publicBase: null, localModels: false }) as ServerInfo);
  return infoPromise;
}

export function createRoom(body: CreateRoomRequest): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>('/api/rooms', { method: 'POST', body: JSON.stringify(body) });
}

export interface RoomSummary {
  readonly code: string;
  readonly status: RoomStatus;
  readonly title: string;
}

export function describeRoom(code: string): Promise<RoomSummary> {
  return request<RoomSummary>(`/api/rooms/${encodeURIComponent(code)}`);
}

/** Base URL to put in QR codes and share links. */
export function publicBase(info: ServerInfo | null): string {
  return (info?.publicBase ?? location.origin).replace(/\/$/, '');
}

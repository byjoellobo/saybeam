/**
 * Caption Room wire protocol, version 1.
 *
 * Every frame is a single JSON object with a `t` (type) field. The same
 * protocol is spoken by the Cloudflare Durable Object and by the Rust LAN
 * relay, so the web app never needs to know which one it is talking to.
 * See docs/protocol.md for the prose version.
 */

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Largest accepted inbound frame, in bytes (UTF-16 length is used as a cheap upper bound). */
  maxFrameBytes: 8 * 1024,
  /** Longest caption segment, in characters. */
  maxTextChars: 2000,
  maxTitleChars: 120,
  maxLangChars: 35,
  maxIdChars: 64,
  /** Hard cap on segments per room (well over a full day of speech). */
  maxSegments: 20_000,
  /** Hard cap on stored caption characters per room (a long conference day is about 1M). */
  maxRoomChars: 4_000_000,
  /** Rooms are deleted this long after creation, however active. */
  maxRoomAgeMs: 72 * 60 * 60 * 1000,
  /** Close a connection after this many rejected frames (bad frames or rate limiting). */
  maxStrikes: 20,
  /** Token cost of a history or rotate request (other frames cost 1). */
  historyCost: 10,
  /** How many changed segments a reconnecting client may receive as a delta before we send a full reset instead. */
  resumeLimit: 1000,
  /** Recent segments sent in a fresh welcome. */
  welcomeHistory: 200,
  /** Max segments per history page. */
  historyPage: 500,
  /** Minimum interval between partial broadcasts, ms (server-side throttle). */
  partialMinIntervalMs: 80,
} as const;

export type Role = 'speaker' | 'listener' | 'corrector';
export type RoomStatus = 'live' | 'paused' | 'ended';

export interface Segment {
  /** Server-assigned, strictly increasing from 1. */
  readonly seq: number;
  /** Speaker-assigned id, unique within a room. Links a partial to its final. */
  readonly id: string;
  /** Caption text. An empty string means a corrector removed the segment. */
  readonly text: string;
  /** Server receive time, ms since epoch. */
  readonly ts: number;
  /** Room revision at which this segment last changed. */
  readonly rev: number;
  /** Offset from the start of the speaker's session, ms. Used for SRT/VTT export. */
  readonly startMs?: number;
  readonly endMs?: number;
  readonly edited?: boolean;
}

export interface PartialCaption {
  readonly id: string;
  readonly text: string;
}

export interface RoomMeta {
  readonly title: string;
  readonly lang: string;
  /** When true, listeners may download the transcript. */
  readonly allowExport: boolean;
  readonly createdAt: number;
  /** Listeners need the secret from the QR link, not just the code. */
  readonly private: boolean;
}

export interface Presence {
  readonly listeners: number;
  readonly correctors: number;
  readonly speaker: boolean;
}

export type ErrorCode = 'bad-frame' | 'hello-required' | 'unauthorized' | 'forbidden' | 'not-found' | 'room-ended' | 'room-full' | 'invalid' | 'rate-limited';

/* ----------------------------- client -> server ----------------------------- */

export interface HelloMsg {
  readonly t: 'hello';
  readonly role: Role;
  readonly token?: string;
  /** Last room revision the client has applied. Omit or 0 for a fresh join. */
  readonly since?: number;
  readonly v?: number;
}
export interface PartialMsg {
  readonly t: 'partial';
  readonly id: string;
  readonly text: string;
}
export interface FinalMsg {
  readonly t: 'final';
  readonly id: string;
  readonly text: string;
  readonly startMs?: number;
  readonly endMs?: number;
}
export interface CorrectMsg {
  readonly t: 'correct';
  readonly seq: number;
  readonly text: string;
}
export interface MetaMsg {
  readonly t: 'meta';
  readonly title?: string;
  readonly lang?: string;
  readonly allowExport?: boolean;
}
export interface StatusMsg {
  readonly t: 'status';
  readonly status: 'live' | 'paused';
}
export interface HistoryMsg {
  readonly t: 'history';
  readonly before: number;
  readonly limit?: number;
}
export interface EndMsg {
  readonly t: 'end';
}
export interface PingMsg {
  readonly t: 'ping';
  readonly ts: number;
}
/** Replace a link's secret (speaker only). Everyone using the old link is disconnected. */
export interface RotateMsg {
  readonly t: 'rotate';
  readonly target: LinkTarget;
}
export type LinkTarget = 'corrector' | 'listener';

export type ClientMsg = HelloMsg | PartialMsg | FinalMsg | CorrectMsg | MetaMsg | StatusMsg | HistoryMsg | EndMsg | PingMsg | RotateMsg;

/* ----------------------------- server -> client ----------------------------- */

export interface WelcomeMsg {
  readonly t: 'welcome';
  readonly v: number;
  readonly room: string;
  readonly role: Role;
  readonly meta: RoomMeta;
  readonly status: RoomStatus;
  /** `append`: merge into what you have. `replace`: discard local segments first. */
  readonly mode: 'append' | 'replace';
  readonly segments: readonly Segment[];
  readonly partial: PartialCaption | null;
  /** True when older segments exist before the first one sent. */
  readonly hasMore: boolean;
  readonly rev: number;
  readonly presence: Presence;
  readonly serverTime: number;
}
export interface ServerPartialMsg {
  readonly t: 'partial';
  readonly id: string;
  readonly text: string;
}
export interface ServerFinalMsg {
  readonly t: 'final';
  readonly seg: Segment;
}
export interface ServerCorrectMsg {
  readonly t: 'correct';
  readonly seq: number;
  readonly text: string;
  readonly rev: number;
  readonly by: Role;
}
export interface ServerMetaMsg {
  readonly t: 'meta';
  readonly meta: RoomMeta;
}
export interface ServerStatusMsg {
  readonly t: 'status';
  readonly status: RoomStatus;
}
export interface ServerHistoryMsg {
  readonly t: 'history';
  readonly segments: readonly Segment[];
  readonly hasMore: boolean;
}
export interface PresenceMsg {
  readonly t: 'presence';
  readonly presence: Presence;
}
export interface ErrorMsg {
  readonly t: 'error';
  readonly code: ErrorCode;
  readonly message: string;
}
export interface PongMsg {
  readonly t: 'pong';
  readonly ts: number;
  readonly serverTime: number;
}
export interface RotatedMsg {
  readonly t: 'rotated';
  readonly target: LinkTarget;
  readonly token: string;
}

export type ServerMsg =
  | WelcomeMsg
  | ServerPartialMsg
  | ServerFinalMsg
  | ServerCorrectMsg
  | ServerMetaMsg
  | ServerStatusMsg
  | ServerHistoryMsg
  | PresenceMsg
  | ErrorMsg
  | PongMsg
  | RotatedMsg;

/** WebSocket close codes used by Caption Room (4000-4999 is the application range). */
export const CLOSE = {
  replaced: 4001,
  unauthorized: 4003,
  notFound: 4004,
  badFrame: 4400,
  expired: 4410,
} as const;

/** Literal keepalive frame. The Durable Object answers it without waking up. */
export const KEEPALIVE_PING = 'ping';
export const KEEPALIVE_PONG = 'pong';

/** HTTP API shapes. */
export interface CreateRoomRequest {
  readonly title?: string;
  readonly lang?: string;
  readonly allowExport?: boolean;
  /** Require the listener secret (carried in the QR link) to join. */
  readonly private?: boolean;
}
export interface CreateRoomResponse {
  readonly code: string;
  readonly speakerToken: string;
  readonly correctorToken: string;
  /** Present only for private rooms. */
  readonly listenerToken?: string;
}
export interface ServerInfo {
  readonly mode: 'cloud' | 'lan';
  readonly version: string;
  /** Base URL listeners should use (for QR codes). On LAN this is the laptop's LAN address. */
  readonly publicBase: string | null;
  /** True when the relay serves speech models from /models/ for offline use. */
  readonly localModels: boolean;
}

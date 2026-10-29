import type { Room } from './room';

export interface Env {
  readonly ROOMS: DurableObjectNamespace<Room>;
  readonly ASSETS: Fetcher;
  /** Optional so local tests and self-hosters without the binding still work. */
  readonly CREATE_LIMITER?: RateLimit;
  /** Room lookups and WebSocket joins, per client network. */
  readonly JOIN_LIMITER?: RateLimit;
  readonly APP_VERSION?: string;
}

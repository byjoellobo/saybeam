# Caption Room wire protocol (v1)

Two servers implement this protocol and must stay identical from a client's point of view:

- **Cloud**: a Cloudflare Worker plus one Durable Object per room (`apps/worker`), with the room rules in `packages/protocol/src/room-core.ts`.
- **LAN**: a small Rust relay that runs on the teacher's laptop (`relay/`).

The web app always talks to its own origin (`location.origin`), so it does not care which server it is on.

## HTTP API

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /api/info` | | `200 ServerInfo` |
| `POST /api/rooms` | `CreateRoomRequest` (JSON, may be `{}`), sent with `content-type: application/json` | `201 CreateRoomResponse`, `400 {error}`, `413 {error}`, `415 {error}`, `429 {error}` |
| `GET /api/rooms/:code` | | `200 {code, status, title}` or `404 {error}` |
| `GET /ws/:code` | WebSocket upgrade | `101`, `404` if the room does not exist, `426` if not an upgrade |

```ts
interface ServerInfo { mode: 'cloud' | 'lan'; version: string; publicBase: string | null; localModels: boolean }
interface CreateRoomRequest { title?: string /* <=120 */; lang?: string /* BCP-47 */; allowExport?: boolean }
interface CreateRoomResponse { code: string; speakerToken: string; correctorToken: string }
```

- `publicBase`: the URL listeners should open (used for QR codes). On LAN this is `http://<laptop-lan-ip>:<port>`. `null` in the cloud (the client uses `location.origin`).
- `localModels`: `true` when the relay serves speech model files under `/models/` so on-device engines work without internet.
- Room codes: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Servers must reject anything else with 404 before touching storage.
- Tokens: 32 random bytes, base64url without padding (43 chars). Servers store only the SHA-256 hex digest.
- Rate limit room creation per client IP (cloud: 10 per minute; LAN: not needed). IPv6 clients are keyed by their /64.
- Requiring `application/json` forces a CORS preflight, so other sites cannot create rooms from a visitor's browser.
- Cloud: room lookups and WebSocket joins are also rate limited per client network (600 per minute, generous because a whole school can share one public IP).

## WebSocket

Text frames only. Each frame is one JSON object with a `t` field. Max inbound frame: 8 KiB. Binary frames are rejected with `error bad-frame`.

**Keepalive**: clients send the literal text `ping` every 30 s; the server replies with the literal text `pong` (the Durable Object does this without waking up). This is separate from the JSON `ping` below, which measures round-trip time.

### Shared types

```ts
type Role = 'speaker' | 'listener' | 'corrector';
type RoomStatus = 'live' | 'paused' | 'ended';
interface Segment { seq: number; id: string; text: string; ts: number; rev: number; startMs?: number; endMs?: number; edited?: boolean }
interface RoomMeta { title: string; lang: string; allowExport: boolean; createdAt: number }
interface Presence { listeners: number; correctors: number; speaker: boolean }
```

- `seq`: assigned by the server, starts at 1, strictly increasing.
- `id`: assigned by the speaker, unique per room, `^[A-Za-z0-9_.:-]{1,64}$`. Links a partial to its final.
- `rev`: the room revision at which this segment last changed. The room keeps one counter, bumped by every new final and every correction.
- `text === ''` means a corrector removed the segment. Clients hide it.

### Client to server

| `t` | Fields | Who | Effect |
| --- | --- | --- | --- |
| `hello` | `role`, `token?`, `since?`, `v?` | anyone, must be first | Join. Speaker needs the speaker token. Corrector needs the corrector token **or** the speaker token. `since` is the last `rev` the client applied. |
| `partial` | `id`, `text` (<=2000) | speaker | In-progress caption. Not stored. Broadcast to everyone except the sender. Empty `text` clears it. |
| `final` | `id`, `text` (<=2000, non-empty after trim), `startMs?`, `endMs?` | speaker | Stored and broadcast to **all** (including the sender). Idempotent by `id`. |
| `correct` | `seq`, `text` | speaker, corrector | Replace a stored segment's text. Empty text removes it. Broadcast to all. Allowed after `ended`. |
| `meta` | `title?`, `lang?`, `allowExport?` | speaker | Merge into room meta, broadcast `meta` to all. |
| `status` | `status: 'live' \| 'paused'` | speaker | Broadcast `status`. Pausing clears the partial. |
| `history` | `before` (seq), `limit?` (<=500, default 200) | anyone joined | Reply with older segments. |
| `end` | | speaker | Status becomes `ended`, broadcast `status`. Further `partial`/`final`/`status` get `error room-ended`. |
| `ping` | `ts` | anyone joined | Reply `pong {ts, serverTime}`. |

### Server to client

| `t` | Fields | Sent when |
| --- | --- | --- |
| `welcome` | `v`, `room`, `role`, `meta`, `status`, `mode`, `segments`, `partial`, `hasMore`, `rev`, `presence`, `serverTime` | reply to a valid `hello` |
| `partial` | `id`, `text` | speaker partial (empty `text` = clear) |
| `final` | `seg` | new final (to all), or the stored copy (to the sender only) for a duplicate `id` |
| `correct` | `seq`, `text`, `rev`, `by` | a correction |
| `meta` | `meta` | meta changed |
| `status` | `status` | status changed |
| `history` | `segments`, `hasMore` | reply to `history` |
| `presence` | `presence` | after joins and leaves, debounced to at most one per ~1.5 s |
| `error` | `code`, `message` | see codes below |
| `pong` | `ts`, `serverTime` | reply to JSON `ping` |

### Welcome and resume

On `hello`, the server builds the snapshot:

1. If `since > 0`, `since <= room.rev`, and at most **1000** segments have `rev > since`: `mode: 'append'`, `segments` = every segment with `rev > since`, ascending by `seq`, and `hasMore: false`. The client merges them by `seq`, keeping the higher `rev`.
2. Otherwise `mode: 'replace'`: the newest **200** segments for listeners, **2000** for speaker and corrector, ascending, with `hasMore` = older segments exist.

`presence` in the welcome includes the joining connection. `partial` is the current partial or `null`.

### Rules

- Any frame before a successful `hello` (other than another `hello`) gets `error hello-required`. A second `hello` gets `error invalid`.
- Unknown room on `hello`: send `error not-found`, then close with code **4004**.
- Bad or missing token for speaker or corrector: send `error unauthorized`, then close with code **4003**.
- **The newest speaker wins**: when a speaker joins, every other speaker connection is closed with code **4001** ("replaced").
- When the speaker disconnects and a partial exists, broadcast `partial {id, text: ''}` to the others.
- Partials are throttled server-side: if the last broadcast partial was less than 80 ms ago, store the new one but do not broadcast it.
- A room holds at most 20,000 segments and 4,000,000 characters of caption text; past that a `final` (or a correction that grows the text) gets `error room-full`.
- **Text cleaning**: in `partial`, `final`, `correct` text and in titles, runs of control characters (U+0000 to U+001F, U+007F) become one space, and bidi override characters (U+202A to U+202E, U+2066 to U+2069) are removed, then the text is trimmed. Captions are single-line plain text, and exported SRT/VTT files cannot be given extra cues.
- An empty `partial` clears the stored partial only when its `id` matches.
- When a speaker connection closes while another speaker connection is still open (it was replaced), the partial is left alone.
- Per-connection token-bucket rate limits (capacity / refill per second): speaker 60/30, corrector 30/10, listener 20/4, not-yet-joined 5/1. Every frame costs 1 token, a `history` request costs 10. Over the limit: `error rate-limited`, the frame is dropped. The bucket starts full again after a successful `hello`.
- A frame over 8 KiB gets `error bad-frame` and the connection is closed with **4400**. After 20 rejected frames (`bad-frame` or `rate-limited`) the connection is closed with **4400**.
- When the speaker has set `allowExport: false`, listeners get `error forbidden` for `history`: they keep only the live window from their welcome.
- Connections that do not send `hello` promptly are closed with **1008** (cloud: 20 s, LAN: 30 s). Clients treat 1008 like any other drop and reconnect.
- Error codes: `bad-frame`, `hello-required`, `unauthorized`, `forbidden`, `not-found`, `room-ended`, `room-full`, `invalid`, `rate-limited`.
- Cloud rooms expire 24 hours after the last final, correction, or end, and never live longer than 72 hours. A Durable Object for a code that was never created writes nothing. A room accepts at most 5,000 sockets (`503` after that). The LAN relay keeps rooms in memory until it exits.

### Close codes

| Code | Meaning |
| --- | --- |
| 4001 | Replaced by a newer speaker connection |
| 4003 | Unauthorized |
| 4004 | Room not found |
| 4400 | Oversized frame, or too many rejected frames |
| 4410 | Room expired |

## Example session

```text
speaker  -> {"t":"hello","role":"speaker","token":"<43 chars>"}
speaker  <- {"t":"welcome","v":1,"room":"K7QF3M","role":"speaker","mode":"replace","segments":[],"rev":0,...}
listener -> {"t":"hello","role":"listener"}
listener <- {"t":"welcome",...,"presence":{"listeners":1,"correctors":0,"speaker":true}}
speaker  -> {"t":"partial","id":"s1a2-1","text":"good morning every"}
listener <- {"t":"partial","id":"s1a2-1","text":"good morning every"}
speaker  -> {"t":"final","id":"s1a2-1","text":"Good morning, everyone.","startMs":0,"endMs":1800}
both     <- {"t":"final","seg":{"seq":1,"id":"s1a2-1","text":"Good morning, everyone.","ts":1761700000000,"rev":1,"startMs":0,"endMs":1800}}
listener drops, reconnects with since=1, gets mode "append" with anything newer.
```

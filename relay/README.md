# Saybeam LAN relay

A small server that runs on a teacher's laptop so live captions work in a
school with weak or no internet. The speaker's browser on the laptop
transcribes speech and sends captions to the relay; every student phone on the
same Wi-Fi joins with a room code (or by scanning a QR code) and reads along.

It speaks exactly the same protocol as the cloud server (a Cloudflare Durable
Object), described in [`docs/protocol.md`](../docs/protocol.md), and it serves
the same web app, so nothing in the app changes between cloud and classroom.

- One binary, no installer, no database. Rooms live in memory until the relay stops.
- The web app is embedded in the binary.
- Optional: serve the on-device speech models from the laptop too, for fully offline use.
- The same binary (or the Docker image) can also run as an internet-facing
  server behind HTTPS: see [docs/self-hosting.md](../docs/self-hosting.md).

## Download

Prebuilt binaries for Windows (x64), macOS (Apple silicon and Intel) and Linux
(x64) are attached to every release on
[GitHub Releases](https://github.com/byjoellobo/saybeam/releases). Each
archive holds the `saybeam-relay` program, this README and the licenses;
`SHA256SUMS` lists the checksums. Unpack it and run the program: there is
nothing to install.

- **Windows**: SmartScreen may warn about an unknown publisher the first time.
  Choose "More info", then "Run anyway".
- **macOS**: if Gatekeeper refuses to open it, run
  `xattr -d com.apple.quarantine saybeam-relay` in Terminal, in the
  folder you unpacked.

A Docker image is published as `ghcr.io/byjoellobo/saybeam` for servers:

```sh
docker run -p 7300:7300 ghcr.io/byjoellobo/saybeam
```

## Build from source

You need Node 22+ and Rust (stable). From the repository root:

```sh
npm install
npm run build                                              # builds apps/web/dist
cargo build --release --manifest-path relay/Cargo.toml     # embeds it into the relay
```

or both at once with `npm run build:relay`. The binary is
`relay/target/release/saybeam-relay` (`.exe` on Windows). Copy it anywhere;
it has no other files.

Build the web app **first**: the relay embeds whatever is in `apps/web/dist` at
compile time. A relay built without it still runs, but its home page only
explains how to build the app.

**Windows build tools.** The default Rust toolchain on Windows (`msvc`) needs
the "Desktop development with C++" workload from
[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
for its linker. Alternatively use the GNU toolchain
(`rustup toolchain install stable-x86_64-pc-windows-gnu`) together with a full
MinGW-w64 install (for example from MSYS2) on your `PATH`.

## Run

```sh
saybeam-relay
```

The relay prints where everyone should go:

```text
  Saybeam LAN relay v0.1.0

  Speaker:  open http://localhost:7300 on THIS laptop
            (browsers only allow the microphone on localhost or HTTPS)
  Audience: http://192.168.1.23:7300

  (QR code of the audience address)
  Students: scan the code or type the audience address.
```

### Flags

| Flag                   | Default         | Meaning                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <PORT>`        | `7300`          | TCP port to listen on.                                                                                                                                                                                                                                                              |
| `--bind <IP>`          | `0.0.0.0`       | Address to listen on. `0.0.0.0` accepts phones on every network the laptop is on. `127.0.0.1` is for testing only (phones cannot connect).                                                                                                                                          |
| `--public-host <HOST>` | detected LAN IP | The address students should use, if the detected one is wrong (for example when the laptop has several network adapters). Accepts `192.168.1.23`, `laptop.local`, `10.0.0.5:80` or a full `http://...` URL. It is used for the QR code and returned as `publicBase` by `/api/info`. |
| `--models-dir <DIR>`   | none            | Folder of speech model files to serve at `/models/`, for fully offline classrooms (see below).                                                                                                                                                                                      |
| `--web-dir <DIR>`      | embedded app    | Serve the web app from a folder instead of the copy inside the binary. Handy while developing the web app (`--web-dir apps/web/dist`).                                                                                                                                              |

Set `RUST_LOG=saybeam_relay=debug` for connection-level logs.

## Using it in a classroom

1. **Get everyone on one network.** Either connect the laptop to the school
   Wi-Fi that students use, or turn on the laptop's own hotspot (Windows:
   Settings, Network and internet, Mobile hotspot) and have students join it.
   No internet connection is needed either way.
2. **Start the relay** on the laptop.
3. **Speaker:** on the same laptop, open `http://localhost:7300` and start a
   room. It has to be `localhost`: browsers only allow microphone access on
   `localhost` or on HTTPS sites, and a LAN address like `http://192.168.1.23`
   is neither.
4. **Students:** scan the QR code from the terminal (or from the speaker page)
   or type the audience address, then enter the room code. Captions appear live;
   a phone that drops off the Wi-Fi catches up automatically when it reconnects.

### Private rooms

A room can be created as **private**. Then the code alone is not enough to
join: students need the link (or QR code) from the speaker page, which carries
a secret. The room's title is hidden from anyone who only knows the code.

If a link leaks, the speaker can **replace** it from the speaker page: the old
listener (or corrector) link stops working at once, everyone using it is
disconnected, and the speaker shares the new link or QR code. This works for
the corrector link in every room, and for the listener link in private rooms.

Some school networks isolate devices from each other ("client isolation"), so
phones cannot reach the laptop even though both are online. If that happens,
use the laptop's hotspot instead.

### Windows firewall

The first time the relay starts, Windows Defender Firewall asks whether to
allow it. Allow it on **Private** networks, and on **Public** networks too if
the school Wi-Fi is marked as public. If you dismissed the prompt or phones
cannot connect, allow inbound TCP on the relay's port from an administrator
PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Saybeam relay" -Direction Inbound -Protocol TCP -LocalPort 7300 -Action Allow
```

On macOS, accept the "allow incoming connections" prompt. On Linux, open the
port in `ufw` or `firewalld` if a firewall is active.

## Offline speech models

On-device speech engines normally download their model files (tens to hundreds
of MB) from the internet the first time they run. To make a classroom fully
offline, download them once while you still have internet:

```sh
node scripts/fetch-models.mjs --out relay/models
```

then start the relay with them:

```sh
saybeam-relay --models-dir relay/models
```

`/api/info` then reports `localModels: true`, and the web app loads the models
and the ONNX Runtime WebAssembly files from `http://<laptop>/models/...`
instead of the internet. The banner shows whether a models folder is being
served.

## How it works

- `GET /api/info`, `POST /api/rooms`, `GET /api/rooms/{code}` and
  `GET /ws/{code}` behave as in [`docs/protocol.md`](../docs/protocol.md).
  `POST /api/rooms` requires `content-type: application/json` (415 otherwise),
  which stops other websites from creating rooms through a visitor's browser.
  Room creation is not rate limited on the LAN, but the relay holds at most 200
  rooms, each with at most 20,000 captions and 4,000,000 characters.
- Every other `GET` serves the web app, falling back to `index.html` for
  client-side routes. `index.html` is revalidated on every load; hashed files
  under `/assets/` are cached for a year.
- All responses carry `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless` (the speaker page runs speech
  models on multi-threaded WebAssembly, which needs cross-origin isolation),
  plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
  Model files also get `Cross-Origin-Resource-Policy: same-origin`.
- Room rules (resume with `since`, idempotent finals, corrections, rate limits,
  partial throttling, the newest speaker replacing older ones, text cleaning)
  mirror `packages/protocol/src/room-core.ts` line for line. Captions and
  titles are stored as single-line plain text: control characters become
  spaces and bidi override characters are removed.
- Abusive clients are cut off: a frame over 8 KiB, or 20 rejected frames
  (malformed or rate-limited), closes the connection with code 4400.
- Each connection has a bounded outgoing queue. A phone that cannot keep up is
  dropped and simply resumes from where it left off when it reconnects, so one
  slow device never delays everyone else.
- Silent connections are dropped after 2 minutes (clients send a keepalive
  every 30 seconds), and connections that never join a room are closed after
  30 seconds.
- Ended rooms that nobody has used for 24 hours are removed from memory. All
  rooms disappear when the relay stops.
- Room secrets (speaker, corrector and, for private rooms, listener links) are
  32 random bytes; the relay keeps only their SHA-256 hashes.

## Docker

The repository's `Dockerfile` builds the web app and the relay into one small
image that runs as a non-root user on port 7300:

```sh
docker build -t saybeam .
docker run -p 7300:7300 saybeam
# with offline models: mount them and pass --models-dir
docker run -p 7300:7300 -v ./relay/models:/models:ro saybeam \
  --bind 0.0.0.0 --port 7300 --models-dir /models
```

Arguments after the image name replace the defaults, so repeat
`--bind 0.0.0.0 --port 7300`. Inside a container the relay cannot see the
host's LAN address, so pass `--public-host` with the address students should
use. HTTPS with Caddy and docker compose are covered in
[docs/self-hosting.md](../docs/self-hosting.md).

## Development

```sh
cargo test --manifest-path relay/Cargo.toml                    # unit and integration tests
cargo clippy --manifest-path relay/Cargo.toml --all-targets
node scripts/conformance.mjs http://127.0.0.1:7300            # protocol conformance, against a running relay
```

The conformance script runs the same checks against the cloud server
(`wrangler dev`), which keeps the two implementations in step.

Source layout (`relay/src`):

| File                  | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `protocol.rs`         | Wire types and limits (mirrors `messages.ts`).                         |
| `validate.rs`         | Parsing and validation of untrusted input (mirrors `schema.ts`).       |
| `codes.rs`            | Room codes, tokens, token hashing.                                     |
| `room.rs`             | Pure room logic (mirrors `room-core.ts`), unit-tested without sockets. |
| `hub.rs`              | Rooms in memory, connections, fan-out, presence.                       |
| `ws.rs`               | One WebSocket connection: reader, writer, timeouts.                    |
| `http.rs`             | Routes and response headers.                                           |
| `web.rs`, `paths.rs`  | Static files (embedded or from disk) and path safety.                  |
| `net.rs`, `banner.rs` | LAN address detection and the startup banner.                          |
| `cli.rs`, `main.rs`   | Command-line flags and startup.                                        |

## License

Saybeam, including this relay, is free software under the
[GNU Affero General Public License v3.0 or later](../LICENSE)
(`AGPL-3.0-or-later`). If you modify it and let other people use your version
over a network, offer them your source code; see
[docs/self-hosting.md](../docs/self-hosting.md#license-and-your-source-code).

The Rust crates compiled into the relay and their licenses are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). Regenerate it after
changing dependencies:

```sh
node relay/scripts/third_party.mjs          # all release targets
node relay/scripts/third_party.mjs --check  # also fail if a license needs review
```

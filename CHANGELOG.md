# Changelog

All notable changes to Caption Room are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Private rooms.** Listeners need a secret carried in the QR link (`/r/CODE#k=...`) as well as the room code. The secret never reaches servers in a URL, and servers store only its SHA-256 hash.
- **Link rotation.** The speaker can replace the corrector link at any time, and the listener link of a private room. Everyone still using the old link is disconnected.
- **Offline model download button**, so a speaker can fetch an on-device speech model ahead of time and caption without internet later.
- **Continuous integration** on GitHub Actions: lint, type check, unit tests with coverage, the web build, relay tests, protocol conformance against both the Worker and the relay, and end-to-end tests.
- **Prebuilt LAN relay binaries** for Windows, Linux and macOS, attached to each GitHub release.
- **Docker image** of the relay for self-hosting on a server, published to `ghcr.io/mezpos/caption-room`. See [docs/self-hosting.md](docs/self-hosting.md).
- **Playwright end-to-end tests** for the main speaker, listener and corrector flows.
- **Biome** for linting and formatting.
- Contributor guide, code of conduct, security policy, issue forms (including one for sharing `/bench` field-test results), and new docs: [architecture](docs/architecture.md), [deploy](docs/deploy.md) and [choosing an engine](docs/engines.md).

- **Accessibility checks** (axe, WCAG 2.1 AA) on the home page, speaker console, listener view, display settings and corrector view, and a full-pipeline test that feeds a recording through a fake microphone into on-device recognition.
- The join box accepts a pasted private-room link. The app shows a "Source code" link, as the AGPL requires for network use (`CAPTION_ROOM_SOURCE_URL`).
- `THIRD_PARTY_NOTICES.md` (generated from what the build actually bundles) and `relay/THIRD_PARTY_LICENSES.md`.

### Changed

- **License: now AGPL-3.0-or-later** (was MIT). Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/).
- `GET /api/rooms/:code` now reports whether a room is private, and returns an empty title for private rooms.
- Transcript lines in the speaker and corrector views are real buttons, so screen readers announce them as editable.
- The text size buttons say "Smaller" and "Larger" (their accessible names now match what is shown, WCAG 2.5.3).
- Captions are no longer hyphenated automatically.

### Fixed

- The listener view could stop following live captions on its own when a growing partial line or a late webfont changed the layout. Only the reader scrolling now pauses following.
- Opening a private-room link on a page that already showed that room (only the `#k=` part changed) was ignored.
- The projector view has a visible Close button for keyboard users.

## [0.1.0] - 2026-10-29

The first release: shareable live captions that everyone in a room can follow on their own phone, in the cloud or on a school network with no internet.

### Added

- **Speaker console** (`/speak/CODE`)
  - Pluggable speech engines: Moonshine (English) and Whisper (multilingual, including Hindi) running on the device through transformers.js on WebGPU or multi-threaded WebAssembly; the browser's Web Speech API, including Chrome's on-device mode with vocabulary boosting; and a self-hosted WhisperLive server for big events.
  - An engine recommendation based on what the device can do, and a live Performance panel (real-time factor, caption lag, queue depth, partial update interval, server round trip, unsent captions).
  - Room code, QR code, a full-screen view for the projector, and a share link.
  - Word replacements applied before captions leave the device, and a vocabulary list.
  - Click any line to fix it; removing a line removes it everywhere.
  - Transcript export as plain text, SRT, WebVTT or JSON.
  - A human corrector link, and a hand-off link to caption from another device.
  - Captions spoken while the connection is down are kept and sent when it returns.
- **Listener view** (`/r/CODE`)
  - Atkinson Hyperlegible, five high-contrast themes, a font choice, line and letter spacing, bold and ALL CAPS.
  - Scrollback that stops following while you read, then a "Back to live" button with a count of new lines.
  - A "latest lines only" stage layout, the screen kept awake, and optional screen reader and braille announcements.
  - Transcript download when the speaker allows it.
  - Installable PWA that reconnects after Wi-Fi drops and catches up on what it missed, corrections included.
- **Corrector view** (`/fix/CODE`) for keyboard-friendly live editing.
- **Field-test bench** (`/bench`) measuring latency, real-time factor and word error rate per device, engine and speaker, with Indian English, Hinglish, Hindi and names-and-numbers passages, and CSV or JSON export. The two-week study plan is in [docs/risk-tests.md](docs/risk-tests.md).
- **Cloud server:** a Cloudflare Worker with one SQLite-backed Durable Object per room, using the WebSocket Hibernation API. Keepalive pings are answered without waking the object.
- **LAN mode:** a single Rust binary that serves the app and relays captions over school Wi-Fi or a laptop hotspot, prints a QR code, and can serve the speech models too (`scripts/fetch-models.mjs`) so nothing needs the internet.
- **One protocol, two servers:** room rules live in `packages/protocol` and are mirrored by the relay. `scripts/conformance.mjs` checks both, and `scripts/demo-speaker.mjs` simulates a speaker and a crowd of listeners.
- Resume by revision: a reconnecting client receives exactly what changed, including corrections it missed.

### Security

- Speaker and corrector links carry 256-bit secrets in the URL fragment. Servers store only SHA-256 hashes.
- Every message is validated. Each connection has a token-bucket rate limit, history requests cost extra, and clients that keep sending rejected frames are disconnected.
- Room creation and joins are rate limited per client network in the cloud (IPv6 keyed by /64). Guessing a code that does not exist creates no storage.
- Size caps: 8 KiB frames, 2,000-character captions, 20,000 captions and 4,000,000 characters per room, 5,000 sockets per cloud room, 200 rooms per relay.
- Cloud rooms expire 24 hours after the last activity and live at most 72 hours.
- Caption text and titles are stripped of control and bidi characters, so exported SRT and WebVTT files cannot be given extra cues.
- A strict Content Security Policy that allows scripts only from the app's origin and the exact ONNX Runtime build on jsDelivr.
- Speech models pinned to exact Hugging Face commits.
- A network-first service worker for pages: new deploys are picked up immediately, and a missing or evicted cache can never block loading.

[Unreleased]: https://github.com/mezpos/caption-room/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mezpos/caption-room/releases/tag/v0.1.0

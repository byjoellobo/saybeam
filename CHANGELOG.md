# Changelog

All notable changes to Saybeam are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-03

### Added

- **Private rooms.** Listeners need a secret carried in the QR link (`/r/CODE#k=...`) as well as the room code. The secret never reaches servers in a URL, and servers store only its SHA-256 hash.
- **Link rotation.** The speaker can replace the corrector link at any time, and the listener link of a private room. Everyone still using the old link is disconnected.
- **Offline model download button**, so a speaker can fetch an on-device speech model ahead of time and caption without internet later.
- **Continuous integration** on GitHub Actions: lint, type check, unit tests with coverage, the web build, relay tests, protocol conformance against both the Worker and the relay, and end-to-end tests.
- **Prebuilt LAN relay binaries** for Windows, Linux and macOS, attached to each GitHub release.
- **Docker image** of the relay for self-hosting on a server, published to `ghcr.io/byjoellobo/saybeam`. See [docs/self-hosting.md](docs/self-hosting.md).
- **Playwright end-to-end tests** for the main speaker, listener and corrector flows.
- **Biome** for linting and formatting.
- Contributor guide, code of conduct, security policy, issue forms (including one for sharing `/bench` field-test results), and new docs: [architecture](docs/architecture.md), [deploy](docs/deploy.md) and [choosing an engine](docs/engines.md).
- **Accessibility checks** (axe, WCAG 2.1 AA) on the home page, speaker console, listener view, display settings and corrector view, and a full-pipeline test that feeds a recording through a fake microphone into on-device recognition.
- The join box accepts a pasted private-room link. The app shows a "Source code" link, as the AGPL requires for network use (`SAYBEAM_SOURCE_URL`).
- `THIRD_PARTY_NOTICES.md` (generated from what the build actually bundles) and `relay/THIRD_PARTY_LICENSES.md`.
- **Release automation.** `npm run release -- x.y.z` sets the version in every package, the relay crate and the Worker, and dates this changelog. `npm run version:check`, which CI runs, fails when they disagree. Pushing a version tag publishes the relay archives, a zip of the built web app (`saybeam-web-<version>.zip`), `SHA256SUMS` and build provenance attestations, with the matching section of this changelog as the release notes. See [docs/releasing.md](docs/releasing.md).
- **Cloudflare deploys from GitHub Actions** after each release, or by hand. Clones and forks without Cloudflare credentials skip the deploy instead of failing. See [docs/ci-cd.md](docs/ci-cd.md).
- **CodeQL code scanning** (JavaScript and TypeScript, Rust, and the workflows themselves) and **dependency review** on pull requests.
- A [user guide](docs/user-guide.md) for speakers, listeners and correctors, and an [index of all docs](docs/README.md).

### Changed

- **Renamed from Caption Room to Saybeam.** The npm packages are now `@saybeam/*`, the relay binary is `saybeam-relay` (release archives `saybeam-relay-<version>-<target>`), the Docker image is `ghcr.io/byjoellobo/saybeam`, and browser storage keys start with `saybeam:`. Rooms and settings saved by a Caption Room build are not carried over.
- **A new look.**
  - **Logo:** a yellow speech bubble holding two caption lines and a text cursor.
  - **Type:** Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono, self-hosted variable fonts.
  - **Light and dark:** the home page, speaker console and corrector follow the device's setting.
  - **Listeners:** they keep their own caption themes, and the status colours in the listener bar now follow the chosen theme.
- **The home page headline is shown as a live caption.** Words arrive one by one and end in a text cursor. "Follow captions" and "Start captioning" sit beside it.
- **The live line shows a cursor.** The line still being spoken ends in a text cursor in the speaker transcript and the listener view, instead of being italic.
- **Speaker console:**
  - the transcript panel fills the window;
  - the side panels have clear chevrons;
  - "Download model for offline use" is a smaller secondary button;
  - the projector view carries the Saybeam name.
- **Display settings on phones:**
  - a bottom sheet whose header (with Done) stays in view while you scroll;
  - text size controls that no longer run off the screen;
  - theme cards of equal size.
- Self-drawn line icons replace text glyphs, and the site pages share one header.
- **License: now AGPL-3.0-or-later** (was MIT). Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/).
- `GET /api/rooms/:code` now reports whether a room is private, and returns an empty title for private rooms.
- Transcript lines in the speaker and corrector views are real buttons, so screen readers announce them as editable.
- The text size buttons say "Smaller" and "Larger" (their accessible names now match what is shown, WCAG 2.5.3).
- Captions are no longer hyphenated automatically.

### Fixed

- A listener who joined a room that already had captions could land at the start of the transcript instead of the newest line: web fonts arriving after the first layout made the text taller. The view now stays on live whenever the captions grow.
- In light mode on the device, the "Live" badge in the listener bar was too low in contrast, and hovering the display settings button could hide its label.
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

[Unreleased]: https://github.com/byjoellobo/saybeam/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/byjoellobo/saybeam/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/byjoellobo/saybeam/releases/tag/v0.1.0

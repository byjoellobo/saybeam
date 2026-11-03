# Security policy

Saybeam carries what people say in classrooms, places of worship and meetings, so we take security reports seriously. Thank you for helping keep it safe.

## Supported versions

| Version        | Supported                                                              |
| -------------- | ---------------------------------------------------------------------- |
| `main` branch  | Yes                                                                    |
| Latest release | Yes                                                                    |
| Older releases | No. Please upgrade first and check whether the problem is still there. |

## Reporting a vulnerability

**Please do not report security problems in public issues, pull requests or discussions.**

Report them privately through GitHub:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**. The direct link is https://github.com/byjoellobo/saybeam/security/advisories/new
3. Fill in the form. Only you and the maintainers can see the report.

You need a GitHub account. If you cannot use GitHub private reporting, open a public issue that says only "I have a security report, please give me a private channel", with no details, and a maintainer will follow up.

### What to include

- Which part is affected: the cloud Worker and Durable Object, the LAN relay, or the web app.
- The version or commit, and where you tested (your own `wrangler dev`, your own deployment, or a relay on your machine).
- Steps to reproduce, or a small proof of concept.
- What an attacker could do, and what they need first (for example, "anyone who knows a room code can...").
- Any fix or mitigation you have in mind.

Please test only against your own deployment or a local server, never against rooms or servers run by other people. Do not include real room codes or links in the report.

## What happens next

- **Acknowledgement within 5 working days.**
- An initial assessment, and a severity, as soon as we can, usually within two weeks.
- A fix on a best-effort basis. We aim to fix serious problems within 30 days, and sooner when a problem is being exploited. Saybeam is maintained by volunteers, so these are goals, not guarantees. We will keep you updated either way.
- When the fix is released, we publish a GitHub security advisory and credit you, unless you prefer to stay anonymous. Please keep the details private until then.

## Scope

**In scope**

- The cloud server: the Cloudflare Worker and the Room Durable Object (`apps/worker`), and the shared room logic and validation (`packages/protocol`).
- The LAN relay (`relay/`).
- The web app (`apps/web`), including its service worker, Content Security Policy, local storage of room secrets, and the way it loads speech models.
- The helper scripts in `scripts/`, where a problem could affect someone running them.

**Out of scope**

- Third-party speech models (Moonshine, Whisper, Silero VAD) and the sites that host them, such as Hugging Face.
- Third-party CDNs, such as jsDelivr, which serves ONNX Runtime to the cloud build.
- Browser speech services (Google, Apple, Microsoft) used by the "Browser speech" engine.
- Self-hosted WhisperLive servers. Please report those to [collabora/WhisperLive](https://github.com/collabora/WhisperLive).
- The Cloudflare platform itself. Please report those to Cloudflare.
- Reading the captions of a public (non-private) room with its room code. That is how public rooms are meant to work (see below).
- Attacks that need a compromised device, a malicious browser extension, or physical access to an unlocked speaker device.
- Plain volumetric denial of service, and reports from automated scanners with no demonstrated impact.

## How Saybeam protects rooms

A short summary. [docs/architecture.md](docs/architecture.md) and [docs/protocol.md](docs/protocol.md) have the details.

**Who can do what**

- **Public rooms: the room code is the listener key.** Anyone with the six-character code or the QR code can read the captions. That is the point for lectures, worship and conferences.
- **Private rooms: listeners also need a secret.** The secret travels in the QR link after the `#` (`/r/CODE#k=...`), a part of the URL that browsers never send to servers. Without it, the code alone only reveals that the room exists: `GET /api/rooms/CODE` returns no title.
- **Speaker and corrector links carry 256-bit secrets** (32 random bytes). They also travel after the `#` and are removed from the address bar when the page opens. The speaker's secrets stay in the browser that created the room.
- **Servers store only SHA-256 hashes** of the speaker, corrector and listener secrets, and compare them in constant time.
- **Links can be replaced.** The speaker can rotate the corrector link at any time, and the listener link of a private room. Everyone still using the old link is disconnected.

**Limits against abuse**

- Every message is validated, frames over 8 KiB are refused, and each connection has a rate limit. Connections that keep sending bad frames are closed.
- In the cloud, room creation and joins are rate limited per client network. Guessing a code that does not exist creates no storage.
- Rooms have a size cap, expire 24 hours after their last activity, and live at most 72 hours. The LAN relay keeps rooms in memory only, until it stops.
- Caption text is stripped of control and bidi characters, so exported SRT and WebVTT files cannot be given extra cues.
- The Content Security Policy allows scripts only from the app's own origin and the exact ONNX Runtime build it needs. Speech models are pinned to exact Hugging Face commits.

**What it does not protect against**

- Whoever runs the server can read the captions of every room on it, and the cloud server keeps them for up to 24 hours after the last activity.
- The LAN relay serves plain HTTP. Anyone on the same Wi-Fi network can see the captions travelling to phones. Use a network you trust.
- With the "Browser speech" engine, audio goes to the browser vendor's speech service (unless Chrome's on-device mode is on). With WhisperLive, audio goes to that server. On-device models keep audio on the speaker's device.
- Anyone who has a link can share it further. Rotate a link if it leaks.

Saybeam is not designed for confidential meetings. Do not use it for conversations that must stay secret.

# Contributing to Saybeam

Thank you for helping. Saybeam exists so that deaf and hard of hearing people can follow what is said in a room, on their own phone, for free. Every fix, test and translation moves that forward.

This guide covers how to help, how to set up the project, and the few rules that keep it healthy. Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Field tests.** This is the most valuable help right now. We have not yet measured two things: how fast speech recognition runs on cheap phones and old school laptops, and how accurate it is for Indian-accented and code-mixed (Hindi and English) speech. Open `/bench` on a real device, follow [docs/risk-tests.md](docs/risk-tests.md), and share the results with the **Field test result** issue form. No coding needed.
- **Code.** Bug fixes, features from the issue list, tests. For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time on it.
- **Docs.** If something here confused you, it will confuse the next person too. Small doc fixes are always welcome.
- **Bug reports.** Use the **Bug report** form. Never paste room codes or links: they are keys to a room.
- **Translations.** The interface is English-only for now. Translation support is planned; if you would like to help with a language, say so on the issue tracker and we will reach out when it is ready.

Security problems go through private reporting, not public issues. See [SECURITY.md](SECURITY.md).

## Development setup

You need:

- **Node 24** (Node 22 also works) and npm.
- **Rust stable** (1.88 or newer), only if you work on the LAN relay.
- A Chromium-based browser for the speaker side. Firefox works for listeners.

```bash
npm install
npm run dev:worker       # builds the web app, then runs the Worker and Durable Object at http://127.0.0.1:8787
```

Open http://127.0.0.1:8787, create a room, and open the listener link in another tab or on a phone.

For front-end work with hot reload, keep `dev:worker` running and, in a second terminal:

```bash
npm run dev              # Vite on http://localhost:5173, proxies /api, /ws and /models to the Worker
```

Browsers only allow the microphone on `localhost` or HTTPS. If you test from a phone on your network, use the phone as a listener, not as the speaker.

No microphone? Simulate a speaker, optionally with a crowd of listeners:

```bash
node scripts/demo-speaker.mjs http://127.0.0.1:8787 --listeners 50
```

### The LAN relay

The relay embeds the built web app at compile time, so build the app first:

```bash
npm run build                                          # builds apps/web/dist
cargo build --release --manifest-path relay/Cargo.toml
./relay/target/release/saybeam-relay              # serves http://localhost:7300
```

`npm run build:relay` does both steps. While working on the web app, `--web-dir apps/web/dist` serves files from disk instead of the embedded copy. [relay/README.md](relay/README.md) lists every flag.

**Windows:** the default Rust toolchain (`msvc`) needs a linker from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). In the installer, choose the **Desktop development with C++** workload. Without it, `cargo build` fails with `link.exe not found`.

For hosting your own copy, see [docs/deploy.md](docs/deploy.md) and [docs/self-hosting.md](docs/self-hosting.md).

## Project layout

```text
apps/web            Preact + Vite PWA: speaker, listener, corrector, bench
  src/engines       speech engines, ASR worker, VAD segmenter, resampler, WhisperLive client
  src/lib           room client (reconnect and outbox), caption pipeline, WER, storage, router
  src/pages         one file per screen
apps/worker         Cloudflare Worker + one Room Durable Object per room (SQLite, hibernating WebSockets)
packages/protocol   wire types, zod validation, RoomCore (room rules), client reducer, transcript export
relay               Rust LAN relay (axum): same protocol, embeds the built web app
scripts             conformance test, demo speaker and load test, offline model fetcher, release tooling
docs                user guide, protocol spec, architecture, deploy and engine guides, risk tests, CI/CD and releasing
```

[docs/README.md](docs/README.md) lists every document.

New here? [docs/architecture.md](docs/architecture.md) explains how the pieces fit and where to start reading.

## The golden rule: one protocol, two servers

The room protocol has **two implementations** that must behave identically:

1. `packages/protocol/src/room-core.ts` (TypeScript), used by the Cloudflare Durable Object.
2. `relay/src/room.rs` and its neighbours (Rust), used by the LAN relay.

The web app does not know which server it talks to, so any difference between them is a bug that only shows up in one setting, often a classroom with no internet and no developer nearby.

When you change room behaviour (a message, a limit, an error, a close code):

1. Update [docs/protocol.md](docs/protocol.md) first. It is the shared spec.
2. Change `room-core.ts` and add tests in `packages/protocol/test`.
3. Make the same change in `relay/src` and add Rust tests.
4. Add a check to `scripts/conformance.mjs` if the behaviour is visible on the wire.
5. Run conformance against **both** servers:

```bash
npm run dev:worker                                             # terminal 1
./relay/target/release/saybeam-relay --bind 127.0.0.1     # terminal 2 (rebuild it first)
npm run conformance -- http://127.0.0.1:8787                   # terminal 3
npm run conformance -- http://127.0.0.1:7300
```

CI runs the same checks on every pull request, along with CodeQL code scanning and a review of new dependencies. [docs/ci-cd.md](docs/ci-cd.md) describes every workflow and how to run its checks locally.

## Tests

```bash
npm run lint             # Biome: formatting and lint rules
npm run version:check    # every package, the relay crate and CHANGELOG.md agree on the version
npm run typecheck        # TypeScript, every workspace
npm test                 # unit tests (protocol, room logic, audio, WER, client)
npm run test:coverage    # the same, with coverage thresholds
npm run test:relay       # Rust unit and integration tests
npm run e2e              # Playwright end-to-end tests (starts its own wrangler dev on port 8791)
```

Before the first `npm run e2e`, install the browser once:

```bash
npx playwright install --with-deps chromium
```

New code comes with tests. Room logic in `room-core.ts` and `relay/src/room.rs` is pure (no sockets), so it is easy to test directly.

## Changelog and releases

Add a line for any user-visible change under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md), in the section that fits (**Added**, **Changed**, **Fixed** or **Security**). Write it for the people who use Saybeam.

Please do not change version numbers in a pull request. Maintainers set them all at once with `npm run release` when they cut a release: see [docs/releasing.md](docs/releasing.md).

## Style

- **Formatting and lint:** [Biome](https://biomejs.dev/). Run `npm run format` to fix formatting and `npm run lint` to check. Rust uses `cargo fmt` and `cargo clippy -- -D warnings`.
- **TypeScript strict mode**, including `noUncheckedIndexedAccess`. Avoid `any`; validate untrusted input (network frames, storage, URLs) at the edge, as `schema.ts` does with zod.
- **Small, focused files.** Most files are 100 to 400 lines. If a file passes about 800 lines, split it.
- **Immutable updates.** Return new objects instead of changing existing ones. The room logic and the client reducer depend on this.
- **Plain-language UI copy.** Short sentences, everyday words, and error messages that say what to do next. Many readers are reading in a second language, or reading fast while someone talks.
- **Accessibility first.** Every control works with a keyboard and a screen reader, has a visible focus style, and keeps working at large text sizes and in every theme. Captions are the product, so their readability comes before decoration.
- **House rule: no em dash characters**, anywhere: code, comments, docs, UI copy, commit messages. Use a comma, colon, parentheses or a plain hyphen. En dashes in ranges (such as 1–10) are fine. To check: `git grep -nP '\x{2014}'`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>: <short description>

<optional body: what and why>

Signed-off-by: Your Name <the email you commit with>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Example: `fix: keep unsent captions when the speaker reloads the page`.

## Sign your commits (DCO)

Saybeam uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of a contributor licence agreement. By adding a `Signed-off-by` line to a commit, you certify that:

- you wrote the change, or otherwise have the right to submit it under the project's open source licence;
- if it is based on earlier work, that work is under a compatible open source licence and you may submit it with your changes;
- or someone who could certify the above gave it to you, and you have not changed it;
- and you understand that the contribution and your sign-off (including your name and email) are public and kept permanently.

The full text is short and worth reading: https://developercertificate.org/

Git adds the line for you with `-s`:

```bash
git commit -s -m "fix: describe the change"
```

Forgot? Fix the last commit with `git commit --amend -s --no-edit`, or every commit on your branch with `git rebase --signoff main`, then `git push --force-with-lease`.

## License

Saybeam is licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). By contributing, you agree that your contribution is licensed under the same terms. There is no separate agreement to sign: the DCO sign-off is all we need.

Only add dependencies whose licences are compatible with the AGPL (for example MIT, BSD, Apache-2.0 or ISC), and mention any new dependency in your pull request. The dependency review check lists the licence of each new dependency and fails if one has a known vulnerability.

# Product

<!-- impeccable:product-schema 1 -->

Inferred from the repository and the original build brief. The owner asked for the work to be done without an interview, so every fact below comes from code, docs and that brief, not from a confirmation round.

## Platform

web

## Users

- **Speakers:** teachers, lecturers, faith leaders and event hosts. Each runs a session from a laptop or phone at the front of a room. They glance at the console while they talk, so it must be readable at a distance and safe to operate one-handed.
- **Listeners:** students, deaf and hard-of-hearing people, people with auditory processing differences, and second-language listeners. They follow on their own phones, often older Android devices, in bright classrooms or dim halls. They join by QR code or a six-character room code. There are no accounts.
- **Correctors:** a helper (often a teaching assistant) who fixes captions live from a corrector link.
- **Self-hosters:** schools and IT volunteers who run the LAN relay on a laptop or deploy to Cloudflare.

## Product Purpose

Saybeam restores shareable live captions after Web Captioner shut down on 31 October 2023. The speaker's device turns speech into text, and everyone in the room reads it on their own phone, at their own text size and contrast. It is free and open source, so a school with no budget can use it.

Success means:

- a listener can join in seconds and keep reading without fighting the interface;
- a speaker can start captioning in under a minute;
- the whole thing works on weak or no internet through the LAN relay.

## Positioning

The speaker's own device does the recognition: Moonshine or Whisper run in the browser, so audio does not have to leave the room. Captions fan out to every phone with a room code. No per-minute billing, no accounts, and an offline mode for schools with poor connectivity.

## Operating Context

- A projector shows the room code and QR code.
- Phones scan it and open a web page, which can be installed as a PWA.
- A teacher's laptop may be the server on school Wi-Fi.
- Sessions last a lecture or a service.
- Transcripts are exported afterwards as TXT, SRT, WebVTT or JSON.

## Capabilities and Constraints

- **Speech engines:** on-device (Moonshine, Whisper), browser speech, or WhisperLive.
- **Rooms:** private rooms with a secret in the QR link, link replacement, a corrector role and a hand-off link.
- **Listener display:** five fixed high-contrast themes, font choice, size, spacing, ALL CAPS and bold.
- **Reading live:** scrollback with "Back to live", a stage layout, and screen-reader announcements.
- **Constraints:**
  - strict CSP (`style-src 'self'`, `font-src 'self'`);
  - no third-party fonts or analytics;
  - WCAG 2.1 AA checked by axe in end-to-end tests;
  - copy in plain British-leaning English ("colours", "centre");
  - no em dashes in any text.
- Not yet measured: latency on low-end speaker devices, and accuracy for Indian-accented and code-mixed English (see docs/risk-tests.md). Never claim results.

## Brand Commitments

- **Name:** Saybeam, renamed from Caption Room on 2026-11-03.
- **License:** AGPL-3.0-or-later, with a visible "Source code" link.
- **Credits:** Web Captioner is credited respectfully, as the predecessor.
- **Type:** the Atkinson Hyperlegible family (Braille Institute) is part of the accessibility promise.

## Evidence on Hand

- Real product screens and E2E screenshots (docs/images).
- A conformance suite and unit coverage.
- No users, testimonials, field-test results or hosted instance yet. Future work must not invent them.

## Product Principles

1. The reader decides how captions look. Defaults are bold and readable, and every choice is theirs.
2. Speech becomes text in front of you. Show the mechanism, not marketing.
3. Works in the worst room: weak Wi-Fi, old phones, bright light.
4. Nothing to sign up for. A code or a QR is the whole onboarding.
5. Plain, calm language. Errors say what happened and what to do next.

## Accessibility & Inclusion

WCAG 2.1 AA is the floor, and the target listener is often deaf or hard of hearing:

- text must scale to 140px;
- contrast themes stay pure (pure black, white and yellow);
- focus is always visible;
- every control is reachable by keyboard and screen reader;
- motion respects `prefers-reduced-motion`.

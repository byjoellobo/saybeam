---
name: Saybeam
description: Free, open live captions. One beam of yellow on true neutrals, and the reader decides how captions look.
colors:
  # Brand, identical in both schemes
  beam: "#ffd43b"
  beam-hover: "#ffde66"
  beam-ink: "#141100"
  caption-ground: "#070707"
  caption-text: "#f6f6f6"
  logo-ink: "#161616"
  # App chrome, dark (the :root and .caption-screen default)
  dark-bg: "#0d0d0d"
  dark-surface: "#151515"
  dark-surface-2: "#1d1d1d"
  dark-surface-3: "#272727"
  dark-field-line: "#6b6b6b"
  dark-line: "#2c2c2c"
  dark-line-strong: "#404040"
  dark-text: "#f3f3f3"
  dark-muted: "#a8a8a8"
  dark-danger: "#ff7b72"
  dark-danger-ink: "#2a0603"
  dark-ok: "#4ed18a"
  dark-warn: "#f4b13e"
  # App chrome, light (prefers-color-scheme: light, :root only)
  light-bg: "#f4f4f4"
  light-surface: "#ffffff"
  light-surface-2: "#ededed"
  light-surface-3: "#e2e2e2"
  light-field-line: "#8a8a8a"
  light-line: "#dadada"
  light-line-strong: "#b5b5b5"
  light-text: "#141414"
  light-muted: "#555555"
  light-primary-line: "#d9ad0b"
  light-danger: "#b3261e"
  light-ok: "#146c3c"
  light-warn: "#8a5300"
  # Listener caption themes (reader's choice, independent of the device)
  cap-dark-bg: "#000"
  cap-dark-fg: "#f7f5ef"
  cap-yellow-bg: "#000"
  cap-yellow-fg: "#ffd400"
  cap-light-bg: "#fff"
  cap-light-fg: "#111"
  cap-inverse-bg: "#ffd400"
  cap-inverse-fg: "#000"
  cap-cream-bg: "#1c1a16"
  cap-cream-fg: "#efe4c8"
typography:
  display: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "clamp(2.5rem, 4.9vw, 4.5rem)", fontWeight: 760, lineHeight: 1.06, letterSpacing: "-0.03em" }
  headline: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "2rem", fontWeight: 750, lineHeight: 1.15, letterSpacing: "-0.015em" }
  title: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "1.375rem", fontWeight: 750, lineHeight: 1.15, letterSpacing: "-0.015em" }
  body: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "1.0625rem", fontWeight: 400, lineHeight: 1.55 }
  label: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "0.95rem", fontWeight: 650 }
  group-label: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "0.8125rem", fontWeight: 700, letterSpacing: "0.07em" }
  caption: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "34px", fontWeight: 400, lineHeight: 1.45 }
  transcript: { fontFamily: "Atkinson Hyperlegible Next Variable, system-ui, sans-serif", fontSize: "1.375rem", fontWeight: 400, lineHeight: 1.5 }
  room-code: { fontFamily: "Atkinson Hyperlegible Mono Variable, ui-monospace, monospace", fontSize: "2.1rem", fontWeight: 700, lineHeight: 1.15, letterSpacing: "0.12em" }
rounded:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  sheet: "20px"
  pill: "999px"
spacing:
  tight: "0.5rem"
  snug: "0.75rem"
  base: "1rem"
  roomy: "1.25rem"
  gutter: "clamp(1rem, 4vw, 2rem)"
components:
  # Refs resolve to the dark scheme; light swaps the same roles.
  button: { backgroundColor: "{colors.dark-surface-2}", textColor: "{colors.dark-text}", rounded: "{rounded.sm}", padding: "0.5rem 1rem", height: "44px" }
  button-hover: { backgroundColor: "{colors.dark-surface-3}" }
  button-primary: { backgroundColor: "{colors.beam}", textColor: "{colors.beam-ink}", rounded: "{rounded.sm}", padding: "0.5rem 1rem", height: "44px" }
  button-primary-hover: { backgroundColor: "{colors.beam-hover}" }
  button-mic: { rounded: "{rounded.pill}", height: "60px", width: "220px" }
  input: { backgroundColor: "{colors.dark-bg}", textColor: "{colors.dark-text}", rounded: "{rounded.sm}", padding: "0.55rem 0.75rem", height: "44px" }
  panel: { backgroundColor: "{colors.dark-surface}", rounded: "{rounded.lg}", padding: "1rem 1.1rem" }
  pill: { backgroundColor: "{colors.dark-surface-2}", rounded: "{rounded.pill}", padding: "0.25rem 0.7rem" }
  room-code-chip-light: { backgroundColor: "{colors.beam}", textColor: "{colors.beam-ink}", rounded: "{rounded.sm}", typography: "{typography.room-code}" }
  transcript: { backgroundColor: "{colors.caption-ground}", textColor: "{colors.caption-text}", rounded: "{rounded.md}", padding: "0.6rem", typography: "{typography.transcript}" }
  qr-plate: { backgroundColor: "{colors.light-surface}", rounded: "{rounded.md}", padding: "8px", size: "152px" }
  jump-live: { backgroundColor: "{colors.cap-dark-fg}", textColor: "{colors.cap-dark-bg}", rounded: "{rounded.pill}", height: "50px" }
---

# Design System: Saybeam

Recorded from the shipped build: `src/styles/base.css` (tokens, controls, site pages), `listener.css` (caption themes, sheet), `speaker.css` (console, transcript, projector, bench), `components/Icon.tsx` and `scripts/make-icons.mjs`. The CSS custom properties are the source of truth and the YAML above mirrors them. If this file and the CSS disagree, fix this file.

## Overview

**Creative North Star: "One beam on true neutrals"**

Saybeam looks like a live caption screen in a dark room: pure grey chrome with no colour cast, big hyperlegible type, and one yellow beam that marks what to press and where text is still arriving. The home hero *is* a caption screen (the headline arrives word by word and ends in a cursor), and so is the speaker's transcript, so the interface shows the mechanism rather than marketing it. Density is low and targets are large: speakers glance at the console from a distance, and listeners read on old phones in bright rooms.

**Key Characteristics (the visual principles):**
- **The reader owns the caption surface.** Theme, size (16 to 140px), font, spacing, case and weight belong to the listener. Nothing in the chrome overrides them.
- **Show the mechanism.** Captions are plain text on a black screen, and the line still being spoken ends in a cursor. No illustration, no decoration.
- **One accent.** Beam yellow is the only brand colour. Green, amber and red are status signals, never decoration.
- **Built for the worst room.** 44px default targets, AA contrast in every scheme and theme, no sideways scrolling at 320px, layouts that survive 140px text.
- **Calm.** Flat tonal panels, 150ms state changes, and no animation that runs forever.

## Colors

True neutral greys (equal R, G and B) plus one warm yellow, in two colour systems that never mix, plus fixed black caption screens.

**The Two Systems Rule.** The app chrome follows the device (`prefers-color-scheme`, no in-app toggle). The listener's caption surface follows the theme the reader picked and ignores the device. Inside `.listener`, the bar, pills, banners, buttons, hover tints and focus rings all come from `--cap-*` tokens, including the status colours (`--cap-ok`, `--cap-warn`, `--cap-off`). The Display sheet is chrome: it keeps the app tokens even when it opens over a caption theme.

**The Caption Screen Rule.** Caption screens are black in both schemes: the home hero (`--caption-ground`) and the speaker and corrector transcript (`.transcript.caption-screen`). `base.css` declares the dark tokens on `:root, .caption-screen` and the light media query overrides only `:root`, so everything inside a `.caption-screen` keeps dark values and `color-scheme: dark`. Use the class for any new caption preview instead of hard-coding colours.

### Primary
- **Beam** (#ffd43b): primary button fill, the cursor, text selection (with beam-ink text). In dark it is also the link, room code, slider and checkbox accent and selected-ring colour. Hover is **Beam Hover** (#ffde66).
- **Beam Ink** (#141100): text on beam.
- **Caption Ground / Caption Text** (#070707 / #f6f6f6): the caption screens.

**The Beam Is a Fill in Light Rule.** In light, beam is never a text or line colour. `--link`, `--control` and `--caret` all become ink (#141414); links stay underlined and, inside `p`, `li` and the footer, get a beam highlight on hover (beam at 45%, 3px radius). The large room code becomes a beam chip (beam fill, beam-ink text, 8px radius, 0.08em tracking, no wrapping), and the primary button keeps its beam fill with a darker edge (`--primary-line`).

### App chrome tokens (follow the device)

| Token | Role | Dark | Light |
|---|---|---|---|
| `--bg` | Page background | #0d0d0d | #f4f4f4 |
| `--surface` | Cards, panels, bars, sheet | #151515 | #ffffff |
| `--surface-2` | Default button, pill, hovered line, inline code | #1d1d1d | #ededed |
| `--surface-3` | Button hover, selected segment, meter track, badge | #272727 | #e2e2e2 |
| `--field` | Input and segmented track fill | #0d0d0d | #ffffff |
| `--field-line` | Input, select, textarea and segmented outlines (3:1, WCAG 1.4.11) | #6b6b6b | #8a8a8a |
| `--line` | Container borders, dividers | #2c2c2c | #dadada |
| `--line-strong` | Button borders, swatch edges, step rules | #404040 | #b5b5b5 |
| `--text` | Body text | #f3f3f3 | #141414 |
| `--muted` | Secondary text, hints, group labels, ghost buttons | #a8a8a8 | #555555 |
| `--link` | Links, the large room code | beam | #141414 |
| `--control` | Range, checkbox and progress accent; selected rings | beam | #141414 |
| `--caret` | Text caret, transcript cursor | beam | #141414 |
| `--primary-line` | Primary button border | beam | #d9ad0b |
| `--danger` / `--danger-ink` | Errors, End session, Pause fill / text on it | #ff7b72 / #2a0603 | #b3261e / #ffffff |
| `--ok` | Live status, active meter, inserted words | #4ed18a | #146c3c |
| `--warn` | Waiting status, warnings, banners | #f4b13e | #8a5300 |

Browser `theme-color` is #151515 (dark) and #ffffff (light). `--accent` and `--accent-ink` are unused legacy aliases of beam.

### Caption themes (chosen by the reader)

| Theme id (label) | `--cap-bg` | `--cap-fg` | Cursor | Bar | `--cap-ok` / `--cap-warn` |
|---|---|---|---|---|---|
| `dark` (White on black, default) | #000 | #f7f5ef | beam | #0f0f0f | #4ed18a / #f4b13e |
| `yellow` (Yellow on black) | #000 | #ffd400 | #fff | #0f0f0f | #4ed18a / #f4b13e |
| `light` (Black on white) | #fff | #111 | #111 | #f2f2f2 | #0b5a2f / #7a4500 |
| `inverse` (Black on yellow) | #ffd400 | #000 | #000 | #f0c800 | #064021 / #5c3300 |
| `cream` (Low glare) | #1c1a16 | #efe4c8 | #efe4c8 | #24211c | #4ed18a / #f4b13e |

Derived: `--cap-dim` (fg mixed 62% into bg) for the partial line, times and the empty state; `--cap-off` (70%) for the offline pill. `light` and `inverse` set `color-scheme: light` so native controls match. Selection inverts the theme.

**The Pure Pair Rule.** Caption themes are plain, high-contrast pairs of pure black, white and #ffd400. Caption yellow is deliberately not beam; don't merge them. Low glare is the one softened pair, and it is tested like the rest.

## Typography

**UI Font:** Atkinson Hyperlegible Next Variable (`--font-ui`, with system-ui fallback)
**Mono Font:** Atkinson Hyperlegible Mono Variable (`--font-mono`, with ui-monospace fallback)

Both are self-hosted variable fonts from `@fontsource-variable/atkinson-hyperlegible-next` and `@fontsource-variable/atkinson-hyperlegible-mono` (weight axis), imported in `src/main.tsx` and bundled, so they load from the app's own origin. The family is part of the accessibility promise: letterforms designed to be told apart.

**Character:** one family does everything. Hierarchy comes from weight (400 to 800) and size, never a second display face.

### Hierarchy
- **Display** (760, clamp(2.5rem, 4.9vw, 4.5rem), 1.06, -0.03em, max 13ch): the home hero caption only.
- **Headline** (750, 2rem, 1.15, -0.015em, balanced wrap): page h1. Prose pages use clamp(2rem, 5vw, 2.75rem).
- **Title** (750, 1.375rem for h2, 1.125rem for h3): card and section headings. Sheet title 1.5rem; panel summaries 1.0625rem.
- **Body** (400, 1.0625rem, 1.55, pretty wrap): prose capped at 68ch; ledes 52 to 62ch in `--muted`.
- **Label** (650, 0.95rem): field labels and segmented options. Buttons use 650 at 1.2 line height.
- **Group label** (700, 0.8125rem, uppercase, 0.07em, `--muted`): fieldset legends and value labels such as "Room code".
- **Hint** (400, 0.875rem, 1.45, `--muted`): `<small>` under fields and switches.
- **Step numeral** (800, 1rem, `--link`, UI font): the home "How it works" counters.
- **Wordmark** (800, 1.3rem, -0.02em): "Saybeam" beside the mark.
- **Captions** (reader-set; default 34px, 400 or 700 bold, 1.45, max 48ch): applied through `--cap-size`, `--cap-weight`, `--cap-line`, `--cap-tracking`, `--cap-transform` and `--cap-font`. No automatic hyphenation (`hyphens: manual`, `overflow-wrap: anywhere`).
- **Transcript** (400, 1.375rem, 1.5): the speaker and corrector caption screen.

**The Mono Means Data Rule.** Mono is only for things read character by character or compared as numbers: room codes (code input at 0.2em tracking, room code at 0.12em, code chips at 0.1em, the projector code), times (transcript and caption timestamps), measurements (the text-size readout, diagnostics values) and `<code>`. Never headings, labels, counters or decoration. Add `font-variant-numeric: tabular-nums` where numbers change.

Readers can switch captions to Atkinson Hyperlegible Next (default), System sans, Serif (Georgia) or Atkinson Hyperlegible Mono. That choice applies to `.captions` only.

## Layout
- **Site pages** (home, about, bench): centred, max 1120px, gutter clamp(1rem, 4vw, 2rem). Text pages 760px (`.narrow`) or 960px (`.narrow-wide`).
- **Home:** hero caption and task cards stack, then split 1.2fr / 1fr from 960px. Task cards auto-fit at min 320px; steps auto-fit at min 260px, each with a 1px top rule.
- **Speaker console:** sticky 60px bar; transcript (1fr) beside side panels (320 to 400px), max 1440px, 1rem gap. At 900px and below it is one `minmax(0, 1fr)` column so nothing forces a sideways scroll; selects in `.side` go full width. On wide screens the live panel is sticky and fills the viewport under the bar.
- **Speaker bar on phones (600px and below):** static rather than sticky; the wordmark and divider are hidden; `.label-long` text ("people following", "on screen") is visually hidden but stays in the accessible name.
- **Listener:** a 100dvh column with a 60px bar over the caption region. Captions keep 4.5rem bottom padding so the jump button never covers text. Bar, captions and sheet respect `env(safe-area-inset-*)`.
- **Breakpoints in use:** 600px (speaker bar), 700px (sheet becomes a side panel; the hero's earlier line appears), 900px (speaker grid), 960px (hero grid).
- **Rhythm:** no spacing tokens exist. Recurring steps are 0.35rem (label to field), 0.5rem, 0.75rem, 1rem, 1.25rem (between cards) and 1.5rem (between fieldsets). Card padding clamps from about 1.1rem to 1.75rem.
- **Targets:** 44px default for buttons and inputs; 36px small buttons, 42px segments, 54px large buttons, 56px panel summaries, 60px bars and mic button.

## Elevation & Depth

Depth is tonal: `--bg`, `--surface`, `--surface-2`, `--surface-3` step lighter in dark; light puts white surfaces on a grey page. Everything at rest is flat with a 1px border. Shadows belong only to layers that float.

- **Pop** (`--shadow-pop`): dark `0 18px 48px -12px rgb(0 0 0 / 60%), 0 2px 6px rgb(0 0 0 / 30%)`; light `0 18px 48px -16px rgb(20 24 30 / 28%), 0 2px 6px rgb(20 24 30 / 10%)`. The hero caption screen and the Display sheet.
- **Jump** (`0 10px 28px -6px rgb(0 0 0 / 55%)`): "Back to live" over captions.
- **Beam glow** (`0 8px 22px -10px`, beam at 70%): the enabled primary mic button only.
- **Focus:** a transparent 2px outline (2px offset) plus the `--focus` ring, so forced-colors mode still draws a visible outline. Ring: dark `0 0 0 2px var(--bg), 0 0 0 4px var(--beam)`; light `0 0 0 2px var(--surface), 0 0 0 4px #141414`. Inside the listener it is cap-bg plus cap-fg (inset 3px on the caption region); on the projector, white plus black.
- **Scrim:** sheet backdrop `rgb(0 0 0 / 55%)`.

**The Flat Until It Floats Rule.** Panels, cards and task forms never cast shadows. A new shadow needs a new floating layer.

## Shapes
- Soft rounded rectangles, with pills for status and the speaker's main action.
- Radius ladder: 6px (code chips, transcript line buttons, focus on unrounded elements), 8px (`--radius-sm`: buttons, inputs, segments, swatches, notices, the light room code chip), 12px (`--radius`: segmented track, code input, QR plate, transcript screen, room list), 18px (`--radius-lg`: cards, panels, hero), 20px (phone sheet top corners), 999px (pills, mic, jump button, meter).
- Borders are 1px: `--line` on containers, `--line-strong` on buttons, `--field-line` on inputs and segmented tracks. Selection adds a 1.5px inset ring, never a thicker border.
- The cursor is a rounded bar (2px radius), the same form as the cursor in the logo.

## Components

### Buttons
- **Base:** `--surface-2` fill, 1px `--line-strong`, 8px radius, 44px, weight 650. Hover `--surface-3`; press nudges 1px down; disabled 50% opacity. Variants only reset `--btn-bg`, `--btn-fg` and `--btn-line`.
- **Primary:** beam fill, beam-ink text, `--primary-line` border; one per form or task.
- **Danger:** transparent, danger text, 55% danger border, 12% tint on hover (End session, Remove line). **Stop:** danger fill with danger-ink (Pause captioning, Stop).
- **Ghost:** transparent and muted; surface-2 with text colour on hover (Forget, Reset, Show earlier).
- **Sizes:** small 36px, large 54px, icon 44px square. The mic button is a 60px pill, min 220px, 1.15rem at 750.

### Fields, switches and sliders
- Label above (0.35rem gap), hint below. Inputs, selects and textareas use `--field`, a 1px `--field-line` outline, 8px radius, 44px. Hover border `--muted`; focus border `--text` plus the focus ring.
- Errors are `.error` text in `--danger` (650) with `role="alert"`.
- Switches are native 22px checkboxes beside a label and hint, divided by 1px lines when stacked. Checkboxes, ranges and progress bars all use `accent-color: var(--control)`.

### Segmented controls and theme swatches
- **Segmented:** `--field` track, 1px `--field-line` outline, 12px radius, 4px padding and gap. Equal-width labels wrap hidden native radios (42px, muted 650) and have `min-width: 0` with `overflow-wrap: anywhere`, so long options wrap instead of overflowing. Selected is `--surface-3` with a 1.5px inset `--control` ring; keyboard focus rings the label.
- **Swatches:** a grid (min 96px) of radio labels, each an "Aa" sample in the theme's exact pair plus a 0.8125rem label. Selected gets a `--control` border and inset ring.

### Pills, badges and notices
- **Status pill:** 999px, 0.875rem at 700, surface-2 fill, 8px dot in `currentColor`. Live is `--ok`, wait is `--warn`, off is `--muted`. It carries `role="status"` and `aria-live="polite"`. The live dot pulses a ring twice (2 iterations of 2.4s, WCAG 2.2.2), and the dot is keyed on the label so the pulse replays whenever the state changes. The decorative pill in the home hero does not pulse.
- **Badge:** 0.72rem at 700, uppercase, surface-3, 5px radius.
- **Notices** (`.warn`, `.banner`, `.lan-badge`): `color-mix(in srgb, var(--warn) 12%, var(--surface))` fill with a 1px border of the same colour at 45% all round (danger 50%). Ok and danger variants swap the colour.

### Panels and details
- `.panel`, `.card`, `.task`: surface fill, 1px `--line`, 18px radius, no shadow.
- `details.panel`: the whole 56px summary row toggles. The native marker is hidden; a chevron icon at the right rotates 180deg when open.

### The Display sheet
A native `<dialog>` opened with `showModal()`. Phones get a bottom sheet (20px top corners, max min(88dvh, 900px)); from 700px it is a 440px full-height side panel with a 1px left `--line`. Sticky header (1.5rem title, small "Done"), fieldsets with group labels, and "Reset to defaults" as a ghost button at the end.

### QR share and projector view
- **QR share:** the QR always sits on a white 152px plate (8px quiet zone, 12px radius, 1px `--line` ring). Beside it: the "Room code" group label, the code in mono (2.1rem; beam text in dark, a beam chip in light), the URL in muted 0.9rem, then small Copy link and Share buttons. Screen readers hear the code letter by letter.
- **Projector view** (`.present`): fixed, black on white in every scheme, sized in vmin (QR 50vmin), mono code, a pill Close button that inverts on hover, and the mark with wordmark bottom-left.

### Transcript caption screen (speaker and corrector)
`.transcript.caption-screen` is a black caption screen in both schemes: `--caption-ground` fill, `--caption-text`, 12px radius, 0.6rem padding, 1.375rem at 1.5. Its first child has `margin-top: auto`, so a short transcript sits at the bottom like captions and a long one scrolls. Because it carries the dark tokens, times, hovers, the beam cursor, the inline editor and its focus rings stay dark even in light mode. Each line is a full-width unstyled button (8px radius, text cursor, hover `--surface-2`) that opens an inline editor. Time is mono 0.8rem muted. States: removed (muted, struck through, italic), unsent (75% opacity), partial (muted, ends in the cursor), editing (surface-2 block, textarea, small Save primary, Cancel and Remove line danger buttons).

### Caption surface (listener)
Paragraphs up to 48ch, 0.6em apart, left or centred. The partial line is `--cap-dim` and ends in the cursor; corrected segments get a dotted 40% underline. The stage layout shows only the last three segments, anchored to the bottom. When the reader scrolls back, a 50px "Back to live" pill appears, inverted from the theme (fg fill, bg text), with the arrow icon and a new-line count.

### The text cursor (signature)
**The Cursor Means Arriving Rule.** A rounded vertical bar marks text still arriving. It appears in four places only: the end of the hero headline (beam, 0.09em by 0.86em), the listener's partial line (`--cap-caret`, max(3px, 0.08em) by 0.9em), the transcript's partial line (`--caret`, 3px by 1.05em, beam in both schemes because it sits on the caption screen), and the logo. Form carets match through `caret-color`. Never put it on finished text or use it as ornament.

### Motion
- One curve: `--ease-out`, cubic-bezier(0.16, 1, 0.3, 1). The meter (90ms linear) and the hero cursor blink (`steps(1)`) are the exceptions.
- Durations: 100ms press, 150ms colour and border, 200ms chevron, 220ms jump button rise (10px), 240ms projector fade, 260ms sheet entrance (24px, up on phones, in from the right on wide screens).
- Hero headline: each word fades up from a 6px blur over 520ms, staggered 110ms through the `--i` custom property. The cursor appears at 900ms, blinks four times, then holds still.
- Nothing loops forever: the live dot pulses twice per state change. Captions and transcript lines never animate in.
- `prefers-reduced-motion: reduce` removes every animation and transition globally (end of `base.css`).

### Icons
Saybeam draws its own line icons in `components/Icon.tsx`: 24-unit grid, 2px stroke, round caps and joins, no fill, `currentColor`, sized 1.15em by `.icon`. The set is `users`, `expand`, `download`, `arrowDown`, `chevron` and `external`. Every icon is decorative (`aria-hidden="true"`, `focusable="false"`) and sits beside a label that names the action, visible or kept in the accessible name. To add one, add a path to `PATHS` on the same grid and stroke. The listener's display button is an "Aa" type sample (matching the swatches) with an `sr-only` name, not an icon.

### Logo and regenerating the icons
The mark is a beam-yellow speech bubble on a logo-ink (#161616) rounded square (112 of 512 units, about 22%), holding two ink caption lines (long and short, pill-ended) and a cursor bar, with the tail pointing down-left. The maskable variant fills the square and scales the mark to 86% to stay inside the safe circle. Beside the wordmark it is 36px with 9px corners (7px in the speaker bar).

`public/icons/icon.svg`, `icon-192.png`, `icon-512.png` and `icon-maskable-512.png` all come from one `shapes()` list in `scripts/make-icons.mjs`, which writes the SVG and rasterises the PNGs with no native dependencies. Change the shapes there, never the output files, then run:

```sh
node apps/web/scripts/make-icons.mjs
```

## Do's and Don'ts

### Accessibility checks (enforced)
`tests/e2e/themes.spec.ts` enforces two things:
- **Reflow (WCAG 1.4.10):** at 320px and 390px phone viewports, no page scrolls sideways (home, about, bench, listener, speaker console and corrector), which axe cannot see.
- **axe:** with reduced motion on, axe runs the `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` tags and fails on any serious or critical violation. It covers both `light` and `dark` colour schemes on the home, about and bench pages and the speaker console, and all five caption themes on both the Display sheet and the listener view, in both schemes.

Add new pages and themes to that spec.

### Do:
- **Do** use the custom properties. A new colour becomes a token in `base.css` with both a dark and a light value, and stays a true neutral unless it is beam or a status colour.
- **Do** outline inputs, selects, textareas and segmented tracks with `--field-line`; `--line` and `--line-strong` are too faint for a control's edge.
- **Do** derive everything inside `.listener` from `--cap-*`, including hover tints (`--cap-fg` mixed at 10 to 14%) and focus rings.
- **Do** wrap any surface that must stay black in `.caption-screen`.
- **Do** build notices as a 12% tint with a 1px border all round.
- **Do** keep beam to one primary action per form, plus the cursor, selection and (in dark) links.
- **Do** let flex and grid children shrink (`minmax(0, 1fr)`, `min-width: 0`) and check new layouts at 320px.
- **Do** pass runtime values (reader prefs, word index, meter level) through the `style` prop as custom properties or transforms, and keep the styling in CSS.
- **Do** shorten crowded labels visually with a visually hidden span (like `.label-long`), never by dropping words from the accessible name.
- **Do** add a new caption theme everywhere it lives: the theme block and swatch pair in `listener.css`, `THEMES` in `DisplaySettings.tsx`, the `Theme` type and sanitizer in `lib/storage.ts`, and the loop in `themes.spec.ts`.

### Don't:
- **Don't** put a coloured left or right border on callouts, cards or list items. Notices are tinted all round.
- **Don't** use Unicode glyphs, emoji, icon fonts or icon packages as icons.
- **Don't** load fonts, styles or scripts from another origin: the CSP is `font-src 'self'` and `style-src 'self'`. Add fonts as `@fontsource-variable` packages imported in `main.tsx`.
- **Don't** write `<style>` blocks or static `style` attributes; the CSP blocks them. Rules go in the three stylesheets.
- **Don't** use mono for headings, labels, counters or decoration.
- **Don't** use beam as text or a line colour on light surfaces; it is a fill there.
- **Don't** let `prefers-color-scheme` change a caption theme or a caption screen, or put app tokens on the caption surface.
- **Don't** drop the transparent outline from a focus style; forced-colors mode depends on it.
- **Don't** shadow resting panels, and never use hard offset (zero-blur) shadows.
- **Don't** animate caption text, add animations that run forever, or blink the cursor anywhere but the hero.
- **Don't** put the small uppercase group label above a heading as a kicker or eyebrow.
- **Don't** use the legacy `--accent` and `--accent-ink` aliases.
- **Don't** edit `public/icons/*` by hand.

# Risk tests for the first fortnight

The v1 brief names two risks that the background research did not measure:

1. **Latency on low-end speaker devices.** Can a cheap phone or an old school laptop run speech recognition fast enough for live captions?
2. **Accuracy on Indian-accented and code-mixed English.** How often are the words wrong when the speaker has an Indian accent or mixes Hindi and English?

This plan gives each risk a method, the tools already built into Caption Room, pass and fail thresholds, and a day-by-day schedule. Everything runs from the **field-test bench** at `/bench`, which stores results in the browser and exports CSV or JSON for analysis.

## Tools in this repo

| Tool | What it measures |
| --- | --- |
| `/bench`, "Transcribe an audio file" | Real-time factor (RTF: compute time divided by audio length), per-utterance p50/p95 compute time, model load time, word and character error rate against a reference. On-device engines only. |
| `/bench`, "Record and read aloud" | Word error rate for any engine, including browser speech and WhisperLive, read live from the mic. |
| Speaker console, "Performance" panel | Live RTF, caption lag (end of speech to final caption), queue depth, partial-update interval, server round trip, unsent captions. |
| `scripts/demo-speaker.mjs --listeners N` | Fan-out latency from the speaker's send to N listeners' receive, for big halls. |
| `scripts/conformance.mjs` | Protocol correctness of the cloud server and the LAN relay. |

Scoring details (in `apps/web/src/lib/wer.ts`):

- WER ignores case and punctuation.
- Digits are spelled out, so "chapter 4" and "chapter four" match.
- Equivalences let romanised Hindi spelling variants count as the same word (for example `nahin = nahi`), which matters for code-mixed speech.

## Risk 1: latency on low-end speaker devices

### Devices

Borrow at least one device per tier. Record the exact model, RAM, browser version and power state (plugged in or on battery).

| Tier | Example | Why |
| --- | --- | --- |
| A, low-end phone | Android with 2 to 3 GB RAM, 4 to 8 slow cores, Chrome | The worst device a teacher might use |
| B, entry laptop | Celeron or Core i3, 4 GB RAM, integrated GPU, Windows, Chrome | A typical school or government-scheme laptop |
| C, Chromebook | 4 GB, ARM or Celeron | Common in schools |
| D, mid laptop | Core i5 or Ryzen 5, 8 GB, with WebGPU | A comfortable reference point |

### Engine matrix

For each device run:

- Moonshine Tiny (CPU)
- Moonshine Base (CPU, plus GPU where WebGPU exists)
- Whisper Tiny English
- Whisper Base
- Browser speech (cloud)
- Browser speech (on-device, desktop Chrome only)

### Method

1. **Cold and warm load.** Clear site data, then load each model once on a measured 10 Mbps connection (cold), then reload the page (warm, cached). Record `Model load` from the Performance panel.
2. **Throughput.** Bench, "Transcribe an audio file", with a fixed 5-minute recording of a lecture (use the same WAV on every device). Record RTF and p95 per-utterance time.
3. **Sustained live run.** Speaker console, 30 minutes of continuous speech (a recorded lecture played from a second device into the mic is fine). Note RTF and caption lag at minutes 1, 10 and 30, to catch thermal throttling and memory growth. Watch Chrome's task manager for memory.
4. **Battery.** On battery, note the percentage drop over the 30 minutes.
5. **Fan-out.** On the deployed Worker, run `node scripts/demo-speaker.mjs https://<your-worker> --listeners 200` and record p50/p95. Repeat on the LAN relay with 40 listeners (a classroom).

### Thresholds

| Metric | Pass | Investigate | Fail |
| --- | --- | --- | --- |
| RTF, sustained | under 0.5 | 0.5 to 0.8 | over 0.8 (captions fall behind) |
| Caption lag p95 | under 2.5 s | 2.5 to 4 s | over 4 s |
| Warm model load | under 10 s | 10 to 30 s | over 30 s |
| Cold model load on 10 Mbps | under 90 s | 90 to 180 s | over 180 s |
| 30-minute run | no crash, RTF at minute 30 within 25% of minute 1 | | crash, or RTF more than doubles |
| Fan-out p95, 200 listeners (cloud) | under 500 ms | 500 ms to 1 s | over 1 s |

The engine adapts already. Partial captions slow down when transcription is slow, and switch off when RTF goes above 0.6. The test question is whether **finals** keep up.

### Decisions this feeds

- The default engine per device tier (`apps/web/src/engines/detect.ts`, `recommendEngine`).
- Whether Tier A phones should default to browser speech.
- Whether to ship a smaller quantised Moonshine build (for example a q8 encoder).

## Risk 2: accuracy on Indian-accented and code-mixed English

### Data

1. **Public benchmarks, for a quick baseline without recruiting.**
   - **Svarah** (AI4Bharat, Interspeech 2023, CC BY 4.0).
     - 9.6 hours of Indian-accented English from 117 speakers in 65 districts across 19 states.
     - Read and spontaneous speech.
     - Speakers' first languages cover 19 of India's 22 scheduled languages.
     - Sources: [paper](https://arxiv.org/abs/2305.15760), [data](https://huggingface.co/datasets/ai4bharat/Svarah).
   - **MUCS 2021** code-switched Hindi-English test set (CC BY-SA 4.0).
     - About 5 to 6 hours of code-switched speech, from spoken technical tutorials.
     - Close to the classroom use case.
     - Sources: [OpenSLR 104](https://openslr.org/104/), [challenge paper](https://www.isca-archive.org/interspeech_2021/diwan21_interspeech.html).
     - The transcripts mix Devanagari and Latin script. Score them with CER as well as WER, and decide up front how to treat transliteration (see below).
2. **Our own recordings: the real target.**
   - Recruit 20 or more speakers across North, South, East, West and North-East India, balanced by gender, including at least 5 working teachers.
   - Each speaker records:
     - the bench passages "Classroom, Indian English", "Code-mixed Hindi and English" and "Names, places and numbers";
     - plus 2 minutes of spontaneous explanation of a topic they teach. Transcribe this by hand as the reference.
   - Record on a mid-range phone held at lectern distance (about 1 m), in a real classroom with normal noise.
   - Keep the WAVs (with consent) so every engine is scored on the same audio.

### Method

1. File-mode bench runs for the on-device models on every recording.
2. Live read-aloud runs for browser speech (`en-IN` and `en-US`, cloud and on-device) and for WhisperLive (`small` and `large-v3-turbo`) on a subset.
3. Export CSV. Break WER down by speaker region, read versus spontaneous, and passage.
4. For code-mixed passages, run two scoring passes:
   - (a) strict;
   - (b) with the equivalence list for common romanised spellings.

   Report both. A large gap means spelling variance, not recognition failure.
5. Count named-entity errors separately in the names passage (people, places, institutions). These hurt comprehension most, and the word-replacement and vocabulary features can fix many of them.

### Thresholds (indicative, to revise after the first data)

| Speech | Good | Usable | Not fit |
| --- | --- | --- | --- |
| Read Indian English | WER under 10% | 10 to 20% | over 20% |
| Spontaneous Indian English | under 15% | 15 to 25% | over 25% |
| Code-mixed (with equivalences) | under 20% | 20 to 35% | over 35% |

### Known limitations going in

- **Moonshine models are English-only.**
  - On code-mixed speech, expect the Hindi words to come out as English-sounding guesses.
  - If Moonshine's code-mixed WER is "not fit", the recommender should route code-mixed rooms to Whisper or browser speech.
- **Whisper's output script depends on the `language` setting.**
  - `en` tends to romanise or translate Hindi words.
  - `hi` writes Devanagari.
  - Decide, with deaf and hard-of-hearing users, which script they prefer to read for code-mixed lectures before choosing the default.
- **Chrome on-device recognition has no `en-IN` pack.**
  - It uses the US English model for `en-IN`.
  - Measure on-device `en-IN` separately from cloud `en-IN`.

## Schedule (10 working days)

| Day | Work |
| --- | --- |
| 1 | Deploy the Worker. Collect devices. Record the 5-minute reference lecture. Dry-run the bench on Tier D. |
| 2 to 3 | Risk 1, method steps 1 and 2 (load and throughput) on all tiers. |
| 4 | Risk 1, step 3 (30-minute sustained runs) on Tiers A and B, plus battery. Fan-out tests. |
| 3 to 5 | In parallel: recruit speakers and run the Svarah and MUCS baselines in file mode on Tier D. |
| 6 to 8 | Speaker recording sessions, then file-mode and live scoring. |
| 9 | Analysis: WER by region and engine, latency tables. Pick defaults per device tier and language. |
| 10 | Write up. Update `recommendEngine` and the model presets. List the follow-ups (fine-tuned models, vocabulary packs for schools). |

## What to hand back

- `bench-results/*.csv` from every device, merged.
- A one-page table: recommended engine per (device tier, language or accent), with the measured RTF and WER behind each choice.
- Bugs found, with the device and browser.

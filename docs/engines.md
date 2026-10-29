# Choosing a speech engine

Caption Room turns speech into text on the speaker's side, using one of several engines. The speaker console suggests one based on what the device can do and the room's spoken language, and you can change it at any time before you start. This page explains the choices.

## The engines

| Engine                                    | Where the audio goes                                                                         | Languages                             | What the device needs                                                                       | Internet                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| **Moonshine Tiny** (on this device)       | Nowhere: it stays on the device                                                              | English only                          | About 55 MB download once (80 MB for the GPU version). Runs on most laptop CPUs.            | Only for the first download    |
| **Moonshine Base** (on this device)       | Nowhere                                                                                      | English only                          | About 127 MB (158 MB for GPU). Comfortable with a GPU (WebGPU).                             | Only for the first download    |
| **Whisper Tiny English** (on this device) | Nowhere                                                                                      | English only                          | About 68 MB (124 MB for GPU). Handy for comparing accuracy with Moonshine.                  | Only for the first download    |
| **Whisper Base** (on this device)         | Nowhere                                                                                      | 90+, including Hindi                  | About 140 MB (210 MB for GPU). Slower than Moonshine; a GPU helps a lot.                    | Only for the first download    |
| **Whisper Small** (on this device)        | Nowhere                                                                                      | 90+, including Hindi                  | About 253 MB (303 MB for GPU). Needs a desktop-class GPU; hidden on devices without WebGPU. | Only for the first download    |
| **Browser speech**                        | The browser maker's speech service (Google for Chrome, Microsoft for Edge, Apple for Safari) | Many, including `en-IN` and `hi-IN`   | Chrome, Edge or Safari. Very light on the device.                                           | Yes, all the time              |
| **Browser speech, on-device mode**        | Nowhere                                                                                      | The languages Chrome offers packs for | Chrome on a desktop or laptop (version 139 or later), plus a one-time language download     | Only for the language download |
| **WhisperLive server**                    | Your own server                                                                              | 90+                                   | A GPU server you run (see [deploy.md](deploy.md#whisperlive-for-big-events))                | A network path to that server  |

Model sizes come from `apps/web/src/engines/models.ts`. Downloads are cached by the browser, so the second start is much faster. In [LAN mode](../relay/README.md#offline-speech-models), the relay can serve the model files itself, so on-device engines work with no internet at all.

### How the suggestion is made

`recommendEngine` in `apps/web/src/engines/detect.ts` picks, in order:

- **English rooms**
  - iPhone home-screen app without WebGPU: Moonshine Tiny on the CPU, live partial captions off (iOS does not allow browser speech there).
  - A GPU and a capable device: Moonshine Base on the GPU.
  - A capable device without a GPU: Moonshine Tiny on the CPU.
  - A weak device (fewer than 4 CPU cores or under 4 GB of memory): browser speech if available, otherwise Moonshine Tiny with live partial captions off.
- **Other languages** (Moonshine is English-only)
  - A GPU and a capable device: Whisper Base on the GPU.
  - Otherwise browser speech, if available.
  - Otherwise Whisper Base on the CPU, with live partial captions off.

These defaults are a starting point. The field tests in [risk-tests.md](risk-tests.md) exist to replace them with measured ones.

## Reading the Performance panel

Open **Performance** in the speaker console while captioning. The most useful numbers:

- **Real-time factor (RTF)** is the time the device takes to transcribe a piece of speech, divided by the length of that speech. An RTF of 0.25 means 4 seconds of speech take 1 second to transcribe. Below 1 the device keeps up; **below 0.5 is comfortable**, and is the pass mark in the field tests. When RTF reaches 0.6, the engine stops sending live partial captions so that the final captions keep up. Shown for on-device engines.
- **Caption lag** is the time from the end of a spoken phrase to its final caption. It includes the short pause the engine waits for to be sure the speaker has stopped (about 0.4 s), any queue, and the transcription itself. **Under 2.5 s is good**; over 4 s, listeners will notice.
- **Queue** is how many phrases are waiting to be transcribed. It should stay at 0 or 1. If it keeps growing, the device is falling behind.
- **Partial updates** shows how often live partial captions are refreshed. The gap adapts to the device's speed (between 0.5 and 3 s), or shows "paused to keep up".
- **Model load** is how long the model took to download, compile and warm up.
- **Server round trip** is the time for a message to reach the room server and come back.
- **Unsent captions** counts captions spoken while offline, waiting to be delivered when the connection returns.

The panel warns you when RTF goes above 0.8 or caption lag above 4 s. If that happens:

1. Plug the laptop in. Battery saver modes slow the CPU and GPU down a lot.
2. Turn off **Live partial captions**.
3. Choose a smaller model (Moonshine Tiny), or switch **Runs on** to the GPU if there is one.
4. Close other heavy tabs and apps.
5. Switch to **Browser speech**, which costs the device almost nothing, if sending audio to the browser's speech service is acceptable.

## Indian English and code-mixed speech

How well each engine handles Indian accents and Hindi-English mixing has **not been measured yet**. That is the second study in [risk-tests.md](risk-tests.md), and field results are very welcome (use the **Field test result** issue form). Until then, this is what we know going in.

**Choose the spoken language when you create the room.** "English (India)" (`en-IN`) and "Hindi" (`hi-IN`) are both offered. The engines take their default language from it.

**Moonshine is English-only.** It is fast and handles English well, but the Hindi words in a code-mixed sentence come out as English-sounding guesses. Use it for lectures that are mostly English. For Hinglish, use Whisper or browser speech.

**Whisper's output script depends on its language setting.** For the multilingual Whisper models (Base and Small, on the device or through WhisperLive), the **Language** field matters:

- `en`: output is in Latin script. Hindi words tend to be romanised, or translated into English.
- `hi`: output is in Devanagari.
- Empty (auto-detect): Whisper guesses the language for each phrase, so the script can switch back and forth.

Which script is best to read depends on your audience. For code-mixed lectures, ask the deaf and hard of hearing people who will read the captions which they prefer, then set the language to match.

**Chrome's on-device recognition has no Indian English pack.** For `en-IN`, Chrome's on-device mode uses the US English model, while Chrome's cloud speech service has real Indian English support. Accuracy can differ a lot between the two, so if you test, measure them separately.

## Custom vocabulary and word replacements

Names, places and subject words are the mistakes that hurt understanding most. The speaker console has two tools for them.

### Word replacements

**Word replacements** fix text after recognition, on the speaker's device, before captions are sent. They work with every engine, for both partial and final captions.

Write one rule per line, `wrong => right` (`->` and `=` also work). Lines starting with `#` are notes. Matching ignores upper and lower case, only matches whole words or phrases, and longer phrases win over shorter ones. Leave the right side empty to remove a word.

```text
# Names the engine keeps getting wrong
priya sharma => Priya Sharma
dr rao => Dr Rao
# Subject words
photo synthesis => photosynthesis
# Remove a filler word
um =>
```

### Vocabulary

The **Vocabulary** box takes names and jargon, separated by commas or new lines (up to 200). It does not change text; it nudges the recogniser towards those words, and only some engines can use it:

- **Browser speech, on-device mode** (Chrome on a desktop, version 142 or later): sent as boosted phrases.
- **WhisperLive:** sent as hotwords.
- On-device Moonshine and Whisper, and browser speech through the cloud service, ignore it. Use word replacements instead.

Changes take effect the next time you press start.

## Known browser speech quirks

The Web Speech API behaves differently in each browser. Caption Room works around what it can:

- **Sessions stop on their own.** Browsers end a recognition session after a pause or after a while. Caption Room restarts it immediately, as Web Captioner did, and keeps any words that were still in progress. Once in a while a word spoken exactly during a restart can be missed.
- **Android Chrome and continuous mode.** Continuous recognition on Android is less reliable than on desktop: sessions end more often, and Chrome sometimes delivers the previous final result again, word for word. Caption Room ignores an identical final that arrives within 1.5 seconds on Android only (elsewhere, a repeat is real speech).
- **iPhone and iPad home-screen apps cannot use speech recognition.** iOS does not allow it in web apps added to the home screen. Open Caption Room in Safari itself, or use an on-device model. The suggestion does this automatically.
- **Firefox does not currently offer speech recognition to websites.** Use an on-device model in Firefox, or Chrome, Edge or Safari for browser speech.
- **The cloud service needs a steady connection.** On a network hiccup the status shows "reconnecting to the speech service", and Caption Room retries with increasing waits of up to 10 seconds.
- **On-device mode** is only offered on desktop browsers that support it (Chrome 139 or later), never on phones. The language pack downloads when you click "Download language pack" (Chrome only allows that from a click), and not every language has one.
- **Timings are estimates.** Browser speech gives no timestamps, so subtitle times in SRT and WebVTT exports are estimated from when the words first appeared.

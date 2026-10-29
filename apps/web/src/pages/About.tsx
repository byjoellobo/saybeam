import { navigate } from '../lib/router';

export function About() {
  return (
    <main class="narrow prose" id="main">
      <p>
        <a href="/" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          Back to Caption Room
        </a>
      </p>
      <h1>About Caption Room</h1>
      <p>
        Caption Room brings back something people relied on and lost. Web Captioner, a free tool built on Chrome's speech API, ran from 2017 until 31 October 2023. Its share link let anyone follow the captions on their own device. When it shut down, its code was released under the MIT licence, but nothing took the place of shareable captions. What exists now is either billed per live minute or is a developer library rather than something a teacher can just use.
      </p>
      <p>Caption Room is free, open source and built to be run by anyone: a school, a place of worship, a conference, or one person with a laptop.</p>

      <h2>Privacy</h2>
      <ul>
        <li>
          <strong>On-device engines</strong> (Moonshine, Whisper) recognise speech inside the speaker's browser. Audio never leaves that device; only caption text is sent to the room.
        </li>
        <li>
          <strong>Browser speech</strong> sends audio to the browser maker's speech service (Google for Chrome, Microsoft for Edge, Apple for Safari), unless you switch on Chrome's on-device mode.
        </li>
        <li>
          <strong>WhisperLive</strong> sends audio to the server address you enter, typically your own.
        </li>
        <li>Rooms have no accounts. Caption text is stored only so latecomers can scroll back and the speaker can download it, and is deleted 24 hours after the last caption. The LAN relay keeps everything in memory and forgets it when closed.</li>
        <li>Listeners are anonymous. Display settings stay on their own phone.</li>
      </ul>

      <h2 id="lan">LAN mode for weak internet</h2>
      <p>
        In a school with poor connectivity, run the small Caption Room relay on the teacher's laptop. The laptop serves the app and relays captions over the school Wi-Fi or its own hotspot, so phones need no internet at all. Open <code>http://localhost:7300</code> on the laptop to caption (browsers only allow the microphone on localhost or HTTPS), and students scan the QR code it shows. With the optional models folder, the on-device speech models load from the laptop too.
      </p>

      <h2>Engines</h2>
      <ul>
        <li>
          <strong>Moonshine</strong> (Useful Sensors, MIT): fast English models designed for live transcription on small devices.
        </li>
        <li>
          <strong>Whisper</strong> (OpenAI, MIT): multilingual, including Hindi and code-mixed speech. Heavier.
        </li>
        <li>
          <strong>Browser speech</strong>: the Web Speech API in Chrome, Edge and Safari. The fallback for devices too slow for on-device models.
        </li>
        <li>
          <strong>WhisperLive</strong> (Collabora, MIT): your own GPU server, for big events.
        </li>
      </ul>
      <p>
        Accuracy on Indian-accented and code-mixed English has not been measured yet, and neither has latency on low-end devices. The <a href="/bench" onClick={(e) => (e.preventDefault(), navigate('/bench'))}>field-test bench</a> exists to measure both.
      </p>

      <h2>Credits</h2>
      <p>
        Built with transformers.js and ONNX Runtime (Apache 2.0), Silero VAD (MIT), Preact (MIT), Cloudflare Durable Objects, and the Atkinson Hyperlegible typeface from the Braille Institute (SIL Open Font License). Caption Room itself is MIT licensed.
      </p>
    </main>
  );
}

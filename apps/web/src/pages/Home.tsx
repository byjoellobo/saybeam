import { useEffect, useState } from 'preact/hooks';
import { formatRoomCode, normalizeRoomCode, type ServerInfo } from '@caption-room/protocol';
import { createRoom, describeRoom, fetchInfo, ApiError } from '../lib/api';
import { navigate, paths } from '../lib/router';
import { forgetRoom, listSavedRooms, saveRoom, type SavedRoom } from '../lib/storage';

const LANGUAGES: ReadonlyArray<[string, string]> = [
  ['en-IN', 'English (India)'],
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-AU', 'English (Australia)'],
  ['hi-IN', 'Hindi'],
  ['es-ES', 'Spanish'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
];

export function Home() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [code, setCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState(() => (navigator.language?.startsWith('en-') ? (LANGUAGES.some(([l]) => l === navigator.language) ? navigator.language : 'en-IN') : 'en-IN'));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<SavedRoom[]>(() => listSavedRooms());

  useEffect(() => {
    void fetchInfo().then(setInfo);
  }, []);

  const join = async (e: Event) => {
    e.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (!normalized) {
      setJoinError('Room codes are 6 letters and numbers, like ABC 234.');
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      await describeRoom(normalized);
      navigate(paths.listen(normalized));
    } catch (err) {
      setJoinError(err instanceof ApiError && err.status === 404 ? 'No room with that code. Check it with the speaker.' : err instanceof Error ? err.message : 'Could not join.');
    } finally {
      setJoining(false);
    }
  };

  const create = async (e: Event) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const room = await createRoom({ title: title.trim(), lang, allowExport: true });
      saveRoom({ ...room, title: title.trim(), createdAt: Date.now() });
      navigate(paths.speak(room.code));
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create a room.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <main class="home" id="main">
      <header class="hero">
        <div class="brand">
          <img src="/icons/icon.svg" alt="" width={56} height={56} />
          <h1>Caption Room</h1>
        </div>
        <p class="lede">Live captions that everyone in the room can follow on their own phone. Free, open source, and private by default: speech can be recognised right on the speaker's device.</p>
        {info?.mode === 'lan' && (
          <p class="lan-badge" role="note">
            <strong>LAN mode.</strong> This laptop is the caption server. Phones on the same Wi-Fi can join without internet.
          </p>
        )}
      </header>

      <div class="home-grid">
        <section class="card" aria-labelledby="join-title">
          <h2 id="join-title">Follow captions</h2>
          <p class="muted">Enter the code shown by the speaker, or scan their QR code.</p>
          <form onSubmit={join} class="stack">
            <label class="sr-only" for="room-code">
              Room code
            </label>
            <input
              id="room-code"
              class="code-input"
              value={code}
              onInput={(e) => setCode(e.currentTarget.value.toUpperCase())}
              placeholder="ABC 234"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              inputMode="text"
              maxLength={9}
              aria-describedby={joinError ? 'join-error' : undefined}
            />
            {joinError && (
              <p id="join-error" class="error" role="alert">
                {joinError}
              </p>
            )}
            <button class="btn btn-primary btn-large" type="submit" disabled={joining}>
              {joining ? 'Joining...' : 'Show captions'}
            </button>
          </form>
        </section>

        <section class="card" aria-labelledby="start-title">
          <h2 id="start-title">Start captioning</h2>
          <p class="muted">For teachers, speakers and organisers. You get a room code and QR to put on screen.</p>
          <form onSubmit={create} class="stack">
            <label class="field">
              <span>Session name (optional)</span>
              <input value={title} maxLength={120} onInput={(e) => setTitle(e.currentTarget.value)} placeholder="Physics, Class 11B" />
            </label>
            <label class="field">
              <span>Spoken language</span>
              <select value={lang} onChange={(e) => setLang(e.currentTarget.value)}>
                {LANGUAGES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {createError && (
              <p class="error" role="alert">
                {createError}
              </p>
            )}
            <button class="btn btn-primary btn-large" type="submit" disabled={creating}>
              {creating ? 'Creating room...' : 'Create a room'}
            </button>
          </form>
        </section>
      </div>

      {rooms.length > 0 && (
        <section class="card recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Your rooms on this device</h2>
          <ul class="room-list">
            {rooms.map((r) => (
              <li key={r.code}>
                <a href={paths.speak(r.code)} onClick={(e) => (e.preventDefault(), navigate(paths.speak(r.code)))}>
                  <span class="room-code-small">{formatRoomCode(r.code)}</span> {r.title || 'Untitled session'}
                </a>
                <button
                  type="button"
                  class="btn btn-small btn-ghost"
                  aria-label={`Forget room ${r.code}`}
                  onClick={() => {
                    forgetRoom(r.code);
                    setRooms(listSavedRooms());
                  }}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="how" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol>
          <li>
            <strong>The speaker starts a room</strong> on a laptop or phone and picks a speech engine: a model that runs on the device, the browser's speech service, or your own WhisperLive server.
          </li>
          <li>
            <strong>The audience scans the QR code.</strong> No app, no account. Each person sets their own text size and colours, scrolls back, and jumps back to live.
          </li>
          <li>
            <strong>Fix mistakes live.</strong> A helper can open a corrector link and edit captions as they appear. Download the transcript as text, SRT or WebVTT afterwards.
          </li>
        </ol>
        <p class="muted">
          Weak internet? Run the{' '}
          <a href="/about#lan" onClick={(e) => (e.preventDefault(), navigate('/about'))}>
            LAN relay
          </a>{' '}
          on the teacher's laptop and captions stay on the local network. Testing a new device or accent? Use the{' '}
          <a href="/bench" onClick={(e) => (e.preventDefault(), navigate('/bench'))}>
            field-test bench
          </a>
          .
        </p>
      </section>

      <footer class="site-footer">
        <span>Caption Room {info?.version ? `v${info.version}` : ''}</span>
        <span>MIT licensed. In memory of Web Captioner (2017 to 2023).</span>
        <a href="/about" onClick={(e) => (e.preventDefault(), navigate('/about'))}>
          About and privacy
        </a>
      </footer>
    </main>
  );
}

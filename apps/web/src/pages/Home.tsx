import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { formatRoomCode, type ServerInfo } from '@saybeam/protocol';
import { createRoom, describeRoom, fetchInfo, ApiError } from '../lib/api';
import { navigate, paths } from '../lib/router';
import { forgetRoom, listSavedRooms, saveRoom, type SavedRoom } from '../lib/storage';
import { SOURCE_URL } from '../lib/meta';
import { parseJoinInput } from '../lib/links';
import { AppLink } from '../components/AppLink';
import { SiteHeader } from '../components/SiteHeader';

/** The home page headline, shown the way a live caption arrives: word by word. */
const HEADLINE = ['Live', 'captions', 'for', 'everyone', 'in', 'the', 'room.'] as const;

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
  const [isPrivate, setIsPrivate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<SavedRoom[]>(() => listSavedRooms());

  useEffect(() => {
    void fetchInfo().then(setInfo);
  }, []);

  const join = async (e: Event) => {
    e.preventDefault();
    const input = parseJoinInput(code);
    // A pasted full link (including a private room's #k= secret) goes straight there.
    if (input.kind === 'link') {
      navigate(input.path);
      return;
    }
    if (input.kind === 'invalid') {
      setJoinError('Room codes are 6 letters and numbers, like ABC 234.');
      return;
    }
    const normalized = input.code;
    setJoining(true);
    setJoinError(null);
    try {
      const summary = await describeRoom(normalized);
      if (summary.private) {
        setJoinError('This is a private room. Scan the QR code, or paste the full link from the organiser here.');
        return;
      }
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
      const room = await createRoom({ title: title.trim(), lang, allowExport: true, private: isPrivate });
      saveRoom({ ...room, title: title.trim(), createdAt: Date.now() });
      navigate(paths.speak(room.code));
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create a room.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="page">
      <SiteHeader />
      <main class="home" id="main">
        {info?.mode === 'lan' && (
          <p class="lan-badge" role="note">
            <strong>LAN mode.</strong> This laptop is the caption server. Phones on the same Wi-Fi can join without internet.
          </p>
        )}
        <div class="hero-grid">
          <section class="hero-caption" aria-labelledby="hero-title">
            <span class="pill pill-live hero-live" aria-hidden="true">
              <span class="pill-dot" />
              Live
            </span>
            <div class="hero-stream">
              <p class="hero-earlier" aria-hidden="true">
                Good morning, everyone, and welcome back.
              </p>
              <h1 id="hero-title" class="hero-title">
                {HEADLINE.map((word, i) => (
                  <Fragment key={word}>
                    {i > 0 && ' '}
                    <span class="word" style={{ '--i': String(i) }}>
                      {word}
                    </span>
                  </Fragment>
                ))}
                <span class="caret" aria-hidden="true" />
              </h1>
              <p class="hero-lede">
                You speak, and everyone in the room reads along on their own phone, at their own text size and colours. No app, no account. Speech can be recognised right on the
                speaker's device, so audio does not have to leave the room. Free and open source.
              </p>
            </div>
          </section>

          <div class="tasks">
            <section class="task" aria-labelledby="join-title">
              <h2 id="join-title">Follow captions</h2>
              <p class="task-lede">Enter the code on the speaker's screen, or scan their QR code with your camera.</p>
              <form onSubmit={join} class="task-form">
                <label class="sr-only" for="room-code">
                  Room code
                </label>
                <input
                  id="room-code"
                  class="code-input"
                  value={code}
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    // Keep pasted links as typed: a private room's secret is case-sensitive.
                    setCode(v.includes('/') ? v : v.toUpperCase());
                  }}
                  placeholder="ABC 234"
                  autocomplete="off"
                  autocapitalize="characters"
                  spellcheck={false}
                  inputMode="text"
                  maxLength={300}
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

            <section class="task" aria-labelledby="start-title">
              <h2 id="start-title">Start captioning</h2>
              <p class="task-lede">For teachers, speakers and organisers. You get a room code and a QR code to put on screen.</p>
              <form onSubmit={create} class="task-form">
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
                <label class="switch">
                  <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.currentTarget.checked)} />
                  <span>
                    Private room
                    <small>Only people with the QR code or full link can follow. The room code alone is not enough.</small>
                  </span>
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
        </div>

        {rooms.length > 0 && (
          <section class="recent" aria-labelledby="recent-title">
            <h2 id="recent-title">Your rooms on this device</h2>
            <ul class="room-list">
              {rooms.map((r) => (
                <li key={r.code} class="room-row">
                  <AppLink href={paths.speak(r.code)} class="room-link">
                    <span class="room-code-small">{formatRoomCode(r.code)}</span>
                    <span class="room-title">{r.title || 'Untitled session'}</span>
                  </AppLink>
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
          <ol class="steps">
            <li>
              <strong>The speaker starts a room</strong>
              <span>
                On a laptop or phone, with a speech engine that fits the device: a model that runs on the device itself, the browser's speech service, or your own WhisperLive
                server.
              </span>
            </li>
            <li>
              <strong>The audience scans the QR code</strong>
              <span>No app and no account. Each person sets their own text size and colours, scrolls back to reread, and jumps back to live.</span>
            </li>
            <li>
              <strong>Mistakes get fixed live</strong>
              <span>A helper can open a corrector link and edit captions as they appear. Download the transcript as text, SRT or WebVTT afterwards.</span>
            </li>
          </ol>
          <p class="how-more">
            Weak internet? Run the <AppLink href="/about#lan">LAN relay</AppLink> on the teacher's laptop and captions stay on the local network. Testing a new device or accent?
            Use the <AppLink href="/bench">field-test bench</AppLink>.
          </p>
        </section>
      </main>

      <footer class="site-footer">
        <span>Saybeam{info?.version ? ` v${info.version}` : ''}</span>
        <span>
          Free software under the GNU AGPL. <a href={SOURCE_URL}>Source code</a>
        </span>
        <span>In memory of Web Captioner (2017 to 2023).</span>
        <AppLink href="/about">About and privacy</AppLink>
      </footer>
    </div>
  );
}

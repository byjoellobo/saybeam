# Deploying Saybeam

There are three ways to run Saybeam. Pick the one that fits the room:

| Setup                                             | Good for                                          | Needs                                                    |
| ------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| [Cloudflare](#cloudflare)                         | Most people: a permanent address anyone can reach | A free Cloudflare account                                |
| [WhisperLive server](#whisperlive-for-big-events) | Big events where accuracy matters most            | A GPU server you control, alongside one of the other two |
| [LAN mode](#lan-mode)                             | Classrooms with weak or no internet               | A laptop                                                 |

## Cloudflare

The cloud version runs as one Cloudflare Worker. The Worker serves the web app as static files, answers a small HTTP API, and gives each room its own Durable Object with SQLite storage.

### Prerequisites

- A Cloudflare account. The free plan is enough to start (see [Costs](#costs-on-the-workers-free-plan)).
- Node 24 (22 also works) and a copy of this repository.

```bash
npm install
```

### Deploy

```bash
npx wrangler login       # opens a browser to authorise Wrangler, once per machine
npm run deploy           # builds apps/web, then deploys apps/worker with the app as static assets
```

Wrangler prints the address, for example `https://saybeam.<your-subdomain>.workers.dev`. On a brand-new account it may first ask you to choose a `workers.dev` subdomain.

Check that it works:

1. Open `https://<your-address>/api/info`. You should see `{"mode":"cloud", ...}`.
2. Open the address, create a room, and join it from a phone.
3. Optionally run the protocol checks against it: `npm run conformance -- https://<your-address>`. They create a few small test rooms, which delete themselves after 24 hours.

The Worker's name (and so its `workers.dev` address) is `name` in [`apps/worker/wrangler.jsonc`](../apps/worker/wrangler.jsonc). The version reported by `/api/info` is `vars.APP_VERSION` in the same file. `npm run release` keeps it in step with the rest of the project ([releasing.md](releasing.md)), so do not edit it by hand.

### Deploy from GitHub Actions

The repository's **Deploy** workflow ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) runs the same `npm run deploy` for you. It starts after each release, and you can run it by hand from the **Actions** tab on any branch or tag.

It needs two secrets in a GitHub environment called `production`: `CLOUDFLARE_API_TOKEN` (an API token made from the **Edit Cloudflare Workers** template) and `CLOUDFLARE_ACCOUNT_ID`. Without the token it deploys nothing and says so, which keeps forks working. This also works in your own fork: add the environment and the secrets there. The full setup is in [ci-cd.md](ci-cd.md#secrets-and-settings).

On a brand-new Cloudflare account, choose a `workers.dev` subdomain (or deploy once from your computer) before the first automated deploy, because Wrangler cannot ask for it in CI.

### Custom domain

Your domain must be an active zone on your Cloudflare account. Then either:

- add a route to `apps/worker/wrangler.jsonc` and deploy again:

  ```jsonc
  "routes": [{ "pattern": "captions.example.org", "custom_domain": true }]
  ```

- or, in the Cloudflare dashboard, open **Workers & Pages**, choose the Worker, then **Settings**, **Domains & Routes**, **Add**, **Custom Domain**.

Cloudflare creates the DNS record and the certificate for you. A hostname that already has a CNAME record cannot be used. Details: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

### Rate limits

`apps/worker/wrangler.jsonc` declares two [rate limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Both are keyed by client network: the IP address, or the /64 prefix for IPv6.

| Binding          | Limit        | Applies to                                 | Why                                                                                                                  |
| ---------------- | ------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `CREATE_LIMITER` | 10 per 60 s  | `POST /api/rooms`                          | Keeps room codes and storage tidy, and stops a script from creating rooms in bulk.                                   |
| `JOIN_LIMITER`   | 600 per 60 s | `GET /api/rooms/:code` and `GET /ws/:code` | Slows down anyone trying to guess room codes. It is generous because a whole school can share one public IP address. |

Things to know:

- `namespace_id` must be a number that is unique within your Cloudflare account. If another Worker on your account already uses `4711` or `4712`, pick different numbers.
- Cloudflare applies these limits per location and approximately: a burst can go slightly over before the count catches up. That is fine for this purpose.
- `period` can only be 10 or 60 seconds.
- If a binding is missing (for example, you removed it), the Worker logs a warning once and runs without that limit.

Each WebSocket connection is also rate limited inside the room itself, whatever the platform. See [protocol.md](protocol.md#rules).

### The "Source code" link and the AGPL

Saybeam is licensed under the AGPL-3.0-or-later. Section 13 of the licence says that if you **modify** Saybeam and let people use your modified version over a network, you must offer those users the source code of your version, for free.

The app has a "Source code" link for exactly this. Its target is set when the web app is built, from the `SAYBEAM_SOURCE_URL` environment variable. If you run unmodified code, you can leave it alone and the link points to this project. If you run a modified version, publish your changes (a public fork is easiest) and point the link at them:

```bash
# macOS, Linux, Git Bash
SAYBEAM_SOURCE_URL=https://github.com/your-name/saybeam npm run deploy
```

```powershell
# Windows PowerShell
$env:SAYBEAM_SOURCE_URL = "https://github.com/your-name/saybeam"
npm run deploy
```

The variable is read at build time, so set it for whichever command builds the web app: `npm run deploy`, `npm run build` or `npm run build:relay` (the LAN relay embeds the build). This is a plain-language summary, not legal advice; the [licence text](../LICENSE) is what counts.

### Costs on the Workers Free plan

Durable Objects are available on the Workers Free plan, as long as they use the SQLite storage backend. Saybeam does (`new_sqlite_classes` in `wrangler.jsonc`). Source: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), both checked in October 2026. Prices change, so check those pages before you rely on the numbers below.

What the Free plan includes each day (limits reset at 00:00 UTC):

| What                    | Free allowance      | What uses it in Saybeam                                                                                                                                                              |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Static assets           | Free and unlimited  | The web app itself: every page, script and font.                                                                                                                                     |
| Worker requests         | 100,000 per day     | API calls and WebSocket connections: a few per person joining or reconnecting.                                                                                                       |
| Durable Object requests | 100,000 per day     | Connections to a room, plus incoming WebSocket messages counted at 20 messages per request. Outgoing messages (captions sent to phones) are free.                                    |
| Durable Object duration | 13,000 GB-s per day | Time a room is awake. Each object is billed as 128 MB, so this is about 28 hours of awake time per day. A room that is hibernating, or only waiting between messages, is not billed. |
| SQLite rows written     | 100,000 per day     | A few rows per final caption or correction.                                                                                                                                          |
| SQLite rows read        | 5 million per day   | Joins, reconnects and history requests.                                                                                                                                              |
| SQLite storage          | 5 GB in total       | Captions. Rooms delete themselves 24 hours after their last activity.                                                                                                                |

**In plain terms:** the free plan comfortably covers everyday use, such as several classes or services a day with a few hundred listeners each. The number of listeners matters much less than the hours of speech, because captions sent out to phones are free and keepalive pings are answered without waking the room. As a rough, cautious estimate, if every room stayed awake for its whole session, the free duration allowance would cover about 28 room-hours of live captioning per day; in practice it stretches further. This is an estimate, not a measurement.

On the Free plan, when a daily limit is reached, further operations of that type **fail** until the next reset: new captions would stop being stored and broadcast. For anything you cannot afford to interrupt (a conference, a weekly service with a large audience), use the Workers Paid plan, which starts at US$5 a month and includes much larger allowances. The Cloudflare dashboard shows your daily usage.

## WhisperLive for big events

For a conference or a large service you may want the best accuracy you can get, and to take the work off the speaker's laptop. [collabora/WhisperLive](https://github.com/collabora/WhisperLive) runs Whisper on a GPU server and streams results back in real time. Saybeam's "WhisperLive server" engine connects to it directly from the speaker's browser; listeners and the room server are unchanged.

You need a Linux server with an NVIDIA GPU, the NVIDIA driver, Docker, and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) (it makes `--gpus` work). A CPU-only image exists too, but is too slow for live captions with larger models.

### Run the server

The project publishes ready-made images on GitHub's container registry: `ghcr.io/collabora/whisperlive-gpu` and `ghcr.io/collabora/whisperlive-cpu`. The quickest start, from the [WhisperLive README](https://github.com/collabora/WhisperLive#whisper-live-server-in-docker):

```bash
docker run -it --gpus all -p 9090:9090 ghcr.io/collabora/whisperlive-gpu:latest
```

For an event, run it in the background with an API key, a cache for downloaded models, and the port open only to the proxy on the same machine:

```bash
export WHISPERLIVE_KEY="$(openssl rand -hex 24)"     # keep this; the speaker types it into Saybeam

docker run -d --name whisperlive --restart unless-stopped \
  --gpus all \
  -p 127.0.0.1:9090:9090 \
  -v whisperlive-cache:/root/.cache \
  ghcr.io/collabora/whisperlive-gpu:latest \
  python run_server.py --port 9090 --backend faster_whisper \
    --max_clients 4 --max_connection_time 3600 --api_key "$WHISPERLIVE_KEY"
```

- The image's default command is `python run_server.py`, so anything after the image name replaces it with your own flags.
- `--max_clients` (default 4) is how many speakers can use the server at once. Each Saybeam speaker uses one connection.
- `--max_connection_time` is how long, in seconds, the server keeps one connection open. **The default is 300 seconds** (5 minutes; some parts of the WhisperLive README say 600). Saybeam reconnects by itself when the server closes the connection and does not lose words, so the default works. A longer value, such as an hour, just means fewer reconnects.
- `--api_key` makes the server refuse connections without the key. Saybeam sends the key in the WebSocket handshake when you fill in the "API key" field. API key support arrived in WhisperLive 0.10.0.
- The model is chosen by the speaker in Saybeam (`small` by default; `large-v3-turbo` is a good choice on a strong GPU). The server downloads each model the first time it is used, so connect once before the event starts.

### Put it behind HTTPS (wss://)

Browsers refuse unencrypted `ws://` connections from a page served over HTTPS, which includes every cloud deployment. Put the server behind a proxy that provides `wss://`. [Caddy](https://caddyserver.com/) does this with almost no configuration: it gets and renews the certificate automatically and proxies WebSocket connections without extra settings.

1. Point a DNS name (for example `whisper.example.org`) at the server, and open ports 80 and 443.
2. Install Caddy and use this `Caddyfile`:

   ```caddyfile
   whisper.example.org {
   	reverse_proxy 127.0.0.1:9090
   }
   ```

3. Start Caddy (`sudo systemctl reload caddy` if you installed the package, or `caddy run` in the folder with the Caddyfile).

Reloading Caddy's configuration closes open WebSocket connections; Saybeam reconnects automatically.

### Connect Saybeam

In the speaker console, choose **WhisperLive server** and enter:

- **Server address:** `wss://whisper.example.org`
- **Model:** for example `small` or `large-v3-turbo`
- **Language:** `en`, `hi`, or empty to auto-detect (see [engines.md](engines.md))
- **API key:** the value of `WHISPERLIVE_KEY`

Audio travels from the speaker's browser to your server, so only run it on a server you trust, and stop it after the event if nobody else needs it.

## LAN mode

For classrooms with weak or no internet, a single Rust binary on the teacher's laptop does everything the cloud does: it serves the app, relays captions over the school Wi-Fi or a laptop hotspot, and can serve the speech models too, so nothing needs the internet.

In short:

```bash
npm install && npm run build                              # build the web app
node scripts/fetch-models.mjs                             # optional: models for fully offline use
cargo build --release --manifest-path relay/Cargo.toml    # the relay embeds the web app
./relay/target/release/saybeam-relay --models-dir relay/models
```

The relay prints the audience address and a QR code. The teacher opens `http://localhost:7300` on the laptop itself (browsers only allow the microphone on `localhost` or HTTPS), and students scan the QR code.

- [relay/README.md](../relay/README.md): every flag, classroom setup, the Windows firewall, and offline models.
- [self-hosting.md](self-hosting.md): prebuilt binaries, Docker, and running the relay as a long-lived service.

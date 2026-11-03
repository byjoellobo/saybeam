# Self-hosting Saybeam

Saybeam runs in two ways that speak the same protocol and serve the same
web app:

- **Cloudflare** (Workers plus Durable Objects). Global, rooms survive restarts
  for 24 hours, nothing to maintain. Needs a Cloudflare account. See
  [deploy.md](deploy.md).
- **The relay** (`relay/`), a single Rust binary. It was built for a teacher's
  laptop on school Wi-Fi (see [relay/README.md](../relay/README.md)), and the
  same binary also works as an internet-facing server on your own machine:
  a VPS, a school server or a small home server.

Self-host the relay when you want no third-party cloud account, want to keep
all data on hardware you control, or need captions inside a private network.
Choose Cloudflare when you want rooms to survive restarts and do not want to
run a server.

## What to know first

- **Rooms live in memory.** Restarting or upgrading the relay drops every room
  and its transcript. Plan upgrades between sessions. Ended rooms are removed
  24 hours after their last activity; live rooms stay until the relay stops.
- **One process, one domain.** The relay does not cluster or share rooms
  between instances, so run one instance per hostname.
- **Room creation is not rate limited per client.** The relay was designed for
  a trusted LAN. It holds at most 200 rooms, and `POST /api/rooms` requires a
  JSON content type so other websites cannot create rooms through a visitor's
  browser. On the open internet, consider rate limiting `/api/rooms` at your
  proxy or firewall.
- **Use HTTPS.** Browsers only allow the microphone on `localhost` or HTTPS,
  so a speaker on another computer needs HTTPS. The steps below put Caddy in
  front of the relay; it gets certificates automatically and passes WebSockets
  through as WSS.
- **Set `--public-host`** to your public HTTPS URL (for example
  `https://captions.example.org`). It is the address in QR codes and in
  `/api/info` (`publicBase`). Without it the relay advertises the server's own
  IP address, which is wrong behind a proxy or inside a container.

## Docker

Build the image from the repository root (it builds the web app and embeds it
in the relay), or pull a released one:

```sh
docker build -t saybeam .
# or
docker pull ghcr.io/byjoellobo/saybeam:latest
```

Run it, listening on localhost only so the proxy is the only way in:

```sh
docker run -d --name saybeam --restart unless-stopped \
  -p 127.0.0.1:7300:7300 \
  ghcr.io/byjoellobo/saybeam:latest \
  --bind 0.0.0.0 --port 7300 --public-host https://captions.example.org
```

Arguments after the image name replace the default command, so repeat
`--bind 0.0.0.0 --port 7300` when you add others. The image runs as a non-root
user, has no shell, and exposes port 7300.

## HTTPS with Caddy

With the relay listening on `127.0.0.1:7300`, this `Caddyfile` is all Caddy
needs (point the domain's DNS at the server first):

```caddyfile
captions.example.org {
	reverse_proxy 127.0.0.1:7300
}
```

Caddy obtains and renews the certificate, redirects HTTP to HTTPS, and proxies
WebSocket upgrades (`/ws/...`) without extra settings. The relay's
cross-origin isolation headers (needed by the on-device speech models) work
unchanged behind HTTPS.

## docker compose

Relay and Caddy together. Save the compose file and a `Caddyfile` side by side:

```yaml
# compose.yaml
services:
  relay:
    image: ghcr.io/byjoellobo/saybeam:latest
    # build: .   # to build from a checkout of this repository instead
    command:
      - --bind
      - 0.0.0.0
      - --port
      - "7300"
      - --public-host
      - https://captions.example.org
      # Uncomment with the volume below to serve speech models locally.
      # - --models-dir
      # - /models
    # volumes:
    #   - ./models:/models:ro
    restart: unless-stopped

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped

volumes:
  caddy_data:
  caddy_config:
```

```caddyfile
# Caddyfile
captions.example.org {
	reverse_proxy relay:7300
}
```

Start with `docker compose up -d`. The relay is only reachable through Caddy
because its port is not published.

## Speech models on your server

On-device speech engines normally download model files from Hugging Face and
the ONNX Runtime from a CDN. To serve them from your own server instead (no
third-party requests, and it keeps working without internet access):

```sh
npm install
node scripts/fetch-models.mjs --out models
```

Mount the folder read-only at `/models` and pass `--models-dir /models` (see
the commented lines in the compose file, or add
`-v ./models:/models:ro ... --models-dir /models` to `docker run`).
`/api/info` then reports `localModels: true` and the web app loads everything
from `https://your-domain/models/...`.

## Without Docker

Download a binary for your platform from
[GitHub Releases](https://github.com/byjoellobo/saybeam/releases) (or build
it as described in [relay/README.md](../relay/README.md)) and run it behind
Caddy the same way. A minimal systemd unit:

```ini
# /etc/systemd/system/saybeam.service
[Unit]
Description=Saybeam relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/saybeam-relay --bind 127.0.0.1 --port 7300 --public-host https://captions.example.org
DynamicUser=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Enable it with `systemctl enable --now saybeam`. Set
`Environment=RUST_LOG=saybeam_relay=debug` in `[Service]` for
connection-level logs.

## License and your source code

Saybeam is licensed under the GNU Affero General Public License,
version 3 or later (AGPL-3.0-or-later). Running it unmodified for others needs
nothing beyond keeping the license notices. If you **modify** it and let other
people use it over a network, the AGPL requires you to offer those users the
source code of your modified version.

The web app has a "Source code" link for this. Point it at your repository
when you build:

```sh
docker build --build-arg SAYBEAM_SOURCE_URL=https://git.example.org/you/saybeam -t saybeam .
# or, building by hand
SAYBEAM_SOURCE_URL=https://git.example.org/you/saybeam npm run build
```

Licenses of the Rust crates compiled into the relay are listed in
[relay/THIRD_PARTY_LICENSES.md](../relay/THIRD_PARTY_LICENSES.md); the Docker
image also carries a copy in `/usr/share/doc/saybeam/`.

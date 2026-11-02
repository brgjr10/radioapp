# radioapp

[![Docker Pulls](https://img.shields.io/docker/pulls/brgjr10/radioapp?logo=docker&style=flat)](https://hub.docker.com/repository/docker/brgjr10/radioapp)
[![Docker Image](https://img.shields.io/docker/v/brgjr10/radioapp/latest?logo=docker&style=flat)](https://hub.docker.com/repository/docker/brgjr10/radioapp/general)
[![GitHub release](https://img.shields.io/github/v/release/brgjr10/radioapp?logo=github&style=flat)](https://github.com/brgjr10/radioapp/releases)
[![GitHub Packages](https://img.shields.io/badge/ghcr.io-radioapp-blue?logo=github&style=flat)](https://github.com/brgjr10/radioapp/packages)

OpenMHz radio scanner activity monitor and audio streaming app. Built for trunked radio systems with talkgroup filtering, history browsing, map plotting, and Web Audio EQ.

<img width="1024" height="572" alt="image" src="https://github.com/user-attachments/assets/4c6ddfc4-2bbc-42e8-9d48-80ae916e727a" />

## Stack

- Node.js server + browser client
- Socket.IO live feed
- Leaflet map (desktop)

## Running

```bash
npm start
```

Opens on `http://localhost:5050`. There are no runtime dependencies — the app is
a static PWA plus a small Node file server.

`npm start` runs `node --env-file-if-exists=.env serve.js`, so a `.env` in the
repo root is picked up automatically. `--env-file-if-exists` (Node ≥ 20.12)
means a missing `.env` is a warning rather than a fatal error, so the server
starts with or without one. A real environment variable always wins over the
file, so `PORT=5099 npm start` still overrides `PORT=5050`. Copy
`.env.example` to `.env` to get started; it is gitignored and excluded from the
Docker image.

```bash
npm test
```

Runs the `node:test` suites in `test/`.

## Docker

```bash
docker compose up -d
```

The container publishes plain HTTP on 5050. Put TLS on a reverse proxy rather
than in the app. `serve.js` has no HTTPS branch: it used to hand a PKCS#12
bundle to `https.createServer` at module load, which threw `mac verify failure`
and killed the process before it could listen, and `server.key` / `server.crt`
are gitignored and dockerignored so neither is in the image anyway.
`docker-compose.yml` passes a local `.env` through with `env_file:`, and the
image entrypoint loads it the same way `npm start` does.

## Config

Environment variables read by `serve.js`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5050` | Listen port |
| `HOST` | `0.0.0.0` | Bind address. Set to `127.0.0.1` to keep the app off the LAN |
| `ALLOW_PRIVATE_PROXY` | `0` | Set to `1` to let `/proxy` reach private/loopback addresses. Leave at `0` unless you have a specific reason |
| `PROXY_ALLOW_HOSTS` | *(empty)* | Comma-separated host allow-list for `/proxy`. Empty means any public host. Set it to lock the proxy to the recording hosts you expect |
| `PROXY_MAX_CONCURRENT` | `8` | In-flight `/proxy` requests before `503` |

The browser talks to OpenHz directly — there is no `/api-proxy` and no
`/socket.io` proxy in `serve.js`. `api.openmhz.com` sits behind Cloudflare,
which answers every non-browser request with a 403 JS-challenge page, so a
same-origin proxy cannot relay the REST API or the live feed. The CORS problem
a proxy was added to solve does not exist either: `api.openmhz.com` answers
cross-origin browser requests fine. Browsers pass Cloudflare's challenge; Node
`http`/`https` clients do not. The `/proxy` endpoint that remains is audio-only,
and it is reached through `app.js`'s `proxyUrl()`, not through the API.

`OM_API`, `OM_SYSTEM` and `OM_ALLOW_DIRECT` are **not** read by the server —
they are historical. The browser reads the API base and system from
`app.js:22-23` and talks to OpenHz directly. They have been removed from
`docker-compose.yml`; the two CasaOS manifests still carry them because CasaOS
regenerates those files from its own UI, and they are harmless because nothing
reads them.

The service is intentionally unauthenticated and is designed for a trusted LAN.
It binds all interfaces by default, so do not publish 5050 off the local
network. Only the PWA's own assets are served; the repository's other files
(`server.key`, `.git/`, `*.db`, `project.json`, the analysis fixtures) are not
reachable over HTTP.

## Repo layout

- `radioapp.yaml` — CasaOS app metadata
- `docker-compose.yml` — container deployment
- `build-ohio-cities.js` — regenerates `ohio-cities.js` from a US cities CSV
- `dedupe-cities.js`, `list-unmapped.js`, `analyze-tgs.js` — analysis-only,
  driven by the `talkgroups.txt` fixture; nothing in the running app reads them
- Talkgroup categories and Ohio place matching live in `app.js`


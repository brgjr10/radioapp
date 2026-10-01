# radioapp

[![Docker Pulls](https://img.shields.io/docker/pulls/brgjr10/radioapp?logo=docker&style=flat)](https://hub.docker.com/repository/docker/brgjr10/radioapp)
[![Docker Image](https://img.shields.io/docker/v/brgjr10/radioapp/latest?logo=docker&style=flat)](https://hub.docker.com/repository/docker/brgjr10/radioapp/general)
[![GitHub release](https://img.shields.io/github/v/release/brgjr10/radioapp?logo=github&style=flat)](https://github.com/brgjr10/radioapp/releases)
[![GitHub Packages](https://img.shields.io/badge/ghcr.io-radioapp-blue?logo=github&style=flat)](https://github.com/brgjr10/radioapp/packages)

OpenMHz radio scanner activity monitor and audio streaming app. Built for trunked radio systems with talkgroup filtering, history browsing, map plotting, and Web Audio EQ.

<img width="1577" height="725" alt="image" src="https://github.com/user-attachments/assets/be48d112-3ccd-4e85-8195-92a4517f994d" />
<img width="300" height="572" alt="image" src="https://github.com/user-attachments/assets/3243b6e8-9172-46c9-a086-4ecf3c08b037" />

## Stack

- Node.js server + browser client
- Socket.IO live feed
- Leaflet map (desktop)

## Running

```bash
node serve.js
```

Opens on `http://localhost:5050`. There are no runtime dependencies — the app is
a static PWA plus a small Node file server.

```bash
npm test
```

Runs the `node:test` suites in `test/`.

## Docker

```bash
docker compose up -d
```

The container publishes plain HTTP on 5050. Put TLS on a reverse proxy rather
than in the app: the HTTPS branch needs a PKCS#12 bundle plus its passphrase, and
`server.key` / `server.crt` are gitignored and dockerignored, so neither is in
the image.

## Config

Environment variables read by `serve.js`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5050` | Listen port |
| `HOST` | `0.0.0.0` | Bind address. Set to `127.0.0.1` to keep the app off the LAN |
| `ALLOW_PRIVATE_PROXY` | `0` | Set to `1` to let `/proxy` reach private/loopback addresses. Leave at `0` unless you have a specific reason |
| `PROXY_ALLOW_HOSTS` | *(empty)* | Comma-separated host allow-list for `/proxy`. Empty means any public host. Set it to lock the proxy to the recording hosts you expect |
| `PROXY_MAX_CONCURRENT` | `8` | In-flight `/proxy` requests before `503` |

`OM_API`, `OM_SYSTEM` and `OM_ALLOW_DIRECT` are **not** read by the server —
they are historical. The browser reads the API base and system from
`app.js:22-23` and talks to OpenMHz directly. They have been removed from
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


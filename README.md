# radioapp

OpenMHz radio scanner activity monitor and audio streaming app. Built for trunked radio systems with talkgroup filtering, history browsing, map plotting, and Web Audio EQ.

## Stack

- Node.js server + browser client
- Socket.IO live feed
- Leaflet map (desktop)

## Running

```bash
npm install
node serve.js
```

Opens on `http://localhost:5050`.

## Docker

```bash
docker compose up -d
```

Set `HTTPS_PFX_PASSWORD` in the environment if using HTTPS with a PFX bundle.

## Config

- `radioapp.yaml` — CasaOS app metadata
- `docker-compose.yml` — container deployment
- Talkgroup categories and Ohio place matching live in `app.js`

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

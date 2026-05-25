# air-quality-panel

Personal air quality panel for [personal-ontology](https://github.com/personal-ontology) — pulls readings from a Qingping Air Monitor Pro via Qingping's cloud API (and, later, BLE directly when the device is in Bluetooth range of the operator's Mac). Single-user, self-hosted.

## Status

Early. Cloud poller scaffolded; needs your Qingping developer credentials before it can fetch real data. BLE scanner is a planned follow-up.

## Setup

Pre-requisites:
- A Qingping device (e.g. Air Monitor Pro), already set up via the Qingping+ app and reporting to Qingping's cloud.
- A developer app registered at https://qingping.co/developer — they issue an `app_id` and `app_key`.

```bash
cp .env.example .env
# Fill in:
#   QINGPING_APP_ID, QINGPING_APP_KEY
#   QINGPING_DEVICE_MAC (optional — restrict to one device)
#   PANEL_BEARER_TOKEN  — `openssl rand -hex 32`
#   TIMEZONE            — your IANA tz (defaults to America/Los_Angeles)

bun install
bun run start      # one-shot CLI: poll Qingping, print latest reading
bun run serve      # long-running HTTP server, polls per CRON_SCHEDULE
```

## HTTP API

All endpoints are bearer-authed when `PANEL_BEARER_TOKEN` is set; the HTML view at `/` and `/favicon.ico` are exempt (the page asks for the token and stores it in localStorage).

| Endpoint | Returns |
|---|---|
| `GET /` | HTML view (Tokyo Night palette) |
| `GET /health` | status, devices_count, last_seen_at, schedule (cron / tz / next_run) |
| `GET /data` | per-device latest reading |
| `GET /devices` | device list |
| `GET /devices/:id/readings?from=&to=&limit=` | query historical readings |
| `POST /refresh` | trigger an immediate cloud poll |
| `POST /timezone {"tz":"Europe/Berlin"}` | reschedule cron in the new IANA tz |
| `POST /ingest/ble` | (future) receive readings from the Mac-side BLE scanner |

All responses use the standard envelope: `{ data, refreshed_at, source: "air-quality" }`.

## Roadmap

- [x] Cloud poller against Qingping's API
- [x] Schema designed to dedup readings across sources (`source` = `cloud` or `ble`)
- [x] `/ingest/ble` endpoint reserved for the local-network path
- [ ] **Mac BLE scanner** — Python script using `bleak`, runs as a launchd agent, decodes the device's BLE advertisements, posts to `/ingest/ble`. No internet needed when the Mac is in Bluetooth range of the device.
- [ ] History chart in the HTML view
- [ ] Anomaly detection via the intelligence service (when it exists)

## Stack

TypeScript + Bun + Hono + bun:sqlite + Caddy auto-TLS (host-side). Same chassis as the rest of the personal-ontology panels.

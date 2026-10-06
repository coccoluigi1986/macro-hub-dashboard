# Macro Hub Dashboard — Dev Setup

## Architecture
- **Frontend**: single static `index.html` (no build step, no framework — vanilla JS/CSS inline).
- **Backend**: 12 Vercel-style serverless functions in `/api` (CommonJS, no npm dependencies — pure native `fetch`).
- **Shared libs** in `/lib` (yahoo finance, news RSS, claude API, vercel adapter).
- **Dev server**: `server.js` — minimal Node HTTP server (built-ins only) that serves `index.html` statically and routes `/api/*` to the corresponding function file.

## Running
```
docker compose -f docker-compose.base44.yml up -d --build
```
App is on port 3000. No build step, no npm install needed — `node server.js` is the entire startup.

## Environment Variables (all optional for boot)
| Key | Required? | Purpose |
|-----|-----------|---------|
| `FRED_API_KEY` | Needed for macro data | FRED economic indicators (/api/fred-data). Free: https://fred.stlouisfed.org/docs/api/api_key.html |
| `ANTHROPIC_API_KEY` | Optional | AI-generated bias/sentiment/dossier text. Falls back to static text if missing. |
| `FMP_API_KEY` | Optional | Treasury yields in DXY correlation. Falls back gracefully. |
| `FINNHUB_KEY` | Optional | Extra news source alongside RSS feeds. |

Without any keys, the dashboard loads and most sections work (market data via Yahoo, FX via Frankfurter/BCE, news via RSS, COT data). Only FRED macro indicators will show an error without `FRED_API_KEY`.

## Quirks
- Functions use `lib/vercel-adapter.js` to wrap Lambda-style handlers into Express-like `(req, res)` handlers. `server.js` shims `req.query`, `res.status()`, `res.send()` onto native Node http objects.
- Yahoo Finance endpoint requires a browser User-Agent header (handled in `lib/yahoo.js`).
- No `package-lock.json` — there are zero npm dependencies.

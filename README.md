# RTTS MMO Demo

One-shard browser MMO demo for the RTTS tactical rules. The server is authoritative for AP turns, 30-second clocks, and visibility-filtered snapshots.

## Stack

- `packages/client`: Vite + React tactical UI
- `packages/server`: Express + `ws`, Google OAuth, Render-ready static hosting
- `packages/shared`: shared types and core rules
- `scripts/import-rtts-nmo.ts`: imports curated data from `RTTS NMO.xlsx`
- Render/Postgres persistence for users, sessions, characters, shard state, master definitions, and action logs

## Local Run

```powershell
npm install
npm run import:data
npm run build
$env:ALLOW_DEV_AUTH='true'; npm start
```

Open `http://localhost:3000`. Google OAuth is used when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are configured. `ALLOW_DEV_AUTH=true` enables a local-only dev sign-in button. For multiplayer local testing, use separate sessions with `/auth/dev?email=player1@rtts.local&name=Player1` and `/auth/dev?email=player2@rtts.local&name=Player2`.

You can also run a two-client WebSocket smoke test against a running local server:

```powershell
npm run smoke:multiplayer
```

Before deploying to Render, run the static readiness check:

```powershell
npm run check:render
```

For repeated local demos, reset the in-memory shard while `ALLOW_DEV_AUTH=true`:

```powershell
Invoke-WebRequest -Uri http://localhost:3000/api/dev/reset-shard -Method Post -UseBasicParsing
```

## Render

The repo includes `render.yaml`. It uses Render free instance types for the first demo deploy. Free web services can spin down when idle, and Free Render Postgres expires after 30 days. Required environment variables:

- `APP_ORIGIN`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DATABASE_URL`

The service binds to `0.0.0.0:$PORT`, serves the built client, and accepts WebSocket clients at `/ws`.
Render health checks use `GET /api/health`. In production, startup fails fast when `APP_ORIGIN`, `SESSION_SECRET`, Google OAuth credentials, or `DATABASE_URL` are missing.

See `docs/render-deploy.md` for the Dashboard Blueprint deployment steps and Google OAuth callback setup.

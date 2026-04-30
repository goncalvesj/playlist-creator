# DJ Set -> Spotify Playlist

Browser app that turns a YouTube DJ set into a Spotify playlist.

1. Sign in with Spotify.
2. Paste a YouTube URL.
3. Review the matched tracks.
4. Create the playlist in your account.

Track extraction from the YouTube description runs in an Azure Function backed by Azure AI Foundry. Spotify search and playlist creation run in the browser using the signed-in user's token, so YouTube and Foundry secrets stay server-side.

This is an MVP for personal use and a small set of approved Spotify users — not a public multi-tenant product.

## Architecture

```text
Azure Static Web App
|-- /                         Vite + React SPA (Spotify PKCE, search, playlist creation)
`-- /api/extract-tracklist    Azure Function (Node 20)
    |-- YouTube Data API v3   Reads the video description
    `-- Azure AI Foundry      Structured-output tracklist extraction
```

## Tech stack

- **Frontend** — Vite, React, TypeScript, React Router, `@tanstack/react-query`, Tailwind v4, `@spotify/web-api-ts-sdk`, `fast-fuzzy`, `p-limit`.
- **Backend** — Azure Functions v4 on Node 20, `openai` SDK against Azure AI Foundry's v1 Responses API, `zod` for validation.
- **Hosting** — Azure Static Web Apps. `staticwebapp.config.json` pins `apiRuntime` to `node:20`.

## Prerequisites

- Node.js and npm.
- A Spotify Developer app with redirect URIs `http://127.0.0.1:5173/callback` and `https://<your-swa>.azurestaticapps.net/callback`. Required scopes: `playlist-modify-private`, `playlist-modify-public`, `user-read-private`.
- A Google Cloud project with YouTube Data API v3 enabled.
- An Azure AI Foundry model deployment that supports the v1 Responses API.
- Azure Static Web Apps CLI (for local emulation and deployment): `npm install -g @azure/static-web-apps-cli`.

## Configuration

Frontend (`.env`, copied from `.env.example`):

```text
VITE_SPOTIFY_CLIENT_ID=<spotify-client-id>
VITE_SPOTIFY_REDIRECT_URI=http://127.0.0.1:5173/callback
VITE_APPLICATIONINSIGHTS_CONNECTION_STRING=<app-insights-connection-string>
VITE_APPINSIGHTS_CLOUD_ROLE_NAME=playlist-creator-web
VITE_APP_ENVIRONMENT=development
VITE_APP_VERSION=local
VITE_BUILD_SHA=local
```

Backend (`api\local.settings.json` locally, Static Web Apps application settings in production):

```text
YOUTUBE_API_KEY=<youtube-data-api-key>
AZURE_OPENAI_ENDPOINT=<foundry-openai-v1-base-url>
AZURE_OPENAI_API_KEY=<foundry-api-key>
AZURE_OPENAI_DEPLOYMENT=<model-deployment-name>
APPLICATIONINSIGHTS_CONNECTION_STRING=<app-insights-connection-string>
APPLICATIONINSIGHTS_CLOUD_ROLE_NAME=playlist-creator-api
APPLICATION_ENVIRONMENT=development
APP_VERSION=local
```

`AZURE_OPENAI_ENDPOINT` should be the Foundry OpenAI v1 base URL, for example `https://<your-foundry-host>/openai/v1`. The SDK appends `/responses` for requests.

The function also supports optional knobs for rate limiting, caching, and model output limits — see `api\src\rateLimit.ts`, `api\src\tracklistCache.ts`, and `api\src\env.ts` for the full list.

Application Insights telemetry is optional locally and activates only when the connection string is configured. The app emits privacy-safe diagnostics for SPA routes, browser vitals, frontend exceptions, `/api/extract-tracklist` correlation, YouTube and Azure AI dependencies, Spotify matching and playlist creation, cache hits, rate limits, and sanitized failure categories. Telemetry uses dimensions such as `cloudRoleName`, `environment`, `appVersion`, `buildSha`, `operation`, `resultCategory`, `correlationId`, and hashed `videoIdHash`; it intentionally avoids logging playlist names, YouTube URLs, Spotify tokens, user emails, and raw provider responses.

## Local development

```powershell
npm ci
npm --prefix api ci
npm run dev:swa
```

Open <http://127.0.0.1:5173>. The SWA emulator proxies `/api/*` to the local Functions host. Use `npm run dev` for frontend-only work or `npm --prefix api run start` for direct API work.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server. |
| `npm run dev:swa` | Build the API and run the app through the SWA emulator. |
| `npm run build` | Type-check and build the SPA. |
| `npm run lint` | Run ESLint. |
| `npm --prefix api run build` | Compile the Azure Functions project. |

## Deployment

```powershell
$env:SWA_CLI_DEPLOYMENT_TOKEN = "<your-static-web-app-deployment-token>"
.\deploy-static-web-app.ps1
```

The script installs root dependencies, builds the SPA, then runs the Azure Static Web Apps CLI to deploy `dist` plus the `api` folder. Useful flags: `-Environment <name>`, `-SkipInstall`, `-SkipBuild`, `-NoApi`.

## API

The `/api/extract-tracklist` Azure Function is the only backend endpoint. For each request it:

1. Applies an in-memory per-client rate limit and short-lived per-video cache.
2. Validates the body with `zod` and resolves the YouTube video ID.
3. Fetches the video snippet from YouTube Data API v3 and checks the description looks like a tracklist (timestamps or ` - ` separators on at least three lines).
4. Calls Azure AI Foundry's v1 Responses API with a strict JSON schema and `temperature: 0`, returning only tracks present in the description.

The rate limit and cache are per running Function instance; rely on provider quotas for stronger limits.

### Endpoint

`POST /api/extract-tracklist` with `{ "youtubeUrl": "..." }` returns:

```json
{
  "videoId": "abc123",
  "videoTitle": "Boiler Room: Artist Name | Live Set",
  "channelTitle": "Boiler Room",
  "source": "description",
  "confidence": "high",
  "tracks": [
    { "artist": "Daft Punk", "title": "Around the World (Alex Gopher Remix)", "timestamp": "00:12:34" }
  ]
}
```

Supported URL forms: `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`, `youtube.com/live/…`.

Status codes:

| Status | Meaning |
| --- | --- |
| `200` | Tracklist extracted successfully. |
| `400` | Invalid body, unsupported URL, or unidentifiable client (in production). |
| `404` | Video not found, description has no tracklist, or the model returned none. |
| `429` | Rate limit exceeded; response includes `Retry-After` and `retryAfterSeconds`. |
| `502` | YouTube, Azure AI Foundry, or required configuration failed. |

### Source layout

```text
api\src\
|-- functions\extract-tracklist.ts    HTTP trigger and request orchestration
|-- ai.ts                             Foundry config, prompt, schema, extraction
|-- youtube.ts                        Video ID parsing, metadata fetch, source selection
|-- rateLimit.ts                      In-memory per-client rate limiter
|-- tracklistCache.ts                 In-memory per-video result cache
|-- env.ts                            Shared helpers
```

## Limitations

- Only extracts tracklists that appear as text in the YouTube description (no captions, comments, OCR, or audio fingerprinting).
- No persistence or history of past conversions.
- Spotify Development Mode only — each user must be added under the Spotify app's allowed users.

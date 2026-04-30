# DJ Set -> Spotify Playlist

Browser app for turning a YouTube DJ set tracklist into a Spotify playlist. The app extracts tracks from the YouTube video description with an Azure AI Foundry-backed Azure Function, searches Spotify from the signed-in user's browser session, lets the user review the matches, and creates a playlist in Spotify.

## Current implementation

- React, TypeScript, Vite, React Router, React Query, and Tailwind CSS for the SPA.
- Spotify Authorization Code with PKCE runs in the browser through `@spotify/web-api-ts-sdk`.
- `/api/extract-tracklist` is an Azure Functions v4 HTTP trigger running on Node.js 20.
- The backend fetches YouTube video metadata, checks the description for a tracklist, and asks Azure AI Foundry for structured JSON.
- Spotify matching runs in the SPA with `fast-fuzzy` scoring and `p-limit` concurrency control.
- Deployment is currently through `deploy-static-web-app.ps1` and the Azure Static Web Apps CLI.

## Architecture

```text
Azure Static Web App
|-- /                         Vite-built React SPA
|   |-- Spotify PKCE auth     Browser-only Spotify token handling
|   `-- Spotify Web API       Search, profile, playlist creation, add tracks
|
`-- /api/extract-tracklist    Azure Function, Node.js 20
    |-- YouTube Data API v3   Server-side API key
    `-- Azure AI Foundry      Server-side API key and model deployment
```

Secrets stay server-side in local function settings or Static Web Apps application settings. The only Spotify value shipped to the browser is the public Spotify client ID.

## Repository layout

```text
.
|-- api\
|   |-- src\functions\extract-tracklist.ts
|   |-- host.json
|   |-- local.settings.example.json
|   |-- package.json
|   `-- tsconfig.json
|-- public\
|-- src\
|   |-- api\extractTracklist.ts
|   |-- auth\spotifyAuth.ts
|   |-- auth\useSpotify.ts
|   |-- components\TrackRow.tsx
|   |-- matching\scoreMatch.ts
|   |-- matching\searchSpotify.ts
|   |-- pages\Home.tsx
|   |-- pages\Review.tsx
|   |-- pages\Done.tsx
|   |-- App.tsx
|   |-- index.css
|   `-- main.tsx
|-- deploy-static-web-app.ps1
|-- staticwebapp.config.json
|-- vite.config.ts
|-- package.json
`-- spec.md
```

## Prerequisites

- Node.js and npm.
- Azure Static Web Apps CLI for local SWA emulation:

  ```powershell
  npm install -g @azure/static-web-apps-cli
  ```

- A Spotify Developer app.
- A Google Cloud project with YouTube Data API v3 enabled.
- An Azure AI Foundry model deployment that supports the v1 Responses API.
- An existing Azure Static Web App and deployment token if you want to deploy with the included script.

## Spotify setup

Create a Spotify app at <https://developer.spotify.com/dashboard> and configure these redirect URIs:

```text
http://127.0.0.1:5173/callback
https://<your-static-web-app>.azurestaticapps.net/callback
```

Required scopes:

- `playlist-modify-private`
- `playlist-modify-public`
- `user-read-private`

If the app stays in Spotify Development Mode, add each allowed Spotify account under the app's users and access settings.

## Environment variables

### Frontend

Create `.env` from `.env.example`:

```powershell
Copy-Item .env.example .env
```

Set:

```text
VITE_SPOTIFY_CLIENT_ID=<spotify-client-id>
VITE_SPOTIFY_REDIRECT_URI=http://127.0.0.1:5173/callback
```

`VITE_SPOTIFY_REDIRECT_URI` defaults to `<current-origin>/callback`, with a localhost redirect normalized to `127.0.0.1`, but setting it explicitly keeps local Spotify configuration predictable.

### Backend

For local development, create `api\local.settings.json` from `api\local.settings.example.json`:

```powershell
Copy-Item api\local.settings.example.json api\local.settings.json
```

Set these values locally and in Azure Static Web Apps application settings:

```text
YOUTUBE_API_KEY=<youtube-data-api-key>
AZURE_OPENAI_TARGET_URI=<foundry-openai-v1-responses-or-base-url>
AZURE_OPENAI_MODEL=<model-or-deployment-name>
AZURE_OPENAI_API_KEY=<foundry-api-key>
```

The backend also accepts `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_ENDPOINT` as aliases for the target URI, and `AZURE_OPENAI_DEPLOYMENT` as an alias for the model name. Set `AZURE_OPENAI_LOG_OUTPUT_PREVIEW=true` only when you intentionally want AI response previews in function logs.

## Local development

Install dependencies for both the SPA and API:

```powershell
npm ci
npm --prefix api ci
```

Run the Vite app and Azure Functions API through the Static Web Apps emulator:

```powershell
npm run dev:swa
```

Open <http://127.0.0.1:5173>. The script starts the Static Web Apps emulator on port `5173`, runs Vite behind it on port `5174`, and proxies `/api/*` to the local Functions host.

For frontend-only work, use:

```powershell
npm run dev
```

## API protection settings

The `/api/extract-tracklist` function includes lightweight in-memory safeguards to reduce accidental key usage and LLM spend:

- `API_RATE_LIMIT_MAX_REQUESTS` and `API_RATE_LIMIT_WINDOW_SECONDS` limit requests per identified client before YouTube or Azure OpenAI are called. Defaults to 5 requests per 60 seconds.
- `API_RATE_LIMIT_MAX_CLIENTS` bounds the number of in-memory rate limit buckets. Defaults to 1000.
- `TRACKLIST_CACHE_TTL_SECONDS` caches successful extractions by YouTube video ID. Defaults to 6 hours.
- `TRACKLIST_CACHE_MAX_ENTRIES` bounds the number of cached successful extractions. Defaults to 100.
- `MAX_SOURCE_TEXT_CHARS` caps the description text sent to the model. Defaults to 12000 characters.
- `AZURE_OPENAI_MAX_OUTPUT_TOKENS` caps model output tokens. Defaults to 4000.

Configure these in `api/local.settings.json` for local development and in Azure Static Web Apps application settings for production. Rate limiting identifies the caller from the `x-forwarded-for`, `x-azure-clientip`, or `x-real-ip` headers (in that order). When running locally via the Azure Functions Core Tools (`AZURE_FUNCTIONS_ENVIRONMENT=Development` and no `WEBSITE_INSTANCE_ID`), unidentified callers share a single `local-development` rate-limit bucket so the dev loop is not blocked. In production, requests without an identifiable client are rejected so one unidentified caller cannot exhaust a shared bucket. The in-memory rate limit and cache are per running function instance, so use provider-level quotas/budgets as an additional backstop for personal API keys.

## App flow

1. The user signs in with Spotify.
2. The user submits a YouTube URL from Home.
3. The SPA posts `{ "youtubeUrl": "..." }` to `/api/extract-tracklist`.
4. The backend reads the YouTube video description, extracts a structured tracklist with Azure AI Foundry, and returns the result.
5. Review searches Spotify for each extracted track with a maximum concurrency of five searches.
6. The user reviews match scores, toggles which matched tracks to include, chooses private/public visibility, and creates the playlist.
7. Done links to the Spotify playlist and lists tracks that were not added.

## API contract

### Request

```http
POST /api/extract-tracklist
Content-Type: application/json

{ "youtubeUrl": "https://www.youtube.com/watch?v=..." }
```

Supported URL forms:

- `youtube.com/watch?v=...`
- `youtu.be/...`
- `youtube.com/shorts/...`
- `youtube.com/live/...`

### Response

```json
{
  "videoId": "abc123",
  "videoTitle": "Boiler Room: Artist Name | Live Set",
  "channelTitle": "Boiler Room",
  "source": "description",
  "confidence": "high",
  "tracks": [
    {
      "artist": "Daft Punk",
      "title": "Around the World (Alex Gopher Remix)",
      "timestamp": "00:12:34"
    }
  ]
}
```

The API returns:

- `400` for invalid JSON, an invalid request body, or an unsupported YouTube URL.
- `404` when the video is not found, the description does not look like a tracklist, or the model returns no tracks.
- `502` when YouTube, Azure AI Foundry, or required backend configuration fails.

The current extractor only uses the YouTube video description. It does not inspect captions, comments, OCR, or audio.

## Spotify matching

For each extracted track, the SPA:

1. Searches Spotify with `track:"<title>" artist:"<artist>"`.
2. If no results are found, strips title parentheticals and retries the field-filtered query.
3. If there are still no results, searches plain text with `<artist> <title>`.
4. Scores each candidate with `fast-fuzzy`, weighting artist similarity at `0.4` and title similarity at `0.6`.
5. Marks scores `>= 0.85` as automatic, scores `>= 0.65` and `< 0.85` as review, and everything else as not found.

Review currently supports selecting or deselecting matched tracks. Alternate-pick and edit-query controls are not implemented in the UI yet.

## Deployment

Set the deployment token for the current PowerShell session, then run:

```powershell
$env:SWA_CLI_DEPLOYMENT_TOKEN = "<your-static-web-app-deployment-token>"
.\deploy-static-web-app.ps1
```

The script installs root dependencies when needed, builds the Vite app into `dist`, and deploys `dist` plus the `api` folder to the production Azure Static Web Apps environment. The API deployment targets Node.js 20 to match `staticwebapp.config.json`.

To deploy the frontend without the API:

```powershell
.\deploy-static-web-app.ps1 -NoApi
```

Useful script options:

| Option | Purpose |
| --- | --- |
| `-Environment <name>` | Deploy to a different SWA environment, default `production`. |
| `-SkipInstall` | Skip root dependency installation. |
| `-SkipBuild` | Skip the Vite build step. |
| `-NoApi` | Deploy only the frontend output. |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Vite dev server. |
| `npm run dev:swa` | Build the API and run the app through the SWA emulator. |
| `npm run build` | Type-check and build the SPA. |
| `npm run lint` | Run ESLint. |
| `npm --prefix api run build` | Compile the Azure Functions TypeScript project. |
| `npm --prefix api run start` | Build and start the Functions host directly. |

## Current limitations

- Tracklists must be present as text in the YouTube description.
- No audio fingerprinting, OCR, comment parsing, captions parsing, or persistence/history.
- No public multi-tenant user management; Spotify Development Mode is suitable for personal use and a small set of approved users.
- The review page stores alternate Spotify matches in code but does not expose an alternate picker or query editor.

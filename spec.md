# DJ Set -> Spotify Playlist - Current Implementation Spec

## 1. Scope

This repository contains a browser-based web app that takes a YouTube DJ set URL, extracts a tracklist from the video's description, searches Spotify for matching tracks, and creates a Spotify playlist in the logged-in user's account.

The current implementation is an MVP for personal use and a small set of approved Spotify users. It is not a public multi-tenant product.

### In scope

- Spotify Authorization Code with PKCE in the browser.
- YouTube video-description extraction through a same-origin Azure Function.
- Azure AI Foundry v1 Responses API structured-output extraction.
- Spotify search, fuzzy matching, review, playlist creation, and batched track insertion.
- Azure Static Web Apps local emulation and manual deployment with a PowerShell script.

### Out of scope

- Audio fingerprinting.
- OCR of video frames.
- Captions, comments, or web scraping outside the YouTube Data API snippet description.
- Persistence or history of past conversions.
- Public multi-user mode or Spotify Extended Quota workflow.
- Background jobs or queued processing.

## 2. Architecture

```text
Azure Static Web App
|-- /                         Vite-built SPA (React + TypeScript)
|   |-- Spotify PKCE          Browser-only token handling
|   `-- Spotify Web API       Search, profile, playlist creation, add tracks
|
`-- /api/extract-tracklist    Azure Function v4, Node.js 20
    |-- YouTube Data API v3   Server-side key
    `-- Azure AI Foundry      Server-side key and model deployment
```

The SPA calls the backend through same-origin `/api/*`, so no CORS configuration is required. YouTube and Azure AI Foundry secrets are only read by the API. The Spotify token and playlist calls stay in the browser.

Deployment in the repository is currently manual through `deploy-static-web-app.ps1`. There is no tracked GitHub Actions workflow in the current repository state.

## 3. Tech stack

### Frontend

- Vite, React, TypeScript.
- React Router for pages.
- `@tanstack/react-query` for the extraction mutation.
- Tailwind CSS v4 through `@tailwindcss/vite`.
- `@spotify/web-api-ts-sdk` for Spotify PKCE auth and Web API calls.
- `fast-fuzzy` for match scoring.
- `p-limit` for Spotify search concurrency.

The UI is custom React markup styled with Tailwind classes. `shadcn/ui` is not currently installed or used.

### Backend

- Azure Functions v4 for Node.js 20.
- TypeScript compiled with `tsc`.
- `openai` package for Azure AI Foundry v1 Responses API calls.
- `zod` for request-body and model-output validation.

### Hosting and deployment

- Azure Static Web Apps.
- `staticwebapp.config.json` sets navigation fallback and `apiRuntime` to `node:20`.
- `deploy-static-web-app.ps1` deploys `dist` and optionally the `api` folder with `npx @azure/static-web-apps-cli@latest deploy`.

## 4. Repository layout

```text
.
|-- api\
|   |-- .funcignore
|   |-- host.json
|   |-- local.settings.example.json
|   |-- package.json
|   |-- tsconfig.json
|   `-- src\
|       |-- ai\
|       |   |-- diagnostics.ts
|       |   |-- extractTracks.ts
|       |   |-- foundryConfig.ts
|       |   |-- prompt.ts
|       |   `-- responseSchemas.ts
|       |-- functions\extract-tracklist.ts
|       |-- youtube\
|       |   |-- metadata.ts
|       |   |-- sourceSelection.ts
|       |   `-- videoId.ts
|       |-- env.ts
|       |-- httpResponse.ts
|       |-- rateLimit.ts
|       `-- tracklistCache.ts
|-- public\
|   |-- favicon.svg
|   `-- icons.svg
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
|-- .azure\deployment-plan.md
|-- .env.example
|-- deploy-static-web-app.ps1
|-- index.html
|-- package.json
|-- README.md
|-- staticwebapp.config.json
|-- tsconfig*.json
`-- vite.config.ts
```

## 5. Configuration

### Frontend `.env`

```text
VITE_SPOTIFY_CLIENT_ID=<spotify-client-id>
VITE_SPOTIFY_REDIRECT_URI=http://127.0.0.1:5173/callback
```

`VITE_SPOTIFY_REDIRECT_URI` defaults to the current origin plus `/callback`, with `localhost` redirected to `127.0.0.1` for local Spotify redirect consistency.

### Backend settings

Local settings are stored in `api\local.settings.json` and production settings are stored in Azure Static Web Apps application settings.

Required:

```text
YOUTUBE_API_KEY=<youtube-data-api-key>
AZURE_OPENAI_TARGET_URI=<foundry-openai-v1-responses-or-base-url>
AZURE_OPENAI_MODEL=<model-or-deployment-name>
AZURE_OPENAI_API_KEY=<foundry-api-key>
```

Accepted aliases:

- `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_ENDPOINT` for `AZURE_OPENAI_TARGET_URI`.
- `AZURE_OPENAI_DEPLOYMENT` for `AZURE_OPENAI_MODEL`.

Optional diagnostics:

- `AZURE_OPENAI_LOG_OUTPUT_PREVIEW=true` logs truncated model output previews. Leave it unset unless actively debugging.

## 6. Backend API: `/api/extract-tracklist`

### Request

```http
POST /api/extract-tracklist
Content-Type: application/json

{ "youtubeUrl": "https://www.youtube.com/watch?v=..." }
```

The request body is validated with Zod as `{ youtubeUrl: z.string().url() }`.

### Supported YouTube URL forms

- `youtube.com/watch?v=<id>`
- `youtu.be/<id>`
- `youtube.com/shorts/<id>`
- `youtube.com/live/<id>`

Any other form returns `400`.

### Metadata fetch

The API calls:

```text
https://www.googleapis.com/youtube/v3/videos?part=snippet&id=<videoId>&key=<YOUTUBE_API_KEY>
```

It uses `snippet.title`, `snippet.channelTitle`, and `snippet.description`.

### Source selection

The current source selector only accepts the YouTube description. A description qualifies when it contains at least three non-empty lines that match either:

- a timestamp-like pattern: `\d{1,2}:\d{2}`
- a spaced dash separator: ` - ` or ` – `

If the description does not qualify, the API returns `404` with `No tracklist found in video description.`

### Azure AI Foundry request

The API normalizes the configured Foundry URI into an OpenAI-compatible base URL. It accepts either a base URL or a full `/responses` target URI.

The Responses API call uses:

- `model`: `AZURE_OPENAI_MODEL` or `AZURE_OPENAI_DEPLOYMENT`.
- `instructions`: the system prompt below.
- `input`: `SOURCE: description` followed by the selected description text.
- `text.format`: strict JSON schema named `tracklist`.
- `temperature`: `0`.
- `max_output_tokens`: `4096`.

System prompt:

```text
You extract DJ set tracklists from a YouTube video description.
Return ONLY tracks present in the input — never invent tracks.
Normalize each track into { artist, title, timestamp }.
- artist: the primary artist; if multiple, join with " & ".
- title: include remix/edit info in parentheses if present (e.g. "Song (Extended Mix)").
- timestamp: HH:MM:SS or MM:SS if present in the source line, else null.
Strip leading numbering (e.g. "1.", "01)", "Track 3:").
If the input does not contain a tracklist, return tracks: [] and confidence: "low".
Set confidence to "high" if the list is clearly delimited and consistently formatted,
"medium" if mostly clear but some lines are ambiguous, "low" otherwise.
```

Expected model schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tracks", "confidence"],
  "properties": {
    "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
    "tracks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["artist", "title", "timestamp"],
        "properties": {
          "artist": { "type": "string" },
          "title": { "type": "string" },
          "timestamp": { "type": ["string", "null"] }
        }
      }
    }
  }
}
```

### Successful response

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

### Error responses

- `400` invalid JSON body, invalid request shape, or unsupported YouTube URL.
- `404` video not found, no tracklist-like description, invalid or empty model tracklist.
- `502` missing server-side configuration, YouTube API failure, incomplete or invalid AI response, or other upstream failure.

The function logs detailed Azure AI response diagnostics for incomplete or invalid model output while avoiding full input/output logging by default.

## 7. Frontend behavior

### Auth

`src\auth\useSpotify.ts` creates the SDK with:

```ts
SpotifyApi.withUserAuthorization(SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, SPOTIFY_SCOPES)
```

Scopes:

- `playlist-modify-private`
- `playlist-modify-public`
- `user-read-private`

On `/callback`, the app exchanges the authorization code, marks the session authenticated, and replaces browser history with `/`. If a cached token exists, the user is treated as authenticated without forcing a redirect. Logout calls `sdk.logOut()`.

### Home

Home shows:

- Sign in with Spotify when unauthenticated.
- YouTube URL input when authenticated.
- Extraction loading and error states.

On extraction success, Home navigates to `/review` with the tracklist response and original YouTube URL in router state.

### Review

Review:

- Runs `matchAllTracks` once for the extracted tracks.
- Shows extraction source and confidence.
- Shows editable playlist name, defaulting to `videoTitle`.
- Provides a public/private checkbox, defaulting to private.
- Displays counts for auto, review, not found, and selected tracks.
- Renders a table with extracted track details, best Spotify match, score, status icon, and a use checkbox.
- Creates the playlist with `sdk.currentUser.profile()`, `sdk.playlists.createPlaylist()`, and `sdk.playlists.addItemsToPlaylist()` in batches of 100 URIs.
- Navigates to Done with the playlist URL, name, added count, and tracks that were not added.

Current review controls support selecting or deselecting the best match. The code stores alternate matches, but the UI does not currently expose alternate selection, query editing, or row removal.

### Done

Done:

- Links to the created Spotify playlist.
- Displays the number of added tracks.
- Lists unmatched or deselected tracks so the user can add them manually.
- Provides a Convert another action back to Home.

## 8. Spotify matching

`src\matching\searchSpotify.ts` processes tracks with `p-limit(5)`.

For each extracted `{ artist, title, timestamp }`:

1. Search Spotify with `track:"<title>" artist:"<artist>"`, limit 5.
2. If no results are found, strip title parentheticals and retry the field-filtered query.
3. If still empty, search plain text with `<artist> <title>`, limit 5.
4. Score each candidate by comparing extracted artist/title to candidate artist/title:
   - artist score weight: `0.4`
   - title score weight: `0.6`
5. Sort by descending score and select the highest-scored track.

Status thresholds:

| Score | Status | Selected by default |
| --- | --- | --- |
| `>= 0.85` | `auto` | Yes |
| `>= 0.65` and `< 0.85` | `review` | Yes |
| `< 0.65` or no candidate | `not_found` | No |

If a single Spotify search task throws, that track is marked `not_found` and matching continues for the remaining tracks.

## 9. Deployment

`deploy-static-web-app.ps1` is the current deployment path.

Required environment variable:

```powershell
$env:SWA_CLI_DEPLOYMENT_TOKEN = "<your-static-web-app-deployment-token>"
```

Default command:

```powershell
.\deploy-static-web-app.ps1
```

The script:

1. Requires PowerShell 5.1 or later.
2. Fails if `SWA_CLI_DEPLOYMENT_TOKEN` is not set.
3. Verifies `npm` is available.
4. Runs `npm ci` or `npm install` unless `-SkipInstall` is used.
5. Runs `npm run build` unless `-SkipBuild` is used.
6. Verifies the build output folder and `staticwebapp.config.json` exist.
7. Runs `npx -y @azure/static-web-apps-cli@latest deploy dist --env production --swa-config-location . --api-location api --api-language node --api-version 20`.

Use `-NoApi` to deploy only the frontend.

## 10. Validation commands

Existing commands:

```powershell
npm run build
npm run lint
npm --prefix api run build
```

Local SWA emulation:

```powershell
npm run dev:swa
```

Direct API development:

```powershell
npm --prefix api run start
```

## 11. Current acceptance criteria

- A user can sign in with Spotify via browser PKCE.
- A supported YouTube URL with a text tracklist in the description produces a structured tracklist.
- The Review page searches Spotify, scores matches, and clearly marks auto, review, and not-found statuses.
- The user can choose private or public visibility and deselect tracks before creation.
- Playlist creation uses the signed-in Spotify user's account and adds tracks in batches of 100.
- Tracks that are not added are listed on Done.
- YouTube and Azure AI Foundry secrets remain server-side.
- Manual deployment through `deploy-static-web-app.ps1` deploys the built SPA and API folder to Azure Static Web Apps.

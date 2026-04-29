# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Local Static Web Apps emulation

Run the Vite app and Azure Functions API through the Static Web Apps CLI:

```powershell
npm run dev:swa
```

Open `http://127.0.0.1:5173`. The script starts the Static Web Apps emulator on the Spotify redirect origin, runs Vite behind it on port `5174`, and proxies the local API through the Functions port.

## API protection settings

The `/api/extract-tracklist` function includes lightweight in-memory safeguards to reduce accidental key usage and LLM spend:

- `API_RATE_LIMIT_MAX_REQUESTS` and `API_RATE_LIMIT_WINDOW_SECONDS` limit requests per client before YouTube or Azure OpenAI are called. Defaults to 5 requests per 60 seconds.
- `TRACKLIST_CACHE_TTL_SECONDS` caches successful extractions by YouTube video ID. Defaults to 6 hours.
- `MAX_SOURCE_TEXT_CHARS` caps the description/comment text sent to the model. Defaults to 12000 characters.
- `AZURE_OPENAI_MAX_OUTPUT_TOKENS` caps model output tokens. Defaults to 4000.

Configure these in `api/local.settings.json` for local development and in Azure Static Web Apps application settings for production. The in-memory rate limit and cache are per running function instance, so use provider-level quotas/budgets as an additional backstop for personal API keys.

## Manual Azure Static Web Apps deployment

Set the deployment token for the current PowerShell session, then run the deployment script:

```powershell
$env:SWA_CLI_DEPLOYMENT_TOKEN = "<your-static-web-app-deployment-token>"
.\deploy-static-web-app.ps1
```

The script installs dependencies with `npm ci`, builds the Vite app into `dist`, and deploys `dist` plus the `api` folder to the production Azure Static Web Apps environment using the Azure Static Web Apps CLI. The API deploy defaults to Node.js 20 to match `staticwebapp.config.json`.

To deploy the frontend without the API, run:

```powershell
.\deploy-static-web-app.ps1 -NoApi
```

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

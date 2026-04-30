import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { redirectToSpotifyRedirectOrigin } from './auth/spotifyAuth'
import { initializeTelemetry } from './telemetry/appInsights'

initializeTelemetry()

if (!redirectToSpotifyRedirectOrigin()) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

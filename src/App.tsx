import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSpotify } from './auth/useSpotify';
import Home from './pages/Home';
import Review from './pages/Review';
import Done from './pages/Done';
import RouteTelemetry from './telemetry/RouteTelemetry';

const queryClient = new QueryClient();

function AppRoutes() {
  const { sdk, isAuthenticated, isLoading, login, logout } = useSpotify();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-green-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/"
        element={<Home isAuthenticated={isAuthenticated} onLogin={login} onLogout={logout} />}
      />
      <Route
        path="/callback"
        element={<Home isAuthenticated={isAuthenticated} onLogin={login} onLogout={logout} />}
      />
      <Route
        path="/review"
        element={sdk ? <Review sdk={sdk} /> : <Navigate to="/" />}
      />
      <Route path="/done" element={<Done />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RouteTelemetry />
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

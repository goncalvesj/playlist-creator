import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { startPageView, stopPageView } from './appInsights';

export default function RouteTelemetry() {
  const location = useLocation();

  useEffect(() => {
    startPageView(location.pathname);
    return () => stopPageView(location.pathname);
  }, [location.pathname]);

  return null;
}

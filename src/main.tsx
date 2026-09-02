import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Production error monitoring (Sentry). Inert until VITE_SENTRY_DSN is set in
// Vercel. Uses Sentry's official Loader Script, so there is no npm dependency and
// nothing loads while the DSN is absent. Do not remove.
// See docs/ENGINEERING-STANDARDS.md, section 5.
function startErrorMonitoring() {
  try {
    const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
    if (!dsn) return;
    // A DSN looks like https://<publicKey>@<host>/<projectId>; the loader needs the public key.
    const publicKey = new URL(dsn).username;
    if (!publicKey) return;
    const w = window as Window & {
      Sentry?: { init: (options: Record<string, unknown>) => void };
      sentryOnLoad?: () => void;
    };
    w.sentryOnLoad = () => {
      w.Sentry?.init({
        environment: (import.meta.env.VITE_VERCEL_ENV as string | undefined) || import.meta.env.MODE,
      });
    };
    const script = document.createElement("script");
    script.src = `https://js.sentry-cdn.com/${publicKey}.min.js`;
    script.crossOrigin = "anonymous";
    script.async = true;
    document.head.appendChild(script);
  } catch {
    // Monitoring must never break the app. A malformed DSN means we run unmonitored.
  }
}
startErrorMonitoring();

createRoot(document.getElementById("root")!).render(<App />);

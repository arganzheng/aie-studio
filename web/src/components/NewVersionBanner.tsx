import { useState } from 'react';
import { useNewVersion } from '../lib/appVersion';

// Model: web.AppVersion — offers a reload once the server runs a newer front
// end than this page. Dismissed, it stays away until the next new version.
export function NewVersionBanner() {
  const latest = useNewVersion();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!latest || dismissed === latest) return null;
  return (
    <div className="app-update-banner" role="status">
      <span>A new version of aie-studio is available.</span>
      <button type="button" className="app-update-reload" onClick={() => window.location.reload()}>Reload</button>
      <button type="button" className="app-update-dismiss" aria-label="Not now" title="Not now" onClick={() => setDismissed(latest)}>×</button>
    </div>
  );
}

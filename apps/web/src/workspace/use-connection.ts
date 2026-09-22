// A dropped connection must freeze editing rather than let a save silently fail (WS-06): this hook is the
// one place a workspace screen learns the browser's own online/offline signal and turns it into the save
// state every editor and `WorkspaceStatus` already read. Reconnecting uses `refreshService`, not
// `loadService`, so the workspace never unmounts and a half-typed edit survives the round trip.

import { useEffect } from 'preact/hooks';

import { refreshService, saveState } from '../state/workspace-store.js';

/** Freezes editing when the browser goes offline, and re-checks the service once it comes back. */
export function useConnection(id: string): void {
  useEffect(() => {
    const goOffline = (): void => {
      saveState.value = 'offline';
    };
    const goOnline = (): void => {
      saveState.value = 'checking';
      void refreshService(id).then((ok) => {
        // A fresh `offline` event may have already landed while this request was in flight; leave it be
        // rather than reporting the client online when it no longer is.
        if (saveState.value !== 'checking') return;
        saveState.value = ok ? 'idle' : 'offline';
      });
    };
    globalThis.addEventListener('offline', goOffline);
    globalThis.addEventListener('online', goOnline);
    return (): void => {
      globalThis.removeEventListener('offline', goOffline);
      globalThis.removeEventListener('online', goOnline);
    };
  }, [id]);
}

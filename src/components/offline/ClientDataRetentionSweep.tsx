'use client';

/**
 * Runs the client data-retention sweep once per launch.
 *
 * Renders nothing. Mounted beside the other global side-effect
 * components in the root layout so it runs on every entry to the app,
 * including a PWA cold start — which is the moment that matters, since
 * the thing being bounded is how long a device keeps a farm between
 * sessions.
 *
 * Deliberately NOT tied to service-worker registration: that is gated on
 * `NODE_ENV === 'production'`, and retention should hold in every
 * environment. Deliberately not on an interval either — a sweep that
 * fires while an operator works offline would be pure risk for no gain,
 * because the exposure it bounds is measured in days, not minutes.
 *
 * Fire-and-forget: `sweepClientStores` never throws, and nothing in the
 * app waits on it. It cannot delay first paint or block a render.
 */
import { useEffect } from 'react';
import { sweepClientStores } from '@/lib/offline/client-data-retention';

export function ClientDataRetentionSweep() {
    useEffect(() => {
        void sweepClientStores();
    }, []);
    return null;
}

export default ClientDataRetentionSweep;

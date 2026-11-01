'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

import {
    flushUsageEvents,
    recordUsageEvent,
    setUsageTelemetryEnabled,
    surfaceForPath,
    tenantSlugForPath,
} from '@/lib/telemetry/usage-client';

/**
 * Mounts the web half of #493: a `screen_opened` per navigation, and the flush
 * that gets the last one out.
 *
 * `enabled` is resolved on the SERVER and passed down. There is deliberately no
 * client-side flags hook in this codebase — adding one would be a second source
 * of truth for a kill switch, and the whole point of `usage.events` is that an
 * operator can turn telemetry off without shipping an image.
 *
 * Renders nothing.
 */
export function UsageTelemetry({ enabled }: { enabled: boolean }) {
    const pathname = usePathname();
    const lastSurface = useRef<string | null>(null);

    useEffect(() => {
        setUsageTelemetryEnabled(enabled);
    }, [enabled]);

    useEffect(() => {
        if (!enabled || !pathname) return;
        const surface = surfaceForPath(pathname);
        const slug = tenantSlugForPath(pathname);
        if (!surface || !slug) return;

        // One event per ARRIVAL, not per render. Next re-runs effects on
        // searchParam changes and on remounts, and a filter change is not a
        // new screen open — counting it would make «Борса» look several times
        // busier than «Дневник» purely because it has more facets.
        const key = `${slug}:${surface}`;
        if (lastSurface.current === key) return;
        lastSurface.current = key;

        recordUsageEvent(slug, 'screen_opened', surface);
    }, [enabled, pathname]);

    useEffect(() => {
        if (!enabled) return;
        // `pagehide`, not `beforeunload`: Safari on iOS does not reliably fire
        // the latter, and this product's users are largely on iOS. `visibility
        // change` to hidden covers a tab switch, which on a phone is most of
        // how a session actually ends.
        const flush = () => void flushUsageEvents();
        const onHide = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', onHide);
        return () => {
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', onHide);
            // No flush on unmount: this component lives for the session, so an
            // unmount is a navigation away from the app and `pagehide` has it.
        };
    }, [enabled]);

    return null;
}

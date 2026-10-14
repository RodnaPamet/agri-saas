'use client';

/**
 * Registers the operator-PWA service worker (`/public/sw.js`).
 *
 * Production-only: a SW intercepting fetches in dev fights Next.js HMR /
 * Fast Refresh, so registration is gated on `NODE_ENV === 'production'`.
 * Renders nothing. The SW itself is conservative (static-asset shell
 * cache only) — offline writes are handled by the client outbox, not the
 * SW.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    noteOutboxDrainedElsewhere,
    noteOutboxRecreatedElsewhere,
} from '@/lib/offline/outbox-state';
import { InstallPrompt } from './InstallPrompt';
import { UpdateAvailableBanner } from './UpdateAvailableBanner';
import { isChunkLoadError } from '@/lib/pwa/chunk-error';

export function ServiceWorkerRegistrar() {
    // The new SW parked in "waiting" (a deploy landed while the app is open).
    // Surfaced as a non-blocking "Update ready — refresh" prompt; the update
    // only applies on the operator's consent (SKIP_WAITING) — never mid-session.
    const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
    // One reload per apply, shared between every trigger (controllerchange,
    // the new worker's own `activated` statechange, and the fallback timer)
    // so whichever fires first wins and the others are no-ops.
    const reloadedRef = useRef(false);
    // Set when the operator TAPS "Update ready — refresh". `controllerchange`
    // cannot distinguish a consented takeover from a first install on its own
    // (see the listener below), and this is the half it cannot observe.
    const consentedRef = useRef(false);
    const reloadOnce = useCallback(() => {
        if (reloadedRef.current) return;
        reloadedRef.current = true;
        window.location.reload();
    }, []);

    useEffect(() => {
        if (process.env.NODE_ENV !== 'production') return;
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
        const register = () => {
            navigator.serviceWorker
                .register('/sw.js')
                .then((reg) => {
                    if (!reg) return;
                    // An update may already be parked (installed while closed).
                    if (reg.waiting && navigator.serviceWorker.controller) {
                        setWaitingWorker(reg.waiting);
                    }
                    // A new worker finished installing → offer the update once
                    // it reaches "installed" WITH an existing controller (i.e.
                    // it's an update, not the first install).
                    reg.addEventListener('updatefound', () => {
                        const nw = reg.installing;
                        if (!nw) return;
                        nw.addEventListener('statechange', () => {
                            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                                setWaitingWorker(nw);
                            }
                        });
                    });
                })
                .catch(() => {
                    /* registration is best-effort — the app works without it */
                });
        };
        if (document.readyState === 'complete') register();
        else window.addEventListener('load', register, { once: true });

        // A new worker took over → reload once so the page runs the new assets.
        // Guarded against a reload loop. This is the fast path; `applyUpdate`
        // adds belt-and-braces triggers because `controllerchange` is
        // documented as unreliable on some browsers (notably iOS Safari), which
        // would otherwise strand the operator on a banner whose button "does
        // nothing".
        //
        // This comment used to read "the waiting worker took over (after
        // SKIP_WAITING)", and that premise is what made the listener
        // unconditional — it describes only ONE of the two ways the event
        // arrives. The sibling branches above both guard on
        // `navigator.serviceWorker.controller` for exactly this distinction
        // ("it's an update, not the first install"); this listener was the one
        // place that omitted it.
        //
        // Captured AT MOUNT, and that is the whole point: by the time the event
        // fires, `navigator.serviceWorker.controller` is non-null in BOTH
        // worlds, so reading it inside the handler cannot tell them apart.
        const hadControllerAtMount = navigator.serviceWorker.controller !== null;
        const onControllerChange = () => {
            // A controller change is worth a reload in exactly two cases, and a
            // FIRST INSTALL is neither:
            //
            //   (a) the page was already controlled — a new worker has taken
            //       over, so this document is running against assets the new
            //       worker has superseded;
            //   (b) the operator consented, which is what the banner drives.
            //
            // A first claim replaces nothing: the document was served by the
            // network and the code it is running is current. `sw.js`'s activate
            // handler calls `self.clients.claim()` unconditionally, and on a
            // first visit there is no incumbent to wait for — install skips
            // `skipWaiting`, but with nothing to wait on the worker activates
            // and claims straight away. So an unguarded reload here fires on
            // EVERY first visit, discarding whatever the operator had typed.
            //
            // Confirmed mechanism, not a hypothesis: it is the cause recorded
            // for #1329 in `tests/e2e/known-flakes.json`, found 2026-10-11 by
            // the theme-first-paint investigation after it had produced three
            // different symptoms in that one spec.
            if (!hadControllerAtMount && !consentedRef.current) return;
            reloadOnce();
        };
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

        // Fallback flush trigger for browsers without Background Sync (iOS
        // Safari): on regained connectivity, nudge the SW to replay the
        // outbox. Browsers WITH Background Sync already replay via the
        // 'flush-outbox' sync tag, so this is harmless there.
        const nudgeFlush = () => {
            navigator.serviceWorker.ready
                .then((reg) => reg.active?.postMessage({ type: 'flush-outbox' }))
                .catch(() => {});
        };
        window.addEventListener('online', nudgeFlush);

        // The worker found the outbox database rebuilt — i.e. the phone
        // evicted queued work. It opens the same database we do, and
        // `indexedDB.open` cannot open without creating, so on browsers where
        // the worker cannot pre-check existence it is the worker that
        // consumes the one creation event. Only this side can tell the
        // operator, so take the signal and re-run the detector.
        const onMessage = (event: MessageEvent) => {
            const type = (event.data as { type?: string } | null)?.type;
            if (type === 'outbox-db-recreated') {
                void noteOutboxRecreatedElsewhere();
                return;
            }
            // The worker drained the queue — re-read it so the pending count
            // stops reporting work that has already reached the server. The
            // worker also sends `retryAfterSeconds`; it is deliberately not
            // wired to anything here, because no surface renders backoff and
            // the page's own flush path already schedules its own retry
            // (`use-offline-sync.ts`). Consuming it would mean inventing UI,
            // which is a separate decision.
            if (type === 'outbox-flushed') void noteOutboxDrainedElsewhere();
        };
        navigator.serviceWorker.addEventListener('message', onMessage);

        return () => {
            window.removeEventListener('online', nudgeFlush);
            navigator.serviceWorker.removeEventListener('message', onMessage);
            navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        };
        // reloadOnce is a stable useCallback([]) — listed to satisfy
        // exhaustive-deps without changing the run-once semantics.
    }, [reloadOnce]);

    // ChunkLoadError recovery. A lazy route/component chunk that fails to load
    // mid-navigation (flaky rural LTE, or a stale chunk hash after a deploy)
    // otherwise strands the operator on a half-rendered page — Sentry already
    // treats the error as benign, but nothing recovered from it. Reload once
    // to fetch the chunk fresh; a 10s timestamp guard prevents a reload loop
    // when the chunk is genuinely gone. Production-only (a reload would fight
    // Next HMR in dev; the E2E build runs production, so it's covered there).
    useEffect(() => {
        if (process.env.NODE_ENV !== 'production') return;
        const RELOAD_KEY = 'chunkReloadAt';
        const recover = (message: string, name?: string) => {
            if (!isChunkLoadError(message, name)) return;
            let last = 0;
            try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0); } catch { /* private mode */ }
            const now = Date.now();
            if (now - last < 10_000) return; // reloaded recently → real failure, don't loop
            try { sessionStorage.setItem(RELOAD_KEY, String(now)); } catch { /* private mode */ }
            window.location.reload();
        };
        const onError = (e: ErrorEvent) => recover(e.message || '', (e.error as Error | undefined)?.name);
        const onRejection = (e: PromiseRejectionEvent) => {
            const r = e.reason as { message?: string; name?: string } | undefined;
            recover(r?.message || String(e.reason ?? ''), r?.name);
        };
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
        };
    }, []);

    // Consent → tell the waiting worker to take over. It skipWaiting()s,
    // activates + claims, and the page reloads onto the new assets. Only ever
    // fired on an explicit tap, so a deploy never interrupts an in-flight
    // outbox flush.
    //
    // Robustness matters here: the naive "postMessage to the captured
    // waitingWorker, then wait for controllerchange" is fragile in production —
    // (a) the captured ref can be STALE (on a busy deploy a newer worker
    // supersedes it, leaving the ref pointing at a now-`redundant` worker whose
    // postMessage is a silent no-op), and (b) `controllerchange` is not
    // reliably delivered on every browser. Either alone makes the button
    // "do nothing". So we: re-query the LIVE `reg.waiting` at click time,
    // reload on the new worker's own `activated` statechange (reliable) as well
    // as `controllerchange` (fast path), and keep a bounded fallback reload as
    // the last resort. `reloadOnce` collapses whichever fires first.
    const applyUpdate = useCallback(() => {
        // Record the consent BEFORE anything async: `controllerchange` is the
        // fast path and can land before `getRegistration()` resolves.
        consentedRef.current = true;
        const target = (worker: ServiceWorker | null | undefined) => {
            if (!worker) {
                // No waiting worker to activate (superseded / already gone) —
                // a plain reload still gets the operator off the stale page.
                reloadOnce();
                return;
            }
            worker.addEventListener('statechange', () => {
                if (worker.state === 'activated') reloadOnce();
            });
            worker.postMessage({ type: 'SKIP_WAITING' });
            // Fallback: if neither `activated` nor `controllerchange` lands
            // (browser quirk), force the reload so the tap is never a dead end.
            window.setTimeout(reloadOnce, 3000);
        };
        // Prefer the live registration's current waiting worker over the
        // possibly-stale captured ref.
        navigator.serviceWorker
            .getRegistration()
            .then((reg) => target(reg?.waiting ?? waitingWorker))
            .catch(() => target(waitingWorker));
    }, [waitingWorker, reloadOnce]);

    return (
        <>
            <InstallPrompt />
            {waitingWorker && <UpdateAvailableBanner onApply={applyUpdate} />}
        </>
    );
}

export default ServiceWorkerRegistrar;

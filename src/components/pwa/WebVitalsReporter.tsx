'use client';

/**
 * WebVitalsReporter — beacons Core Web Vitals (LCP, INP, CLS, FCP, TTFB) to
 * /api/metrics for real-user monitoring. INP in particular is a FIELD-only
 * metric (Lighthouse lab uses TBT as its proxy), so this is how we track it.
 *
 * `web-vitals` is dynamically imported so it never lands in the initial
 * bundle, and reporting uses `sendBeacon` so it survives page unload.
 * Entirely best-effort — any failure is swallowed.
 */
import { useEffect } from 'react';
import type { Metric } from 'web-vitals';

import { isPublicSurface } from '@/lib/i18n/public-surface';

export function WebVitalsReporter() {
    useEffect(() => {
        let cancelled = false;

        /** The coarse label, derived once — see the note on `surface` below. */
        const surfaceOf = () =>
            isPublicSurface(window.location.pathname) ? 'public-farm' : 'app';

        /**
         * Tell the sink that the CHANNEL failed (#1940).
         *
         * Over 30 days this pipeline produced 1857 requests and zero vitals,
         * and the reason nobody noticed is that it could not report its own
         * failure: the import's catch was empty and `sendBeacon`'s boolean
         * return was discarded, so a dead channel looked like a healthy one
         * with nothing interesting to say.
         *
         * `fetch`, never `sendBeacon` — one of the two things this reports is
         * `sendBeacon` refusing, so using it here would be asking the broken
         * part to carry the news. Still best-effort: a visitor's page must
         * not break because telemetry failed. The difference is that the
         * failure now lands in a log someone can query, instead of nowhere.
         */
        const reportChannelError = (reason: 'import-failed' | 'beacon-refused') => {
            try {
                void fetch('/api/metrics', {
                    method: 'POST',
                    body: JSON.stringify({ channelError: reason, surface: surfaceOf() }),
                    headers: { 'Content-Type': 'application/json' },
                    keepalive: true,
                }).catch(() => {});
            } catch {
                /* ignore */
            }
        };

        const report = (metric: Metric) => {
            try {
                const body = JSON.stringify({
                    name: metric.name,
                    value: metric.value,
                    rating: metric.rating,
                    id: metric.id,
                    navigationType: metric.navigationType,
                    /**
                     * WHICH surface this measurement is from — #1814.
                     *
                     * Without it every beacon lands in one pool, and a p75
                     * over the operator app mixed with `/f/{handle}` says
                     * nothing about the page that actually has a performance
                     * budget. P6.5's target is about the public profile; the
                     * app is heavier and has far more traffic, so an
                     * undifferentiated median is dominated by the surface
                     * nobody set a budget for.
                     *
                     * A COARSE LABEL, never the pathname. A real path carries
                     * a tenant slug and record ids (`/t/acme/assets/cmv…`),
                     * and this beacon's whole premise is that it logs nothing
                     * about who sent it — the sink's docblock says "No PII:
                     * only the metric name / value / rating". A handle is
                     * public, but `/t/{slug}/…` is not, and one label cannot
                     * be safe for one surface and unsafe for the other.
                     *
                     * Derived with `isPublicSurface`, the same function the
                     * middleware uses to set the public-surface header — not a
                     * second prefix list. Two lists is how the label and the
                     * trimmed message catalogue come to disagree about what
                     * counts as public.
                     */
                    surface: surfaceOf(),
                });
                if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
                    // The RETURN VALUE, which used to be discarded (#1940).
                    // `false` means the browser refused to queue it — over
                    // quota, or a payload it will not take — and the
                    // measurement was simply lost. Falling back to `fetch`
                    // recovers it, and the diagnostic says it happened so a
                    // systematic refusal is visible rather than a quiet
                    // shortfall in the sample.
                    if (!navigator.sendBeacon('/api/metrics', body)) {
                        reportChannelError('beacon-refused');
                        void fetch('/api/metrics', {
                            method: 'POST',
                            body,
                            headers: { 'Content-Type': 'application/json' },
                            keepalive: true,
                        }).catch(() => {});
                    }
                } else {
                    void fetch('/api/metrics', {
                        method: 'POST',
                        body,
                        headers: { 'Content-Type': 'application/json' },
                        keepalive: true,
                    }).catch(() => {});
                }
            } catch {
                /* ignore */
            }
        };
        import('web-vitals')
            .then(({ onCLS, onINP, onLCP, onFCP, onTTFB }) => {
                if (cancelled) return;
                onCLS(report);
                onINP(report);
                onLCP(report);
                onFCP(report);
                onTTFB(report);
            })
            .catch(() => {
                // The candidate this distinguishes: the chunk being blocked by
                // the nonce-based strict CSP. `script-src` would stop the
                // import while `connect-src` still allows `'self'`, so this
                // POST arrives even when no metric ever can (#1940).
                if (!cancelled) reportChannelError('import-failed');
            });
        return () => {
            cancelled = true;
        };
    }, []);
    return null;
}

export default WebVitalsReporter;

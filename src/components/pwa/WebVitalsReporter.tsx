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
                    surface: isPublicSurface(window.location.pathname)
                        ? 'public-farm'
                        : 'app',
                });
                if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
                    navigator.sendBeacon('/api/metrics', body);
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
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);
    return null;
}

export default WebVitalsReporter;

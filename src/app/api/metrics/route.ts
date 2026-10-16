import { NextRequest } from 'next/server';
import { logger } from '@/lib/observability/logger';

/**
 * Anonymous web-vitals RUM sink. Public (see `isPublicPath`) and bare (no
 * mutation rate-limit — vitals beacon several times per page load). No PII:
 * only the metric name / value / rating. Always 204s; a malformed beacon is
 * ignored.
 */
export async function POST(req: NextRequest) {
    try {
        const m = (await req.json()) as {
            name?: unknown;
            value?: unknown;
            rating?: unknown;
            navigationType?: unknown;
            surface?: unknown;
        };
        if (typeof m?.name === 'string' && typeof m?.value === 'number' && Number.isFinite(m.value)) {
            logger.info('web-vital', {
                component: 'web-vitals',
                metric: m.name,
                value: Math.round(m.value * 1000) / 1000,
                rating: typeof m.rating === 'string' ? m.rating : undefined,
                navigationType: typeof m.navigationType === 'string' ? m.navigationType : undefined,
                /**
                 * The surface the measurement came from (#1814), so a p75 can
                 * be taken PER SURFACE. Validated against a closed set rather
                 * than echoed: this endpoint is public and unauthenticated, so
                 * anything a stranger posts would otherwise become a log
                 * field — and an unbounded string in a log line is how a
                 * public beacon turns into a log-injection surface.
                 *
                 * An unrecognised value is dropped, not coerced to 'app'. A
                 * default would silently attribute someone else's beacon to a
                 * real surface, which is worse for the one question this field
                 * exists to answer.
                 */
                surface: m.surface === 'public-farm' || m.surface === 'app' ? m.surface : undefined,
            });
        }
    } catch {
        /* malformed beacon — ignore */
    }
    return new Response(null, { status: 204 });
}

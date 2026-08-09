/**
 * Module-usage telemetry with a DEVICE dimension (Roadmap-5 PR5).
 *
 * Recorded where module gating already runs (`assertModuleEnabled` /
 * `requireModule`): every gate call increments a counter tagged by the
 * `ModuleKey` AND a coarse device class. For a mobile-first product this is the
 * deciding evidence for the product-identity ADR — if agri modules are consumed
 * from phones and the compliance core only from desktops, the split isn't
 * hypothetical, it's how users already behave.
 *
 * Device class is EXACTLY two values (`mobile` | `desktop`) — no cardinality
 * risk — derived server-side from the `sec-ch-ua-mobile` client hint, with a
 * User-Agent regex fallback for clients that don't send the hint.
 */
import { metrics } from '@opentelemetry/api';
import type { ModuleKey } from '@prisma/client';

// Same meter the rest of observability uses (a documented brand survivor).
const METER_NAME = 'inflect-compliance';

export type DeviceClass = 'mobile' | 'desktop';

let _moduleAccess: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;
function getModuleAccessCounter() {
    if (!_moduleAccess) {
        _moduleAccess = metrics.getMeter(METER_NAME).createCounter('module.access.count', {
            description: 'Module-gate access attempts, tagged by module + device class',
            unit: '1',
        });
    }
    return _moduleAccess;
}

const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i;

/**
 * Resolve the caller's device class from request headers. Prefers the
 * `sec-ch-ua-mobile` client hint (`?1` = mobile, `?0` = not), falling back to a
 * User-Agent regex. Returns `desktop` when there is no request scope (jobs,
 * tests) so the metric never throws.
 */
export async function resolveDeviceClass(): Promise<DeviceClass> {
    try {
        // Lazy import so next/headers never lands in a non-request bundle.
        const { headers } = await import('next/headers');
        const h = await headers();
        const hint = h.get('sec-ch-ua-mobile');
        if (hint === '?1') return 'mobile';
        if (hint === '?0') return 'desktop';
        const ua = h.get('user-agent') ?? '';
        return MOBILE_UA.test(ua) ? 'mobile' : 'desktop';
    } catch {
        return 'desktop';
    }
}

/**
 * Record one module-gate access. Best-effort + never throws — telemetry must
 * not affect the gate's practice flow.
 */
export async function recordModuleAccess(moduleKey: ModuleKey): Promise<void> {
    try {
        const device = await resolveDeviceClass();
        getModuleAccessCounter().add(1, { module: moduleKey, device });
    } catch {
        /* metrics are best-effort */
    }
}

/** Test-only: forget the memoised counter. */
export function __resetModuleMetricsForTests(): void {
    _moduleAccess = null;
}

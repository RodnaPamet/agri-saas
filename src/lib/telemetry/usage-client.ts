import {
    MAX_USAGE_EVENTS_PER_BATCH,
    USAGE_SURFACES,
    isUsageEventName,
    type UsageEventName,
    type UsageSurface,
} from '@/app-layer/telemetry/usage-events';

/**
 * The browser's usage-event queue — #493, web half.
 *
 * Owner chose web AND iOS, so the same closed vocabulary is emitted from both.
 * This is deliberately the same design the phone uses, because two clients
 * writing to one table should fail the same way:
 *
 *   · **In memory only.** Nothing on disk — no localStorage, no IndexedDB.
 *     There is nothing to evict, nothing to recover and nothing left behind on
 *     a shared machine. A lost queue costs a measurement, which is the cheapest
 *     thing in this system to lose.
 *   · **Keyed by farm.** The queue carries the tenant each event was recorded
 *     under, so switching farms mid-session can never post farm A's events to
 *     farm B's path.
 *   · **Telemetry never fails the product.** Every path here swallows. A
 *     non-2xx drops the batch and moves on; nothing is retried aggressively,
 *     nothing is surfaced, nothing throws into a render.
 *
 * It is NOT the offline outbox and must never become it. The outbox exists
 * because field work is irreplaceable; a screen-open is not, and giving
 * telemetry durability machinery would put a farmer's lost treatment record in
 * competition with a count of page views.
 */

interface QueuedEvent {
    tenantSlug: string;
    name: UsageEventName;
    surface?: UsageSurface;
    at: string;
}

/** Flush when the queue reaches this. Below the server's per-batch cap. */
const FLUSH_AT_EVENTS = 20;

/** ...or after this long, whichever comes first. */
const FLUSH_INTERVAL_MS = 2 * 60 * 1000;

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = false;

const SURFACES = new Set<string>(USAGE_SURFACES);

/**
 * The tenant-scoped prefix stripped off, leaving a surface the server knows.
 *
 * `/t/acme/journal` → `/journal`. Returns null for anything the closed list
 * does not contain — a route the vocabulary has no name for is NOT reported,
 * rather than reported under a guessed name. The server would drop it anyway;
 * dropping it here saves the round trip and keeps the two sides agreeing.
 */
export function surfaceForPath(pathname: string): UsageSurface | null {
    const withoutTenant = pathname.replace(/^\/t\/[^/]+/, '');
    // Longest match first: `/grain/calculator` must win over `/grain`.
    const candidates = [...SURFACES].sort((a, b) => b.length - a.length);
    for (const s of candidates) {
        if (withoutTenant === s || withoutTenant.startsWith(`${s}/`)) return s as UsageSurface;
    }
    return null;
}

/** The farm slug from a tenant-scoped path, or null off one. */
export function tenantSlugForPath(pathname: string): string | null {
    const m = /^\/t\/([^/]+)/.exec(pathname);
    return m ? (m[1] ?? null) : null;
}

/**
 * Turn recording on or off. Resolved on the SERVER and passed down — there is
 * no client-side flags hook in this codebase and adding one would be a second
 * source of truth for a kill switch.
 *
 * Turning it OFF discards whatever is queued rather than flushing it: if an
 * operator has just disabled telemetry, sending the last 19 events is the one
 * thing they did not ask for.
 */
export function setUsageTelemetryEnabled(next: boolean): void {
    enabled = next;
    if (!next) {
        queue = [];
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }
}

/** Record one event. Safe to call from anywhere; never throws. */
export function recordUsageEvent(
    tenantSlug: string | null,
    name: string,
    surface?: string | null,
): void {
    try {
        if (!enabled || !tenantSlug || !isUsageEventName(name)) return;
        if (name === 'screen_opened' && (!surface || !SURFACES.has(surface))) return;

        queue.push({
            tenantSlug,
            name,
            ...(name === 'screen_opened' && surface ? { surface: surface as UsageSurface } : {}),
            at: new Date().toISOString(),
        });

        // A hard ceiling so a runaway caller cannot grow this without bound.
        // Oldest go first: in a flood the recent events describe what the
        // person is doing NOW, which is the question this data answers.
        if (queue.length > MAX_USAGE_EVENTS_PER_BATCH * 4) {
            queue = queue.slice(-MAX_USAGE_EVENTS_PER_BATCH * 4);
        }

        if (queue.length >= FLUSH_AT_EVENTS) void flushUsageEvents();
        else scheduleFlush();
    } catch {
        // Recording a measurement must never break a render.
    }
}

function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        void flushUsageEvents();
    }, FLUSH_INTERVAL_MS);
}

/**
 * Send what is queued, one request per farm.
 *
 * `keepalive` so a flush started during page-hide still goes out — that is the
 * flush that captures the last screen of a session, which is otherwise the one
 * always missing.
 */
export async function flushUsageEvents(): Promise<void> {
    if (!enabled || queue.length === 0) return;

    const batch = queue;
    queue = [];
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }

    // Grouped by farm because the tenant is in the PATH. A single request with
    // mixed tenants would attribute one farm's usage to another.
    const byTenant = new Map<string, QueuedEvent[]>();
    for (const e of batch) {
        const list = byTenant.get(e.tenantSlug) ?? [];
        list.push(e);
        byTenant.set(e.tenantSlug, list);
    }

    for (const [slug, events] of byTenant) {
        for (let i = 0; i < events.length; i += MAX_USAGE_EVENTS_PER_BATCH) {
            const chunk = events.slice(i, i + MAX_USAGE_EVENTS_PER_BATCH);
            try {
                await fetch(`/api/t/${encodeURIComponent(slug)}/usage-events`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    keepalive: true,
                    body: JSON.stringify({
                        events: chunk.map((e) => ({
                            name: e.name,
                            ...(e.surface ? { surface: e.surface } : {}),
                            at: e.at,
                        })),
                    }),
                });
                // Deliberately no response handling. A 403 (flag off), a 429
                // (rate limited) and a 500 are all the same instruction here:
                // drop it. Re-queuing on failure is how a telemetry client
                // turns an outage into a self-inflicted flood.
            } catch {
                // Offline, aborted on navigation, blocked — all fine to lose.
            }
        }
    }
}

/** Test seam: the queue depth, for asserting batching without reaching inside. */
export function queuedUsageEventCount(): number {
    return queue.length;
}

/** Test seam: reset module state between cases. */
export function resetUsageTelemetryForTests(): void {
    queue = [];
    enabled = false;
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
}

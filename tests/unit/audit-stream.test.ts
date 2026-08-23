/**
 * Unit tests for `src/app-layer/events/audit-stream.ts` (Epic C.4).
 *
 * Covers:
 *   - payload shape (schema, signature, no PII echo)
 *   - HMAC-SHA256 signing with the tenant secret
 *   - batch-by-count flush (≥100 events for a single tenant)
 *   - batch-by-time flush (5s timer)
 *   - tenant-config gating (no URL → silent drop, audit row not affected)
 *   - fail-safe on POST error (no throw to caller; subsequent events still buffered)
 *   - per-tenant isolation (one tenant's batch never carries another's events)
 *   - hard cap (oldest dropped above BUFFER_HARD_CAP)
 */

// Intercept the OTel counter call without breaking other exports from
// the metrics module (transitive imports in the test graph use the real
// ones). Keep everything else as requireActual.
jest.mock('@/lib/observability/metrics', () => {
    const actual = jest.requireActual('@/lib/observability/metrics');
    return {
        ...actual,
        recordAuditStreamDelivery: jest.fn(),
        recordAuditStreamBufferOverflow: jest.fn(),
        startAuditStreamBufferReporting: jest.fn(),
    };
});

import { computeHmacSha256 } from '@/app-layer/integrations/webhook-crypto';
import {
    recordAuditStreamDelivery,
    recordAuditStreamBufferOverflow,
} from '@/lib/observability/metrics';

import {
    streamAuditEvent,
    flushAllAuditStreams,
    __setStreamPost,
    __setTenantStreamConfigResolver,
    __resetAuditStreamForTests,
    __setRetryBaseDelayMs,
    __resetRetryBaseDelayMs,
    type StreamedAuditEvent,
    type AuditStreamPayload,
} from '@/app-layer/events/audit-stream';

const mockRecordDelivery = recordAuditStreamDelivery as jest.MockedFunction<
    typeof recordAuditStreamDelivery
>;
const mockRecordOverflow = recordAuditStreamBufferOverflow as jest.MockedFunction<
    typeof recordAuditStreamBufferOverflow
>;

// ─── Test harness ──────────────────────────────────────────────────

interface CapturedPost {
    url: string;
    body: string;
    headers: Record<string, string>;
}

let capturedPosts: CapturedPost[] = [];
let nextPostResult: { ok: boolean; status: number; statusText?: string } = {
    ok: true,
    status: 200,
};

function makeEvent(
    overrides: Partial<StreamedAuditEvent> = {},
): StreamedAuditEvent {
    return {
        id: `cuid-${Math.random().toString(36).slice(2, 10)}`,
        entryHash: 'h1',
        previousHash: null,
        tenantId: 'tenant-1',
        userId: 'user-1',
        actorType: 'USER',
        entity: 'Practice',
        entityId: 'ctrl-1',
        action: 'CONTROL_CREATED',
        detailsJson: { category: 'entity_lifecycle', operation: 'created' },
        metadataJson: { source: 'unit-test' },
        requestId: 'req-1',
        occurredAt: '2026-04-23T13:00:00.000Z',
        ...overrides,
    };
}

beforeEach(() => {
    __resetAuditStreamForTests();
    mockRecordDelivery.mockClear();
    mockRecordOverflow.mockClear();
    // Zero backoff so retry loops don't introduce real-time waits in tests.
    __setRetryBaseDelayMs(0);
    capturedPosts = [];
    nextPostResult = { ok: true, status: 200 };

    __setStreamPost(async (url, body, headers) => {
        capturedPosts.push({ url, body, headers });
        return nextPostResult;
    });

    __setTenantStreamConfigResolver(async (tenantId) => {
        if (tenantId === 'tenant-1') {
            return { url: 'https://siem.example/ingest', secret: 'shhh-1' };
        }
        if (tenantId === 'tenant-2') {
            return { url: 'https://siem.example/two', secret: 'shhh-2' };
        }
        return null;
    });
});

afterEach(() => {
    __resetAuditStreamForTests();
    __resetRetryBaseDelayMs();
    __setStreamPost(null);
    __setTenantStreamConfigResolver(null);
    delete process.env.AUDIT_STREAM_RETRY_ENABLED;
});

// ─── Payload shape ─────────────────────────────────────────────────

describe('audit-stream — payload shape', () => {
    it('builds a v1 envelope with tenantId, sentAt, count, events[]', async () => {
        streamAuditEvent(makeEvent());
        await flushAllAuditStreams();

        expect(capturedPosts).toHaveLength(1);
        const body = JSON.parse(capturedPosts[0].body) as AuditStreamPayload;
        expect(body.schemaVersion).toBe(1);
        expect(body.tenantId).toBe('tenant-1');
        expect(body.count).toBe(1);
        expect(typeof body.sentAt).toBe('string');
        expect(body.events).toHaveLength(1);
        expect(body.events[0].action).toBe('CONTROL_CREATED');
        expect(body.events[0].entity).toBe('Practice');
    });

    it('includes structured detailsJson but never the free-text details column', async () => {
        // Caller of streamAuditEvent never gets to forward `details`
        // (the writer drops it before calling). The streamed payload
        // here therefore only carries `detailsJson` + `metadataJson`.
        streamAuditEvent(makeEvent({
            detailsJson: { category: 'access', event: 'authz_denied', method: 'POST' },
        }));
        await flushAllAuditStreams();
        const body = JSON.parse(capturedPosts[0].body) as AuditStreamPayload;
        const ev = body.events[0];
        expect(ev.detailsJson).toEqual({
            category: 'access',
            event: 'authz_denied',
            method: 'POST',
        });
        // Sanity: payload has no `details` field.
        expect(Object.prototype.hasOwnProperty.call(ev, 'details')).toBe(false);
    });

    it('does not echo email or other PII — only opaque userId', async () => {
        streamAuditEvent(makeEvent({ userId: 'user-1' }));
        await flushAllAuditStreams();
        const body = JSON.parse(capturedPosts[0].body) as AuditStreamPayload;
        const ev = body.events[0];
        expect(ev.userId).toBe('user-1');
        expect(Object.prototype.hasOwnProperty.call(ev, 'email')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(ev, 'name')).toBe(false);
    });
});

// ─── HMAC signing ──────────────────────────────────────────────────

describe('audit-stream — HMAC signing', () => {
    it('signs the body with the tenant secret using sha256= prefix', async () => {
        streamAuditEvent(makeEvent());
        await flushAllAuditStreams();

        const post = capturedPosts[0];
        const sigHeader = post.headers['X-Inflect-Signature'];
        expect(sigHeader).toBeDefined();
        expect(sigHeader.startsWith('sha256=')).toBe(true);

        const expected = computeHmacSha256(post.body, 'shhh-1', 'hex');
        expect(sigHeader).toBe(`sha256=${expected}`);

        // Dual-emit (Roadmap-5 PR3): the canonical X-Agrent-Signature carries
        // the IDENTICAL value alongside the legacy X-Inflect-Signature.
        expect(post.headers['X-Agrent-Signature']).toBe(sigHeader);
    });

    it('uses the per-tenant secret — different tenants get different signatures', async () => {
        streamAuditEvent(makeEvent({ tenantId: 'tenant-1' }));
        streamAuditEvent(makeEvent({ tenantId: 'tenant-2' }));
        await flushAllAuditStreams();

        expect(capturedPosts).toHaveLength(2);
        const t1 = capturedPosts.find((p) => p.url.endsWith('/ingest'))!;
        const t2 = capturedPosts.find((p) => p.url.endsWith('/two'))!;
        expect(t1.headers['X-Inflect-Signature']).toBe(
            `sha256=${computeHmacSha256(t1.body, 'shhh-1', 'hex')}`,
        );
        expect(t2.headers['X-Inflect-Signature']).toBe(
            `sha256=${computeHmacSha256(t2.body, 'shhh-2', 'hex')}`,
        );
    });

    it('sets Content-Type and User-Agent', async () => {
        streamAuditEvent(makeEvent());
        await flushAllAuditStreams();

        const headers = capturedPosts[0].headers;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['User-Agent']).toMatch(/Agrent-Audit-Stream/);
    });
});

// ─── Batching ──────────────────────────────────────────────────────

describe('audit-stream — batching', () => {
    it('flushes immediately when the per-tenant buffer reaches 100 events', async () => {
        for (let i = 0; i < 99; i++) {
            streamAuditEvent(makeEvent({ id: `e${i}` }));
        }
        // Microtask boundary so any pending promise can run; expect NO
        // POSTs yet — we're under the 100-event threshold.
        await Promise.resolve();
        expect(capturedPosts).toHaveLength(0);

        streamAuditEvent(makeEvent({ id: 'e99' }));
        // The 100th event triggers an async flush; await it.
        await flushAllAuditStreams();

        expect(capturedPosts).toHaveLength(1);
        const body = JSON.parse(capturedPosts[0].body) as AuditStreamPayload;
        expect(body.count).toBe(100);
    });

    it('keeps each tenant in its own batch — never mixes payloads', async () => {
        streamAuditEvent(makeEvent({ tenantId: 'tenant-1', id: 'a' }));
        streamAuditEvent(makeEvent({ tenantId: 'tenant-2', id: 'b' }));
        streamAuditEvent(makeEvent({ tenantId: 'tenant-1', id: 'c' }));
        await flushAllAuditStreams();

        expect(capturedPosts).toHaveLength(2);
        for (const p of capturedPosts) {
            const body = JSON.parse(p.body) as AuditStreamPayload;
            for (const ev of body.events) {
                expect(ev.tenantId).toBe(body.tenantId);
            }
        }
    });

    it('drains a partial batch via the time-based flush (manual flushAll)', async () => {
        // We use jest fake timers + flushAll instead of waiting 5s real-time.
        streamAuditEvent(makeEvent({ id: 'lonely' }));
        // Without flushAll, no POST yet (timer hasn't fired).
        await Promise.resolve();
        expect(capturedPosts).toHaveLength(0);

        // The 5-second timer is on the buffer; flushAll bypasses it.
        await flushAllAuditStreams();
        expect(capturedPosts).toHaveLength(1);
    });
});

// ─── Periodic (time-based) flush ───────────────────────────────────

describe('audit-stream — periodic flush (FLUSH_INTERVAL_MS)', () => {
    // The 5-second timer scheduled inside `streamAuditEvent` is the OTHER
    // half of the documented "flush on 100 events OR 5 seconds" contract.
    // Every other test in this file reaches delivery through
    // `flushAllAuditStreams()`, which deliberately BYPASSES that timer —
    // so the periodic path was only ever executed when a slow run let a
    // real 5s timer fire. These tests drive it deterministically.
    //
    // Hook ordering: the file-level `beforeEach` runs first (outer →
    // inner), so the transport + resolver seams are already installed
    // when fake timers go in. On the way out the inner `afterEach` runs
    // before the file-level one, and either way both complete before the
    // next test's `beforeEach` — so no later test inherits fake timers.
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('delivers the buffered batch once 5s elapse — with no manual flush at all', async () => {
        streamAuditEvent(makeEvent({ id: 'periodic-1' }));
        streamAuditEvent(makeEvent({ id: 'periodic-2' }));

        // Under FLUSH_AT_COUNT and the timer has not fired: nothing sent.
        await Promise.resolve();
        expect(capturedPosts).toHaveLength(0);

        // Advance exactly FLUSH_INTERVAL_MS. The async variant drains
        // microtasks between ticks, so the resolver → deliverBatch →
        // postFn chain settles without waiting on real time.
        await jest.advanceTimersByTimeAsync(5_000);

        // The observable outcome — the transport was actually CALLED with
        // the buffered events, not merely that a timer was scheduled.
        expect(capturedPosts).toHaveLength(1);
        expect(capturedPosts[0].url).toBe('https://siem.example/ingest');
        const body = JSON.parse(capturedPosts[0].body) as AuditStreamPayload;
        expect(body.count).toBe(2);
        expect(body.events.map((e) => e.id)).toEqual(['periodic-1', 'periodic-2']);
        expect(body.tenantId).toBe('tenant-1');
        // Signed like any other batch — the periodic path is not a
        // second, weaker delivery route.
        expect(capturedPosts[0].headers['X-Inflect-Signature']).toBe(
            `sha256=${computeHmacSha256(capturedPosts[0].body, 'shhh-1', 'hex')}`,
        );
        expect(mockRecordDelivery).toHaveBeenCalledTimes(1);
        expect(mockRecordDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'success', status: 200, attempts: 1 }),
        );
    });

    it('does not fire early — silent at 4999ms, delivered on the 5000th', async () => {
        streamAuditEvent(makeEvent({ id: 'not-yet' }));

        await jest.advanceTimersByTimeAsync(4_999);
        expect(capturedPosts).toHaveLength(0);
        expect(mockRecordDelivery).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(capturedPosts).toHaveLength(1);
        const body = JSON.parse(capturedPosts[0].body) as AuditStreamPayload;
        expect(body.events.map((e) => e.id)).toEqual(['not-yet']);
    });

    it('schedules one periodic flush per tenant — batches stay separate', async () => {
        streamAuditEvent(makeEvent({ tenantId: 'tenant-1', id: 'p-a' }));
        streamAuditEvent(makeEvent({ tenantId: 'tenant-2', id: 'p-b' }));

        await jest.advanceTimersByTimeAsync(5_000);

        expect(capturedPosts).toHaveLength(2);
        const t1 = capturedPosts.find((p) => p.url.endsWith('/ingest'))!;
        const t2 = capturedPosts.find((p) => p.url.endsWith('/two'))!;
        expect(
            (JSON.parse(t1.body) as AuditStreamPayload).events.map((e) => e.id),
        ).toEqual(['p-a']);
        expect(
            (JSON.parse(t2.body) as AuditStreamPayload).events.map((e) => e.id),
        ).toEqual(['p-b']);
    });

    it('rearms on the next event — a second batch flushes 5s after the first drained', async () => {
        streamAuditEvent(makeEvent({ id: 'wave-1' }));
        await jest.advanceTimersByTimeAsync(5_000);
        expect(capturedPosts).toHaveLength(1);

        // The flush cleared the timer; a fresh event must schedule a new
        // one, otherwise the buffer would sit undelivered forever.
        streamAuditEvent(makeEvent({ id: 'wave-2' }));
        await jest.advanceTimersByTimeAsync(5_000);

        expect(capturedPosts).toHaveLength(2);
        expect(
            (JSON.parse(capturedPosts[1].body) as AuditStreamPayload).events.map(
                (e) => e.id,
            ),
        ).toEqual(['wave-2']);
    });
});

// ─── Tenant config gating ──────────────────────────────────────────

describe('audit-stream — tenant config gating', () => {
    it('drops the batch silently when no webhook is configured', async () => {
        streamAuditEvent(makeEvent({ tenantId: 'tenant-without-webhook' }));
        await flushAllAuditStreams();
        expect(capturedPosts).toHaveLength(0);
    });

    it('does not POST events for an empty tenantId', async () => {
        streamAuditEvent(makeEvent({ tenantId: '' }));
        await flushAllAuditStreams();
        expect(capturedPosts).toHaveLength(0);
    });
});

// ─── Fail-safe ─────────────────────────────────────────────────────

describe('audit-stream — fail-safe behaviour', () => {
    it('does not throw when the POST returns non-2xx', async () => {
        nextPostResult = { ok: false, status: 502, statusText: 'Bad Gateway' };
        streamAuditEvent(makeEvent());
        await expect(flushAllAuditStreams()).resolves.toBeUndefined();
    });

    it('does not throw when the POST itself errors', async () => {
        __setStreamPost(async () => {
            throw new Error('connection reset');
        });
        streamAuditEvent(makeEvent());
        await expect(flushAllAuditStreams()).resolves.toBeUndefined();
    });

    it('keeps accepting events after a failed flush', async () => {
        __setStreamPost(async () => {
            throw new Error('first POST blew up');
        });
        streamAuditEvent(makeEvent({ id: 'e1' }));
        await flushAllAuditStreams();

        // Restore working post; new events should still flow.
        __setStreamPost(async (url, body, headers) => {
            capturedPosts.push({ url, body, headers });
            return { ok: true, status: 200 };
        });
        streamAuditEvent(makeEvent({ id: 'e2' }));
        await flushAllAuditStreams();
        expect(capturedPosts).toHaveLength(1);
        const body = JSON.parse(capturedPosts[0].body) as AuditStreamPayload;
        expect(body.events).toHaveLength(1);
        expect(body.events[0].id).toBe('e2');
    });

    it('coalesces concurrent flushes for the same tenant', async () => {
        // Issue two flushes back-to-back; only one POST should land.
        streamAuditEvent(makeEvent({ id: 'a' }));
        const p1 = flushAllAuditStreams();
        const p2 = flushAllAuditStreams();
        await Promise.all([p1, p2]);
        // Buffer for tenant-1 is empty after the first flush; the
        // second flush is a no-op (no events). Expect exactly 1 POST.
        expect(capturedPosts).toHaveLength(1);
    });
});

// ─── Retry behaviour (Epic E.2) ────────────────────────────────────

describe('audit-stream — retry behaviour', () => {
    it('Case A — retry happy path: 503 then 200 calls postFn twice and succeeds', async () => {
        let callCount = 0;
        __setStreamPost(async (url, body, headers) => {
            capturedPosts.push({ url, body, headers });
            callCount += 1;
            if (callCount === 1) {
                return { ok: false, status: 503, statusText: 'Service Unavailable' };
            }
            return { ok: true, status: 200, statusText: 'OK' };
        });

        streamAuditEvent(makeEvent({ id: 'retry-a' }));
        await flushAllAuditStreams();

        expect(capturedPosts).toHaveLength(2);
        // Both calls must carry the same X-Inflect-Batch-Id (idempotency key).
        expect(capturedPosts[0].headers['X-Inflect-Batch-Id']).toBeDefined();
        expect(capturedPosts[0].headers['X-Inflect-Batch-Id']).toBe(
            capturedPosts[1].headers['X-Inflect-Batch-Id'],
        );
        // Final result was ok — recorded once as a SUCCESS outcome,
        // carrying the 2 attempts (1 retry) it actually took.
        expect(mockRecordDelivery).toHaveBeenCalledTimes(1);
        expect(mockRecordDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'success', status: 200, attempts: 2 }),
        );
    });

    it('Case B — retry double-fail: 503 on all attempts increments failure count once', async () => {
        __setStreamPost(async (url, body, headers) => {
            capturedPosts.push({ url, body, headers });
            return { ok: false, status: 503, statusText: 'Service Unavailable' };
        });

        streamAuditEvent(makeEvent({ id: 'retry-b' }));
        await flushAllAuditStreams();

        // 3 attempts total (1 initial + 2 retries).
        expect(capturedPosts).toHaveLength(3);
        // One batch failed — recorded exactly once (not per-attempt),
        // as a FAILURE outcome carrying the final status + 3 attempts.
        expect(mockRecordDelivery).toHaveBeenCalledTimes(1);
        expect(mockRecordDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'failure', status: 503, attempts: 3 }),
        );
    });

    it('Case C — network throw then 200 succeeds via retry', async () => {
        let callCount = 0;
        __setStreamPost(async (url, body, headers) => {
            callCount += 1;
            if (callCount === 1) {
                throw new Error('ECONNRESET');
            }
            capturedPosts.push({ url, body, headers });
            return { ok: true, status: 200, statusText: 'OK' };
        });

        streamAuditEvent(makeEvent({ id: 'retry-c' }));
        await flushAllAuditStreams();

        // Second call succeeded — one captured POST (throw on first was swallowed).
        expect(capturedPosts).toHaveLength(1);
        expect(mockRecordDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'success', attempts: 2 }),
        );
    });

    it('Case D — kill switch AUDIT_STREAM_RETRY_ENABLED=0 sends exactly one POST', async () => {
        process.env.AUDIT_STREAM_RETRY_ENABLED = '0';

        __setStreamPost(async (url, body, headers) => {
            capturedPosts.push({ url, body, headers });
            return { ok: false, status: 503, statusText: 'Service Unavailable' };
        });

        streamAuditEvent(makeEvent({ id: 'retry-d' }));
        await flushAllAuditStreams();

        // Kill-switch forces single attempt — no retry.
        expect(capturedPosts).toHaveLength(1);
        expect(mockRecordDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'failure', status: 503, attempts: 1 }),
        );
    });
});

// ─── Delivery metrics (roadmap-2 P1) ───────────────────────────────

describe('audit-stream — delivery metrics', () => {
    it('records a success outcome with attempt count + duration on a clean delivery', async () => {
        streamAuditEvent(makeEvent({ id: 'metrics-ok' }));
        await flushAllAuditStreams();

        expect(mockRecordDelivery).toHaveBeenCalledTimes(1);
        expect(mockRecordDelivery).toHaveBeenCalledWith({
            outcome: 'success',
            status: 200,
            attempts: 1,
            durationMs: expect.any(Number),
        });
    });

    it('records a failure outcome carrying the final HTTP status', async () => {
        nextPostResult = { ok: false, status: 502, statusText: 'Bad Gateway' };
        streamAuditEvent(makeEvent({ id: 'metrics-fail' }));
        await flushAllAuditStreams();

        expect(mockRecordDelivery).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'failure', status: 502 }),
        );
    });

    it('records NO delivery when streaming is disabled for the tenant', async () => {
        // No webhook configured → the batch is dropped before
        // deliverBatch; neither success nor failure is recorded.
        streamAuditEvent(makeEvent({ tenantId: 'tenant-without-webhook' }));
        await flushAllAuditStreams();
        expect(mockRecordDelivery).not.toHaveBeenCalled();
    });

    it('records a buffer overflow when a stalled buffer exceeds the hard cap', async () => {
        // BUFFER_HARD_CAP is 1000. In a synchronous enqueue loop the
        // first flush's `flushInFlight` promise cannot settle (no
        // microtask runs mid-loop), so later flushes no-op and the
        // buffer grows until the cap sheds the oldest event.
        for (let i = 0; i <= 1200; i++) {
            streamAuditEvent(makeEvent({ id: `ov-${i}` }));
        }
        expect(mockRecordOverflow).toHaveBeenCalled();
        await flushAllAuditStreams();
    });
});

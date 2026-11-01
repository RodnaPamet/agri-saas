/**
 * The browser queue: what it refuses to send, and how it batches.
 *
 * The rules here mirror the phone's deliberately — two clients writing one
 * table should fail the same way — so each assertion is also a statement about
 * the contract the iOS client builds against.
 */
import {
    flushUsageEvents,
    queuedUsageEventCount,
    recordUsageEvent,
    resetUsageTelemetryForTests,
    setUsageTelemetryEnabled,
    surfaceForPath,
    tenantSlugForPath,
} from '@/lib/telemetry/usage-client';

const fetchMock = jest.fn();

beforeEach(() => {
    resetUsageTelemetryForTests();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterAll(() => resetUsageTelemetryForTests());

describe('surfaceForPath', () => {
    it('strips the tenant prefix and matches the closed list', () => {
        expect(surfaceForPath('/t/acme/journal')).toBe('/journal');
        expect(surfaceForPath('/t/acme/exchange')).toBe('/exchange');
    });

    it('prefers the LONGEST match', () => {
        // `/grain/calculator` must win over any shorter prefix, or every
        // calculator visit would be filed under the wrong screen.
        expect(surfaceForPath('/t/acme/grain/calculator')).toBe('/grain/calculator');
    });

    it('matches a CHILD route to its screen', () => {
        // Opening one journal entry is still the journal screen.
        expect(surfaceForPath('/t/acme/journal/abc123')).toBe('/journal');
    });

    it('returns null for a route the vocabulary has no name for', () => {
        // Not reported rather than reported under a guessed name. The server
        // would drop it anyway; refusing here keeps the two sides agreeing.
        expect(surfaceForPath('/t/acme/admin/usage')).toBeNull();
        expect(surfaceForPath('/login')).toBeNull();
    });

    it('reads the farm slug, and nothing off a tenant path', () => {
        expect(tenantSlugForPath('/t/acme/journal')).toBe('acme');
        expect(tenantSlugForPath('/login')).toBeNull();
    });
});

describe('recordUsageEvent', () => {
    it('records NOTHING while disabled', () => {
        recordUsageEvent('acme', 'cost_saved');
        expect(queuedUsageEventCount()).toBe(0);
    });

    it('drops an unknown name, and keeps a known one', () => {
        setUsageTelemetryEnabled(true);
        recordUsageEvent('acme', 'definitely_not_a_name');
        expect(queuedUsageEventCount()).toBe(0);
        recordUsageEvent('acme', 'cost_saved');
        expect(queuedUsageEventCount()).toBe(1);
    });

    it('drops a screen_opened whose surface is not in the list', () => {
        setUsageTelemetryEnabled(true);
        recordUsageEvent('acme', 'screen_opened', '/locations/abc123');
        recordUsageEvent('acme', 'screen_opened', undefined);
        expect(queuedUsageEventCount()).toBe(0);
        recordUsageEvent('acme', 'screen_opened', '/journal');
        expect(queuedUsageEventCount()).toBe(1);
    });

    it('records nothing when there is no farm', () => {
        setUsageTelemetryEnabled(true);
        recordUsageEvent(null, 'cost_saved');
        expect(queuedUsageEventCount()).toBe(0);
    });

    it('DISCARDS the queue when telemetry is switched off', async () => {
        setUsageTelemetryEnabled(true);
        recordUsageEvent('acme', 'cost_saved');
        expect(queuedUsageEventCount()).toBe(1);

        setUsageTelemetryEnabled(false);
        // Not flushed — if an operator has just disabled telemetry, sending
        // the last events is the one thing they did not ask for.
        expect(queuedUsageEventCount()).toBe(0);
        await flushUsageEvents();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('flushUsageEvents', () => {
    it('groups by FARM — one request per tenant', async () => {
        setUsageTelemetryEnabled(true);
        recordUsageEvent('acme', 'cost_saved');
        recordUsageEvent('other-farm', 'task_closed');
        await flushUsageEvents();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const paths = fetchMock.mock.calls.map((c) => c[0] as string).sort();
        // The tenant is in the PATH, so a mixed request would attribute one
        // farm's usage to another.
        expect(paths).toEqual([
            '/api/t/acme/usage-events',
            '/api/t/other-farm/usage-events',
        ]);
    });

    it('sends only name, surface and at — nothing else', async () => {
        setUsageTelemetryEnabled(true);
        recordUsageEvent('acme', 'screen_opened', '/journal');
        await flushUsageEvents();

        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
        expect(Object.keys(body)).toEqual(['events']);
        expect(Object.keys(body.events[0]).sort()).toEqual(['at', 'name', 'surface']);
        // No tenantId, no userId — those come from the session, and a client
        // that sent them would be refused the chance to misattribute.
        expect(JSON.stringify(body)).not.toContain('tenantId');
        expect(JSON.stringify(body)).not.toContain('userId');
    });

    it('auto-flushes once the queue reaches the threshold', async () => {
        setUsageTelemetryEnabled(true);
        for (let i = 0; i < 20; i++) recordUsageEvent('acme', 'cost_saved');
        // Give the floating promise a turn.
        await Promise.resolve();
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalled();
    });

    it('a failed send DROPS the batch rather than re-queuing it', async () => {
        setUsageTelemetryEnabled(true);
        fetchMock.mockRejectedValue(new Error('offline'));
        recordUsageEvent('acme', 'cost_saved');
        await flushUsageEvents();
        // Re-queuing on failure is how a telemetry client turns an outage
        // into a self-inflicted flood.
        expect(queuedUsageEventCount()).toBe(0);
    });

    it('never throws, whatever fetch does', async () => {
        setUsageTelemetryEnabled(true);
        fetchMock.mockImplementation(() => {
            throw new Error('boom');
        });
        recordUsageEvent('acme', 'cost_saved');
        await expect(flushUsageEvents()).resolves.toBeUndefined();
    });
});

/**
 * The worker capability on `/api/readyz` — #2825.
 *
 * The worker tier was dead 13-18 hours and nothing reported it: the GCP uptime
 * check probes the APP tier, which stayed green, and a failing container
 * healthcheck pages nobody. This capability is the reading that would have
 * shown it.
 *
 * What the tests are FOR is the three states staying distinguishable. A
 * capability that collapsed `unknown` into `stale` would send an operator
 * after a healthy worker during a Redis incident, and one that collapsed
 * `stale` into `unknown` would hide exactly the outage it exists to surface.
 */
import {
    workerHeartbeatCapability,
    type HeartbeatReader,
} from '@/app-layer/jobs/worker-heartbeat-capability';
import {
    WORKER_HEARTBEAT_KEY,
    WORKER_HEARTBEAT_TTL_SECONDS,
} from '@/app-layer/jobs/worker-heartbeat';

jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const NOW = 1_700_000_000_000;
const at = (ms: number) => () => ms;

/** A reader returning a fixed value, recording what it was asked for. */
function reader(value: string | null): HeartbeatReader & { asked: string[] } {
    const asked: string[] = [];
    return {
        asked,
        async get(key: string) {
            asked.push(key);
            return value;
        },
    };
}

describe('beating', () => {
    it('reports a fresh beat, with its age and the budget it was judged against', async () => {
        const r = reader(String(NOW - 30_000));
        const c = await workerHeartbeatCapability(r, at(NOW));
        expect(c.state).toBe('beating');
        expect(c.ageSeconds).toBe(30);
        // The budget travels WITH the reading, so nobody has to find it in
        // another file to know whether an age is bad.
        expect(c.ttlSeconds).toBe(WORKER_HEARTBEAT_TTL_SECONDS);
        expect(c.lastBeatAt).toBe(new Date(NOW - 30_000).toISOString());
    });

    it('reads the SAME key the container healthcheck reads', async () => {
        // Two monitors disagreeing about whether the worker is alive would be
        // worse than one, so this is pinned rather than left to coincidence.
        const r = reader(String(NOW));
        await workerHeartbeatCapability(r, at(NOW));
        expect(r.asked).toEqual([WORKER_HEARTBEAT_KEY]);
    });

    it('a beat exactly at the TTL boundary is still beating', async () => {
        const c = await workerHeartbeatCapability(
            reader(String(NOW - WORKER_HEARTBEAT_TTL_SECONDS * 1000)),
            at(NOW),
        );
        // The boundary is named deliberately: `>` not `>=`, so a beat landing
        // exactly on the budget is not reported as a failure.
        expect(c.state).toBe('beating');
    });

    it('clamps a beat stamped in the FUTURE rather than reporting a negative age', async () => {
        // A clock problem, not a fresh worker. Reported as fresh on purpose:
        // the alternative is a worker alarm for an NTP fault.
        const c = await workerHeartbeatCapability(reader(String(NOW + 60_000)), at(NOW));
        expect(c.ageSeconds).toBe(0);
        expect(c.state).toBe('beating');
    });
});

describe('stale', () => {
    it('an ABSENT key is stale, because nothing deletes it — it expires', async () => {
        const c = await workerHeartbeatCapability(reader(null), at(NOW));
        expect(c.state).toBe('stale');
        // No age to report, and it must not invent one.
        expect(c.ageSeconds).toBeNull();
        expect(c.lastBeatAt).toBeNull();
    });

    it('a beat older than the TTL is stale', async () => {
        const c = await workerHeartbeatCapability(
            reader(String(NOW - (WORKER_HEARTBEAT_TTL_SECONDS + 1) * 1000)),
            at(NOW),
        );
        expect(c.state).toBe('stale');
        expect(c.ageSeconds).toBe(WORKER_HEARTBEAT_TTL_SECONDS + 1);
    });
});

describe('unknown is its own state, never stale', () => {
    it('no Redis configured', async () => {
        const c = await workerHeartbeatCapability(null, at(NOW));
        expect(c.state).toBe('unknown');
    });

    it('a read that THROWS is unknown — a Redis problem is not a worker problem', async () => {
        // The distinction that matters at 3am: reporting an unreadable Redis as
        // a dead worker sends an operator to the wrong subsystem.
        const c = await workerHeartbeatCapability(
            { get: () => Promise.reject(new Error('connection closed')) },
            at(NOW),
        );
        expect(c.state).toBe('unknown');
        expect(c.state).not.toBe('stale');
    });

    it.each([['not a number'], [''], ['0'], ['-5'], ['NaN']])(
        'an uninterpretable value (%p) is unknown, not stale',
        async (raw) => {
            // "Could not interpret" is not "no beat".
            const c = await workerHeartbeatCapability(reader(raw), at(NOW));
            expect(c.state).toBe('unknown');
        },
    );
});

describe('the three states are actually distinct', () => {
    it('beating, stale and unknown are produced by three different inputs', async () => {
        // The negative control for the whole file: a capability hard-wired to
        // one state would satisfy a third of the assertions above and look
        // fine. This asserts the mapping is a function of the input.
        const states = await Promise.all([
            workerHeartbeatCapability(reader(String(NOW)), at(NOW)),
            workerHeartbeatCapability(reader(null), at(NOW)),
            workerHeartbeatCapability(null, at(NOW)),
        ]);
        expect(states.map((s) => s.state)).toEqual(['beating', 'stale', 'unknown']);
    });

    it('never throws, whatever the reader does', async () => {
        // It runs inside /api/readyz, which is the GCP uptime check's target.
        // A throw here would 503 the probe and page somebody for a monitoring
        // bug — the exact thing `capabilities` exists to prevent.
        await expect(
            workerHeartbeatCapability({
                get: () => {
                    throw new Error('synchronous explosion');
                },
            }),
        ).resolves.toMatchObject({ state: 'unknown' });
    });
});

/**
 * Unit tests — the offline HIBP transport (#779).
 *
 * `E2E_HIBP_FIXTURE=1` replaces the DEFAULT transport inside
 * `checkPasswordAgainstHIBP` so a test run never reaches
 * `api.pwnedpasswords.com`. Every isolated-tenant test registers a user, so a
 * full E2E run made ~55-65 range requests, and `register-atomicity.test.ts`
 * (no `jest.mock`) made three more per PR in the coverage lane.
 *
 * The load-bearing property is that it substitutes the transport and NOTHING
 * else. An early `return { breached: false }` would have been simpler and
 * wrong for the reason `basemap-fixture-tile.ts` states: a fixture that makes
 * the test pass by removing what the test exercises. These tests assert the
 * real path still runs — hashing, prefix/suffix split, body parsing, count
 * comparison — by driving BOTH outcomes through it.
 *
 * Note the gate lives inside the checker, not at the three call sites. Gating
 * at a call site would leave `tests/guardrails/hibp-coverage.test.ts` passing
 * precisely BECAUSE a source-text guard cannot see a runtime condition — which
 * is the #613 blindness that guard exists to close. Inside the checker, all
 * three route files stay byte-identical and the guard keeps its teeth.
 */
import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';

const saved = process.env.E2E_HIBP_FIXTURE;

afterEach(() => {
    if (saved === undefined) delete process.env.E2E_HIBP_FIXTURE;
    else process.env.E2E_HIBP_FIXTURE = saved;
});

describe('E2E_HIBP_FIXTURE — offline transport', () => {
    it('never reaches the network', async () => {
        process.env.E2E_HIBP_FIXTURE = '1';
        const spy = jest.spyOn(globalThis, 'fetch');
        await checkPasswordAgainstHIBP('some-unremarkable-password');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('still reports the canonical weak password as BREACHED', async () => {
        // The rejection path has to stay reachable offline. If this returned
        // not-breached, every test asserting that a weak password is refused
        // would be green over a code path that no longer runs.
        process.env.E2E_HIBP_FIXTURE = '1';
        const r = await checkPasswordAgainstHIBP('password');
        // `breached: true` is its own arm of the union, so reaching it already
        // excludes the upstream-error arm — the fixture completed, it did not
        // fail open.
        expect(r.breached).toBe(true);
    });

    it('reports an ordinary password as not breached', async () => {
        process.env.E2E_HIBP_FIXTURE = '1';
        const r = await checkPasswordAgainstHIBP('c9c1f0a4-not-in-any-corpus');
        expect(r.breached).toBe(false);
        // The union's error arm ALSO reports `breached: false`, so this second
        // assertion is what separates "the fixture answered not-breached" from
        // "the check failed open and we learned nothing". Without it a broken
        // fixture would look exactly like a clean pass.
        expect(r).not.toHaveProperty('skipped');
    });

    it('exercises the REAL parse path, not a short-circuit', async () => {
        // Both outcomes above come out of one body-parsing routine reading a
        // multi-line `SUFFIX:COUNT` response. A short-circuit could not produce
        // two different answers from the same fixture, so the pair of results
        // above IS the evidence the parser ran. This pins the corollary: a
        // `minOccurrences` above the fixture's count flips the verdict, which
        // only the count-comparison branch can do.
        process.env.E2E_HIBP_FIXTURE = '1';
        const breached = await checkPasswordAgainstHIBP('password', { minOccurrences: 1 });
        const underThreshold = await checkPasswordAgainstHIBP('password', {
            minOccurrences: 10_000_000,
        });
        expect(breached.breached).toBe(true);
        expect(underThreshold.breached).toBe(false);
    });

    it('an explicit fetchImpl still wins — the flag only swaps the DEFAULT', async () => {
        process.env.E2E_HIBP_FIXTURE = '1';
        const injected = jest.fn().mockResolvedValue(
            new Response('ABC:5', { status: 200 }),
        );
        await checkPasswordAgainstHIBP('password', {
            fetchImpl: injected as unknown as typeof fetch,
        });
        // The existing unit suite injects its own transport on every case; the
        // flag must not steal that seam out from under it.
        expect(injected).toHaveBeenCalled();
    });

    it('is OFF unless the flag is exactly "1"', async () => {
        process.env.E2E_HIBP_FIXTURE = '0';
        const spy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('', { status: 200 }));
        await checkPasswordAgainstHIBP('anything');
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

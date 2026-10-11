/**
 * P5.5a — the reduced budget actually BINDS, proven by exceeding it (#1596).
 *
 * ## Why this file exists separately from its two siblings
 *
 * P5.5's exit criterion is "a per-user abuse budget exists and is **proven by
 * exceeding it**", and the two existing tests prove different halves without
 * ever meeting:
 *
 *   - `slow-mode-policy` pins the policy as a pure function;
 *   - `slow-mode-budget-wiring` proves the reduced CONFIG reaches the limiter,
 *     with the storage round-trip stubbed — so it can show the right number is
 *     passed, and never that the number refuses anything;
 *   - `rate-limit-middleware` proves `enforceRateLimit` returns 429 once a
 *     budget is exhausted, for a budget it was handed directly.
 *
 * Compose those and the conclusion follows, and a conclusion that follows from
 * two tests is not a tested conclusion. So this drives the REAL in-memory
 * limiter through the REAL wrapper and counts requests until one is refused.
 *
 * **What that is worth, measured rather than assumed.** I first justified this
 * file by predicting that discarding `effectiveConfig` on the return would keep
 * the wiring test green; it does not — that mutation reddens both files, since
 * the wiring test reads the config handed to the store. The justification the
 * measurement actually supports is narrower and still sufficient:
 *
 *   - **the end-to-end number.** Only this file shows an established caller
 *     refused at 61 and a slow one at 16, rather than that the right constant
 *     was passed to something that was told to allow everything.
 *   - **the SHARED BUCKET**, which nothing else catches. Dropping the `-slow`
 *     scope suffix reddens exactly one test in the repo, here: a slow caller's
 *     spend would then deplete the full tier's budget for the same user, so
 *     verifying an email would hand someone a bucket already empty.
 *
 * ## The assertion is a DIFFERENCE, not a number
 *
 * It asserts that a slow-mode caller is refused strictly EARLIER than an
 * established one, rather than at request 16. A test pinned to 16 fails when
 * either preset is retuned — which is a decision somebody is allowed to make —
 * and would then be edited rather than read. The property that must not change
 * is that slow mode is tighter and that both still refuse.
 */
import { NextRequest } from 'next/server';

// ── Bypasses off, or the limiter never runs ──────────────────────────
//
// `RATE_LIMIT_ENABLED='1'` is REQUIRED, not merely "not 0": the fourth clause
// of `isRateLimitBypassed` bypasses whenever NODE_ENV === 'test' unless this is
// explicitly set. Without it every request below is allowed, and a test that
// counts requests-until-refusal would run to its own safety bound and report
// the bound as the limit.
beforeAll(() => {
    process.env.RATE_LIMIT_MODE = 'memory';
    delete process.env.AUTH_TEST_MODE;
    delete process.env.NEXT_TEST_MODE;
    process.env.RATE_LIMIT_ENABLED = '1';
});

const getToken = jest.fn();
jest.mock('next-auth/jwt', () => ({ getToken: (...a: unknown[]) => getToken(...a) }));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    log: jest.fn(),
}));

import { withApiErrorHandling } from '@/lib/errors/api';
import { clearAllRateLimits } from '@/lib/security/rate-limit';
import {
    API_MUTATION_LIMIT,
    SLOW_MODE_MUTATION_LIMIT,
} from '@/lib/security/rate-limit';

const DAY = 24 * 60 * 60 * 1000;

/**
 * A safety bound well above both presets, so a limiter that never refuses
 * terminates the loop instead of hanging — and reports a number the assertions
 * below reject rather than a timeout nobody can read.
 */
const SAFETY_BOUND = API_MUTATION_LIMIT.maxAttempts * 3;

const ok = async () => new Response('{}', { status: 200 });

/** Each caller gets its own IP so the buckets cannot collide. */
function post(ip: string): NextRequest {
    return new NextRequest('https://app.agrent.bg/api/t/acme/journal', {
        method: 'POST',
        headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
    });
}

/**
 * Drive the real wrapper until a request is refused, and return how many it
 * took. `null` means the safety bound was reached with no refusal.
 */
async function requestsUntilRefused(ip: string): Promise<number | null> {
    const handler = withApiErrorHandling(ok);
    for (let n = 1; n <= SAFETY_BOUND; n += 1) {
        const res = await handler(post(ip), { params: Promise.resolve({}) });
        if (res.status === 429) return n;
    }
    return null;
}

beforeEach(() => {
    getToken.mockReset();
    // The memory limiter is process-global, so one test's spent budget would
    // otherwise be another test's starting position.
    clearAllRateLimits();
});

describe('the slow-mode budget binds', () => {
    it('control: an ESTABLISHED account is refused, so the limiter is live', async () => {
        // Without this, "the slow caller was refused at 16" is equally
        // consistent with a limiter that refuses everyone immediately.
        getToken.mockResolvedValue({
            sub: 'usr_established',
            emailVerifiedAt: Date.now() - 400 * DAY,
            accountCreatedAt: Date.now() - 400 * DAY,
        });

        const n = await requestsUntilRefused('203.0.113.10');

        expect(n).not.toBeNull();
        expect(n).toBe(API_MUTATION_LIMIT.maxAttempts + 1);
    });

    it('a NEW account is refused, and strictly EARLIER', async () => {
        getToken.mockResolvedValue({
            sub: 'usr_new',
            emailVerifiedAt: Date.now() - DAY,
            accountCreatedAt: Date.now() - DAY,
        });

        const slow = await requestsUntilRefused('203.0.113.11');

        expect(slow).not.toBeNull();
        expect(slow).toBe(SLOW_MODE_MUTATION_LIMIT.maxAttempts + 1);
        // The property, stated as a difference so retuning either preset does
        // not make this test wrong — only a slow tier that stopped being
        // tighter would.
        expect(slow!).toBeLessThan(API_MUTATION_LIMIT.maxAttempts + 1);
    });

    it('an UNVERIFIED account is refused at the reduced budget too', async () => {
        // The other half of the OR, driven end to end rather than inferred
        // from the policy function.
        getToken.mockResolvedValue({
            sub: 'usr_unverified',
            emailVerifiedAt: null,
            accountCreatedAt: Date.now() - 400 * DAY,
        });

        const n = await requestsUntilRefused('203.0.113.12');

        expect(n).toBe(SLOW_MODE_MUTATION_LIMIT.maxAttempts + 1);
    });

    it('a PRE-P5.5a session keeps the full budget, end to end', async () => {
        // The deploy-day case, proven by exceeding rather than by reading a
        // config: a token with neither claim must get the full 60.
        getToken.mockResolvedValue({ sub: 'usr_old_session' });

        const n = await requestsUntilRefused('203.0.113.13');

        expect(n).toBe(API_MUTATION_LIMIT.maxAttempts + 1);
    });

    it('the two tiers do not share a bucket', async () => {
        // The scope suffix (`…-slow`) means a slow caller's spend cannot
        // deplete the normal tier's budget or vice versa. Same user id on
        // both, which is the only way the keys could collide.
        getToken.mockResolvedValue({
            sub: 'usr_same',
            emailVerifiedAt: Date.now() - DAY,
            accountCreatedAt: Date.now() - DAY,
        });
        const slowFirst = await requestsUntilRefused('203.0.113.14');
        expect(slowFirst).toBe(SLOW_MODE_MUTATION_LIMIT.maxAttempts + 1);

        // Now the SAME user id, established. A shared bucket would refuse
        // immediately because the slow runs above exhausted it.
        getToken.mockResolvedValue({
            sub: 'usr_same',
            emailVerifiedAt: Date.now() - 400 * DAY,
            accountCreatedAt: Date.now() - 400 * DAY,
        });
        const thenFull = await requestsUntilRefused('203.0.113.14');

        expect(thenFull).toBe(API_MUTATION_LIMIT.maxAttempts + 1);
    });
});

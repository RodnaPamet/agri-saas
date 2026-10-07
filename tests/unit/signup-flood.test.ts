/**
 * The bot flood: 100 signups a minute from rotating IPs (P3.10, last item).
 *
 * ## Why this is a jest test and not a load-test drill
 *
 * The roadmap asked for a flood from rotating IPs. The faithful version points
 * real traffic at infrastructure, and there is no staging environment — so the
 * owner's call was to run it locally against synthetic IPs. Given that, a
 * harness that drives the real route handler beats a k6 script for the reason
 * this repo has already learned twice: a load script no workflow invokes is
 * inert, and the question here is not "how fast" but "is the flood stopped",
 * which is decided entirely by logic this can execute.
 *
 * What it does NOT cover, said plainly: the Edge middleware, real bcrypt cost
 * under parallel load, and connection-pool behaviour. Those want a real HTTP
 * flood against a real server, and `docs/runbooks/signup-flood-drill.md`
 * records how to do that when somebody wants it.
 *
 * ## Rotating the IP is faithful BECAUSE production pins it
 *
 * `getClientIp` reads `x-forwarded-for` and takes the first entry, so here the
 * header is the knob. That is not a production vulnerability: the live Caddy
 * site block has `header_up X-Forwarded-For {remote_host}`, which REPLACES the
 * field with the real peer address rather than appending to it, so a client
 * cannot choose its own bucket. Setting the header locally therefore simulates
 * an attacker holding many real addresses — which is the threat the roadmap
 * named — rather than a header-spoofing bug.
 *
 * If that Caddy directive ever changes to an append, this test's premise
 * inverts and a single host could spoof its way to unlimited buckets. That is
 * the thing to re-check before trusting the per-IP tier.
 *
 * ## The experiment, and why phase 1 is load-bearing
 *
 * Rate limiting is BYPASSED under `NODE_ENV=test` unless `RATE_LIMIT_ENABLED=1`
 * (`rate-limit-middleware.ts`). So the opt-in is set below — and phase 1 is how
 * we know it took. A bypassed limiter makes every phase report "nothing was
 * stopped", which is indistinguishable from the finding. Phase 1 fires the same
 * flood from ONE address and must show refusals; if it does not, the instrument
 * is off and every other number here is void.
 */
const FIXED_IP_BASE = 203;

process.env.RATE_LIMIT_ENABLED = '1';
process.env.RATE_LIMIT_MODE = 'memory';

const mockUserFindFirst = jest.fn();
const mockUserCreate = jest.fn();
const mockUserUpdate = jest.fn();
const mockUserUpdateMany = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            findFirst: (...a: unknown[]) => mockUserFindFirst(...a),
            create: (...a: unknown[]) => mockUserCreate(...a),
            update: (...a: unknown[]) => mockUserUpdate(...a),
            updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
        },
    },
}));

jest.mock('@/lib/security/password-check', () => ({
    __esModule: true,
    checkPasswordAgainstHIBP: jest.fn(async () => ({ breached: false })),
}));

jest.mock('@/lib/auth/passwords', () => ({
    __esModule: true,
    hashPassword: jest.fn(async () => 'hashed-pw'),
    validatePasswordPolicy: jest.fn(() => ({ ok: true })),
}));

jest.mock('@/lib/auth/email-verification-code', () => ({
    __esModule: true,
    issueEmailVerificationCode: jest.fn(async () => '048212'),
    normaliseEmail: (e: string) => (e ?? '').trim().toLowerCase(),
    CODE_LENGTH: 6,
}));

jest.mock('@/lib/auth/registration-emails', () => ({
    __esModule: true,
    sendVerificationCodeEmail: jest.fn(async () => undefined),
    sendAlreadyRegisteredEmail: jest.fn(async () => undefined),
}));

/**
 * Turnstile is NOT mocked out. It is the control under test, and it decides
 * what it does from `process.env.TURNSTILE_SECRET_KEY` at call time — unset
 * returns `{ ok: true, skipped: true }`. What IS stubbed, per phase, is the
 * siteverify HTTP call, standing in for Cloudflare's documented always-pass
 * and always-fail test secrets.
 */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/register/start/route';
import { TERMS_VERSION } from '@/lib/legal/terms';

const ATTEMPTS = 100;

interface Outcome {
    created: number;
    refused429: number;
    refused400: number;
    other: number;
}

async function flood(opts: {
    ip: (i: number) => string;
    turnstileToken?: string;
    label?: string;
}): Promise<Outcome> {
    const out: Outcome = { created: 0, refused429: 0, refused400: 0, other: 0 };
    const label = opts.label ?? 'flood';
    for (let i = 0; i < ATTEMPTS; i++) {
        const req = new NextRequest('http://localhost/api/auth/register/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-forwarded-for': opts.ip(i),
            },
            body: JSON.stringify({
                email: `flood-${i}-${Math.random().toString(36).slice(2)}@example.bg`,
                password: 'correct horse battery staple',
                name: 'Bot',
                acceptedTerms: true,
                termsVersion: TERMS_VERSION,
                ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
            }),
        });
        const res = await POST(req as never, {} as never);
        if (res.status === 200) out.created += 1;
        else if (res.status === 429) out.refused429 += 1;
        else if (res.status === 400) out.refused400 += 1;
        else out.other += 1;
    }
    // PRINT THE MEASUREMENT. The assertions below are ranges, deliberately —
    // pinning "exactly 15 landed" would make this redden on a limit change
    // that is not a regression. But a range assertion hides the number, and
    // the number is the finding, so the run reports it.
    //
    // eslint-disable-next-line no-console -- this test's output IS its result
    console.log(
        `[signup-flood] ${label.padEnd(26)} attempts=${ATTEMPTS} ` +
            `created=${out.created} refused429=${out.refused429} ` +
            `refused400=${out.refused400} other=${out.other}`,
    );
    return out;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindFirst.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'u1', uiLanguage: 'bg' });
    delete process.env.TURNSTILE_SECRET_KEY;
});

describe('phase 1 — the instrument: one address is stopped', () => {
    it(`${ATTEMPTS} attempts from a single IP exhaust SIGNUP_LIMIT`, async () => {
        // A distinct address per run, because the in-memory bucket survives
        // within the process and a re-run would otherwise start exhausted.
        const ip = `${FIXED_IP_BASE}.0.113.${Math.floor(Math.random() * 200) + 1}`;
        const out = await flood({ ip: () => ip, label: 'single IP' });

        // SIGNUP_LIMIT is 15/hour. The exact figure is not the assertion — the
        // assertion is that MOST of the flood was refused, which is only true
        // if the limiter is actually running.
        expect(out.refused429).toBeGreaterThan(ATTEMPTS / 2);
        expect(out.created).toBeLessThan(ATTEMPTS / 2);

        // If this fails, RATE_LIMIT_ENABLED did not take and every number in
        // phase 2 and 3 is meaningless rather than merely unflattering.
        expect(out.refused429).toBeGreaterThan(0);
    });
});

describe('phase 2 — the finding: rotating addresses are not stopped', () => {
    it(`${ATTEMPTS} attempts from ${ATTEMPTS} distinct IPs all land`, async () => {
        const out = await flood({
            ip: (i) => `198.51.100.${(i % 254) + 1}`,
            label: 'rotating IPs, no screen',
        });

        // This is the roadmap's question, answered: the per-IP tier is keyed on
        // the address, so an attacker holding many addresses gets a fresh
        // budget with each one. Nothing else in the signup path stops them
        // while Turnstile is dormant — the disposable-domain list only catches
        // listed domains, and a bot can send `acceptedTerms: true` as easily
        // as a person can tick a box.
        expect(out.created).toBe(ATTEMPTS);
        expect(out.refused429).toBe(0);

        // Stated as an expectation so it reads as a measured property rather
        // than a worry: every one of those is a real unverified User row.
        expect(mockUserCreate).toHaveBeenCalledTimes(ATTEMPTS);
    });
});

describe('phase 3 — the control that closes it', () => {
    /** Stand in for Cloudflare siteverify. */
    function stubSiteverify(success: boolean) {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                success,
                'error-codes': success ? [] : ['invalid-input-response'],
            }),
        })) as unknown as typeof fetch;
    }

    it('with a secret configured and verification failing, nothing lands', async () => {
        // Equivalent to Cloudflare's always-fail test secret
        // (2x0000000000000000000000000000000AA).
        process.env.TURNSTILE_SECRET_KEY = 'test-secret-always-fails';
        stubSiteverify(false);

        const out = await flood({
            ip: (i) => `198.51.100.${(i % 254) + 1}`,
            turnstileToken: 'a-token',
            label: 'rotating + screen fails',
        });

        // Rotating addresses do not help: the screen is on the REQUEST, not
        // the address. This is what the owner's Turnstile keys buy.
        expect(out.created).toBe(0);
        expect(out.refused400).toBe(ATTEMPTS);
        expect(mockUserCreate).not.toHaveBeenCalled();
    });

    it('…and with verification passing, a signup still works — the control', async () => {
        // Equivalent to the always-pass test secret
        // (1x0000000000000000000000000000000AA). Without this, "nothing lands"
        // above is equally satisfied by a gate that refuses everybody, which
        // would be a broken signup rather than a working defence.
        process.env.TURNSTILE_SECRET_KEY = 'test-secret-always-passes';
        stubSiteverify(true);

        const req = new NextRequest('http://localhost/api/auth/register/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-forwarded-for': '192.0.2.77',
            },
            body: JSON.stringify({
                email: 'real-person@example.bg',
                password: 'correct horse battery staple',
                name: 'Иван',
                acceptedTerms: true,
                termsVersion: TERMS_VERSION,
                turnstileToken: 'a-token',
            }),
        });
        const res = await POST(req as never, {} as never);
        expect(res.status).toBe(200);
        expect(mockUserCreate).toHaveBeenCalledTimes(1);
    });

    it('a missing token is refused once a secret is configured, never skipped', async () => {
        // The dormant/active distinction has to be decided by the SECRET, not
        // by whether the client bothered to send anything.
        process.env.TURNSTILE_SECRET_KEY = 'test-secret-always-passes';
        stubSiteverify(true);

        const out = await flood({
            ip: (i) => `198.51.100.${(i % 254) + 1}`,
            label: 'rotating + no token',
        });
        expect(out.created).toBe(0);
        expect(out.refused400).toBe(ATTEMPTS);
    });
});

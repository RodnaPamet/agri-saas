/**
 * #1669 — the platform console's reachability is REPORTED, with all four states.
 *
 * ## Why this needed a test rather than a glance
 *
 * The capability exists because a fail-closed gate produces no signal, and the
 * failure mode of a signal is that it is wrong in a way nobody checks. Two
 * directions matter equally here:
 *
 *   - **a miss** — reporting `reachable` when the console is not, which is the
 *     stale reassurance the whole report exists to prevent;
 *   - **a false alarm** — reporting `misconfigured` during a database incident,
 *     which would have an operator chasing a config problem that does not
 *     exist while the real signal (the database check) is right beside it.
 *
 * `a-finding-wants-both-questions`. The `unknown` state is the second one, and
 * it is the case a simpler implementation would have collapsed.
 */
const findUnique = jest.fn();

/**
 * A stub client, PASSED rather than mocked at the module level.
 *
 * The capability takes its reader as a parameter precisely so that importing
 * it cannot pull `@/lib/prisma` — and `Prisma.dmmf` — into a caller's module
 * graph. Mocking `@/lib/prisma` here would test a dependency the function
 * deliberately does not have.
 */
const db = { tenant: { findUnique: (...a: unknown[]) => findUnique(...a) } } as never;

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * `env` is a Proxy with ZERO own keys, so spreading it yields an EMPTY env and
 * every variable reads `undefined` — measured, and it is how a previous mock of
 * this module sent Prisma to port 5432. Forward everything and override one key.
 */
let slug: string | undefined;
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env');
    return {
        env: new Proxy(actual.env, {
            get: (target, prop) =>
                prop === 'PLATFORM_TENANT_SLUG' ? slug : Reflect.get(target, prop),
        }),
    };
});

import { platformConsoleCapability } from '@/lib/auth/platform-console-capability';

beforeEach(() => {
    slug = undefined;
    findUnique.mockReset();
    findUnique.mockResolvedValue({ id: 't1', deletedAt: null });
});

describe('unconfigured — the legitimate common state', () => {
    it('reports unconfigured when the var is absent, and asks no question', async () => {
        expect(await platformConsoleCapability(db)).toEqual({ state: 'unconfigured' });
        // A self-hosted deployment has no platform tenant and wants none, so
        // this must not cost a query either.
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('treats whitespace as absent, matching isPlatformTenant', async () => {
        slug = '   ';

        expect(await platformConsoleCapability(db)).toEqual({ state: 'unconfigured' });
        expect(findUnique).not.toHaveBeenCalled();
    });
});

describe('reachable', () => {
    it('reports reachable when the slug resolves to a live tenant', async () => {
        slug = 'agrent-platform';

        expect(await platformConsoleCapability(db)).toEqual({ state: 'reachable' });
        expect(findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { slug: 'agrent-platform' } }),
        );
    });

    it('trims the slug before looking it up', async () => {
        slug = '  agrent-platform  ';

        await platformConsoleCapability(db);

        expect(findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { slug: 'agrent-platform' } }),
        );
    });
});

describe('misconfigured — the state the gate cannot distinguish', () => {
    it('a slug naming no tenant is misconfigured, not unconfigured', async () => {
        // THE POINT OF THE WHOLE REPORT. Through `assertPlatformSupport` a
        // typo'd slug fails exactly like an absent one, so an operator cannot
        // tell "I have not set this up" from "I set it up wrong".
        slug = 'typo-platfrom';
        findUnique.mockResolvedValue(null);

        expect(await platformConsoleCapability(db)).toEqual({ state: 'misconfigured' });
    });

    it('a SOFT-DELETED tenant is misconfigured — which the gate would admit', async () => {
        // `isPlatformTenant` compares slugs and nothing else, so a removed
        // platform tenant still opens the gate while being invisible to every
        // other consumer (#1389 filters `deletedAt: null` everywhere else).
        // Reporting `reachable` there would be a stale reassurance.
        slug = 'agrent-platform';
        findUnique.mockResolvedValue({ id: 't1', deletedAt: new Date() });

        expect(await platformConsoleCapability(db)).toEqual({ state: 'misconfigured' });
    });
});

describe('unknown — the false-alarm guard', () => {
    it('an unreadable database is unknown, NEVER misconfigured', async () => {
        // THE MUTATION TARGET. Collapsing this into `misconfigured` would make
        // every probe during a database incident report a configuration fault
        // that does not exist — six regions, every 60s, while the actual signal
        // sits in `checks.database` beside it.
        slug = 'agrent-platform';
        findUnique.mockRejectedValue(new Error('too many connections'));

        expect(await platformConsoleCapability(db)).toEqual({ state: 'unknown' });
    });

    it('does not throw — a capability report must never 503 the probe', async () => {
        slug = 'agrent-platform';
        findUnique.mockRejectedValue(new Error('connection reset'));

        await expect(platformConsoleCapability(db)).resolves.toBeDefined();
    });
});

describe('it never leaks the slug', () => {
    it('the result carries a closed enum and nothing else', async () => {
        slug = 'secret-looking-slug';
        findUnique.mockResolvedValue({ id: 't1', deletedAt: null });

        const result = await platformConsoleCapability(db);

        // Same rule as `basemap`'s branch and `email`'s provider: the operator
        // who needs the value already has the env, and this response is served
        // to an unauthenticated prober.
        expect(JSON.stringify(result)).not.toContain('secret-looking-slug');
        expect(Object.keys(result)).toEqual(['state']);
    });
});

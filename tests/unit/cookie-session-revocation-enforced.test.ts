/**
 * #3200 — a revoked web cookie session is refused in NODE, by `auth()`.
 *
 * The `jwt` callback sets `error: 'SessionRevoked'` when the session row is
 * revoked or `sessionVersion` moved. In the App Router a one-argument
 * `getServerSession` discards the rewritten cookie, and the Edge reads the
 * cookie as it stands — so the flag was computed and thrown away on every
 * request and a revoked cookie kept working until the JWT expired.
 *
 * `tests/unit/session-revocation-enforced.test.ts` feeds the Edge a token with
 * the flag ALREADY set, which production never produces for a cookie. This
 * suite drives the REAL `jwt` → `session` callbacks through a stand-in for
 * `getServerSession` that does what next-auth does (decode → jwt → session),
 * so the flag has to survive the actual chain to be refused.
 */
const userFindUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { user: { findUnique: (...a: unknown[]) => userFindUnique(...a), findFirst: (...a: unknown[]) => userFindUnique(...a) } },
}));

// The cookie the browser presents; each test sets it.
let cookieToken: Record<string, unknown> | null = null;
jest.mock('next-auth', () => {
    const actual = jest.requireActual('next-auth');
    return {
        ...actual,
        getServerSession: async (opts: {
            callbacks: {
                jwt: (a: unknown) => Promise<Record<string, unknown>>;
                session: (a: unknown) => Promise<unknown>;
            };
        }) => {
            if (!cookieToken) return null;
            const token = await opts.callbacks.jwt({ token: { ...cookieToken } });
            return opts.callbacks.session({ session: { user: {}, expires: '' }, token });
        },
    };
});

const resolveBearerSession = jest.fn();
jest.mock('@/lib/auth/native/bearer-principal', () => ({
    resolveBearerSession: () => resolveBearerSession(),
}));

import { auth } from '@/auth';

const COOKIE = {
    email: 'farmer@example.test',
    userId: 'user-1',
    sub: 'user-1',
    role: 'OWNER',
    sessionVersion: 1,
    memberships: [{ slug: 'farm', role: 'OWNER', tenantId: 't1' }],
};

beforeEach(() => {
    userFindUnique.mockReset();
    resolveBearerSession.mockReset();
    resolveBearerSession.mockResolvedValue(null);
    cookieToken = null;
});

describe('auth() refuses a revoked cookie session (#3200)', () => {
    it('returns NO session once sessionVersion has moved past the cookie (password change, revoke-all)', async () => {
        cookieToken = COOKIE;
        userFindUnique.mockResolvedValue({ sessionVersion: 2 });

        await expect(auth()).resolves.toBeNull();
    });

    it('falls through to a live native bearer on the same request', async () => {
        cookieToken = COOKIE;
        userFindUnique.mockResolvedValue({ sessionVersion: 2 });
        const bearer = { user: { id: 'user-1' }, expires: '' };
        resolveBearerSession.mockResolvedValue(bearer);

        await expect(auth()).resolves.toBe(bearer);
    });

    it('control: the SAME cookie with an unchanged sessionVersion is a session', async () => {
        // Without this, an auth() that refused every cookie would pass both cases above.
        cookieToken = COOKIE;
        userFindUnique.mockResolvedValue({ sessionVersion: 1 });

        const session = await auth();

        expect(session?.user.id).toBe('user-1');
        expect(session?.error).toBeUndefined();
    });
});

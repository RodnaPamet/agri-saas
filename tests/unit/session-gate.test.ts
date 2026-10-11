/**
 * `@/lib/auth/session-gate` — the two doors, and `/api/auth/me` (#1652).
 *
 * The gate exists because P5.9's suspension check sat in `getSessionOrThrow`,
 * which ten API routes never called. `tests/guards/api-routes-resolve-sessions-
 * through-the-gate.test.ts` holds the raw-`auth()` count at zero;
 * `tests/unit/suspension-gate-covers-the-invite-routes.test.ts` holds the
 * owner-ruled invite behaviour. This file holds the doors themselves, plus the
 * one route whose breakage was REPORTED rather than inferred.
 *
 * ## `/api/auth/me` is NOT here, and the reason is worth recording
 *
 * It was, briefly. The agrent-ios report is about that route:
 * `ACCOUNT_TERMINATED` both suspends the account and starts the 30-day erasure
 * clock, so a terminated person would sign in, be handed `deletion` by `/me`,
 * be shown «Възстанови профила», and have the cancel refused 403 by
 * `/api/account/deletion`, which DOES check — a recovery screen offering an
 * action the server would never honour.
 *
 * #1652 says it is "fixed in #1619's branch". When I started, that was false:
 * #1619 was open, no such branch existed on the remote, and main's route used a
 * raw `auth()`. It became true mid-change — #1654 landed it from the parallel
 * session, refusing INLINE off the `User` row the route already queries. That
 * is cheaper than this gate for this one route and I reverted my version to it,
 * so the route is in the guard's allowlist as a `selfChecks` entry and its
 * behaviour is covered by `tests/unit/auth-me-deletion-pending.test.ts`.
 *
 * Nine routes migrated, not ten.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const isAccountSuspended = jest.fn();
jest.mock('@/lib/auth/suspension', () => ({
    // Real module spread first — a partial barrel mock turns every other
    // export into `undefined`.
    ...jest.requireActual('@/lib/auth/suspension'),
    isAccountSuspended: (userId: string) => isAccountSuspended(userId),
}));

import { authRefusingSuspended, authWithSuspension } from '@/lib/auth/session-gate';

const SESSION = { user: { id: 'u-1', email: 'farmer@example.com' } };

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockResolvedValue(SESSION);
    isAccountSuspended.mockResolvedValue(false);
});

describe('authRefusingSuspended', () => {
    it('returns the session unchanged for an active account', () => {
        return expect(authRefusingSuspended()).resolves.toEqual(SESSION);
    });

    it('throws ACCOUNT_SUSPENDED — the same code getSessionOrThrow answers', async () => {
        // The code AND the message, because two gates answering one condition
        // in two shapes is #1645, three days old at the time of writing.
        isAccountSuspended.mockResolvedValue(true);
        await expect(authRefusingSuspended()).rejects.toMatchObject({
            status: 403,
            code: 'ACCOUNT_SUSPENDED',
            message: 'ACCOUNT_SUSPENDED',
        });
    });

    it('returns null rather than throwing when there is no session', async () => {
        // Load-bearing. These routes answer an absent session in four
        // different shapes — `{ error: 'Unauthorized' }`,
        // `{ error: 'unauthenticated' }`, `{ error: { code: … } }` and a 302 to
        // /login — and those are published contracts with installed clients
        // behind them. A gate that threw for both refusals would collapse four
        // into one, which is a breaking change riding inside a security fix.
        auth.mockResolvedValue(null);
        await expect(authRefusingSuspended()).resolves.toBeNull();
    });

    it('does not ask about a user who is not there', async () => {
        // Not only waste: `isAccountSuspended(undefined)` would be a question
        // about nobody, and whatever it answered would be acted on.
        auth.mockResolvedValue(null);
        await authRefusingSuspended();
        expect(isAccountSuspended).not.toHaveBeenCalled();
    });

    it('asks about the SESSION user, not some other id', async () => {
        auth.mockResolvedValue({ user: { id: 'u-9', email: 'x@y.z' } });
        await authRefusingSuspended();
        expect(isAccountSuspended).toHaveBeenCalledWith('u-9');
    });
});

describe('authWithSuspension', () => {
    it('reports the verdict without throwing', async () => {
        isAccountSuspended.mockResolvedValue(true);
        await expect(authWithSuspension()).resolves.toEqual({
            session: SESSION,
            suspended: true,
        });
    });

    it('reports NOT suspended for an absent session', async () => {
        // "Nobody is suspended" is the honest answer about an absent user, and
        // every caller's unauthenticated branch runs first regardless.
        auth.mockResolvedValue(null);
        await expect(authWithSuspension()).resolves.toEqual({
            session: null,
            suspended: false,
        });
    });
});

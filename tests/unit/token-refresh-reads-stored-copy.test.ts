/**
 * The OAuth refresh decision reads the STORED row, not just the cookie — #1963.
 *
 * ## The production symptom this reproduces
 *
 * Measured 2026-10-16: every authenticated request performed a live `POST
 * https://oauth2.googleapis.com/token`. The `agrent-app` container was 11
 * minutes old and its whole message histogram read 17 "request started", 17
 * "request completed", 17 "Refreshing Google access token" — 1:1, from two
 * background pollers on one idle open tab. A Google access token lasts
 * ~3600s, so the expected rate is about one refresh per hour per session.
 *
 * What the ratio proves is narrow but sufficient: the expiry written by one
 * request is not visible to the next. `isTokenExpired` is correct and is
 * consulted — it keeps seeing the old value, because the gate reads
 * `token.expiresAt` from the JWT cookie and a `jwt` callback invoked through
 * `auth()` in a route handler does not reissue that cookie. The branch then
 * wrote fresh values to the `Account` row, which nothing read back.
 *
 * So the test that matters is `two consecutive calls with the SAME stale
 * token`: that is the production scenario exactly, and it is what fails
 * against the old code.
 *
 * ## Scope
 *
 * Web cookie sessions only. The iOS bearer path cannot reach this branch —
 * `buildSessionClaims` never sets `provider`, `expiresAt`, `refreshToken` or
 * `accessToken`, so the condition is false for every phone bearer. Confirmed
 * against `main` at d269f06 by the agrent-ios session.
 *
 * `isTokenExpired` is deliberately NOT mocked. It is pure, it is correct, and
 * mocking it would leave the suite unable to tell a real expiry decision from
 * a stubbed one.
 */
const accountFindFirst = jest.fn();
const accountUpdateMany = jest.fn();
const refreshAccessTokenMock = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        account: {
            findFirst: (...a: unknown[]) => accountFindFirst(...a),
            updateMany: (...a: unknown[]) => accountUpdateMany(...a),
        },
        user: { findFirst: jest.fn(), findUnique: jest.fn() },
    },
}));

jest.mock('@/lib/auth/refresh', () => {
    // Factory-local require: a top-level import would be hoisted ABOVE this
    // factory, so the real module has to be reached from inside it.
    const actual = jest.requireActual('@/lib/auth/refresh') as typeof import('@/lib/auth/refresh');
    return {
        ...actual,
        refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a),
    };
});

import { authOptions } from '@/auth';

type JwtCb = NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>;
const jwtCallback = authOptions.callbacks!.jwt as JwtCb;

const nowSec = () => Math.floor(Date.now() / 1000);
/** Past the 60s skew in `isTokenExpired`, so the gate opens. */
const EXPIRED = () => nowSec() - 100;
/** Comfortably inside it. */
const FRESH = () => nowSec() + 3600;

const staleCookieToken = () => ({
    userId: 'user-1',
    email: 'owner@example.com',
    provider: 'google',
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: EXPIRED(),
});

// NextAuth's jwt callback params type is not exported, and the real callback
// reads only `token` on this path; typing the other fields would mean
// restating an internal shape that the library can change under us.
//
// #1471 — the directive below used to sit ABOVE this prose. `-next-line`
// applies to the immediately following line, so it pointed at a comment and
// the `as any` four lines down stayed unsuppressed: eslint reported the
// directive as unused AND reported the rule it named. A wrapped reason
// displaced the directive it belonged to. The reason stays here as prose and
// the directive goes on the line it governs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
const callJwt = (token: Record<string, unknown>) => jwtCallback({ token } as any);

describe('the jwt callback OAuth refresh', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        accountUpdateMany.mockResolvedValue({ count: 1 });
        refreshAccessTokenMock.mockResolvedValue({
            accessToken: 'at-new',
            expiresAt: FRESH(),
            refreshToken: undefined,
        });
    });

    it('does NOT call the provider when the stored row is still valid', async () => {
        // The whole bug in one assertion: the cookie says expired, the
        // database says otherwise, and the database is the authoritative copy.
        accountFindFirst.mockResolvedValue({
            access_token: 'at-stored',
            refresh_token: 'rt-stored',
            expires_at: FRESH(),
        });

        const out = (await callJwt(staleCookieToken())) as Record<string, unknown>;

        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
        expect(out.accessToken).toBe('at-stored');
        expect(out.refreshToken).toBe('rt-stored');
        expect(out.expiresAt).toBeGreaterThan(nowSec());
    });

    it('calls the provider exactly ONCE across two requests carrying the same stale token', async () => {
        // THE regression test — the production scenario. The cookie is never
        // reissued, so request two presents byte-identical claims to request
        // one. The stored row is what has moved on.
        //
        // The double is stateful on purpose: a fixture that returned a fresh
        // row from the start could not tell "adopted the stored copy" from
        // "never needed to refresh at all".
        let storedExpiry = EXPIRED();
        let storedAccess = 'at-old';
        accountFindFirst.mockImplementation(async () => ({
            access_token: storedAccess,
            refresh_token: 'rt-old',
            expires_at: storedExpiry,
        }));
        accountUpdateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
            storedExpiry = args.data.expires_at as number;
            storedAccess = args.data.access_token as string;
            return { count: 1 };
        });

        const first = (await callJwt(staleCookieToken())) as Record<string, unknown>;
        const second = (await callJwt(staleCookieToken())) as Record<string, unknown>;

        expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
        expect(accountUpdateMany).toHaveBeenCalledTimes(1);
        // Both requests end up holding a usable token — the second by
        // adopting what the first stored, not by redeeming the refresh token
        // again. Google may invalidate a refresh token redeemed abusively.
        expect(first.accessToken).toBe('at-new');
        expect(second.accessToken).toBe('at-new');
    });

    it('DOES call the provider when the stored row is expired too', async () => {
        // The gate must still open when nothing has refreshed recently,
        // otherwise this "fix" is an outage: tokens would never renew and the
        // suite above would still be green.
        accountFindFirst.mockResolvedValue({
            access_token: 'at-old',
            refresh_token: 'rt-old',
            expires_at: EXPIRED(),
        });

        const out = (await callJwt(staleCookieToken())) as Record<string, unknown>;

        expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
        expect(out.accessToken).toBe('at-new');
        expect(accountUpdateMany).toHaveBeenCalledTimes(1);
    });

    it('DOES call the provider when there is no stored row at all', async () => {
        // Preserves the prior behaviour for an account row that is missing or
        // whose `expires_at` is null, rather than silently declining to
        // refresh.
        accountFindFirst.mockResolvedValue(null);

        await callJwt(staleCookieToken());

        expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    });

    it('treats a stored row with a null expiry as unusable, not as valid', async () => {
        accountFindFirst.mockResolvedValue({
            access_token: 'at-stored',
            refresh_token: 'rt-stored',
            expires_at: null,
        });

        await callJwt(staleCookieToken());

        expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    });

    it('still flags re-auth when the provider refresh fails', async () => {
        accountFindFirst.mockResolvedValue({
            access_token: 'at-old',
            refresh_token: 'rt-old',
            expires_at: EXPIRED(),
        });
        refreshAccessTokenMock.mockRejectedValue(new Error('invalid_grant'));

        const out = (await callJwt(staleCookieToken())) as Record<string, unknown>;

        expect(out.error).toBe('RefreshTokenError');
    });

    it('does not touch the provider or the row when the cookie token is still fresh', async () => {
        // The gate itself, unchanged: a valid token must not read the database
        // on every request either.
        const out = (await callJwt({ ...staleCookieToken(), expiresAt: FRESH() })) as Record<
            string,
            unknown
        >;

        expect(accountFindFirst).not.toHaveBeenCalled();
        expect(refreshAccessTokenMock).not.toHaveBeenCalled();
        expect(out.accessToken).toBe('at-old');
    });
});

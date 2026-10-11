/**
 * The ticket's attempt arithmetic.
 *
 * A `SESSION` code is 32 random bytes and needs no attempt limit — guessing
 * it is not a strategy. A ticket's second factor is SIX DIGITS, so without a
 * cap a ticket is a brute-force oracle with a five-minute window. The cap
 * lives on the TICKET rather than on an IP or a user because it bounds one
 * sign-in attempt and cannot be sidestepped by reconnecting.
 *
 * Mocked here, unlike `tests/integration/native-mfa-ticket.test.ts`, and the
 * split is deliberate. The integration file proves the properties that never
 * reach a TOTP check — purpose isolation both ways, PKCE, expiry, the TTLs —
 * against a real database, because those are enforced by a WHERE clause that
 * a mocked prisma would simply agree with. This file proves the counting,
 * which needs a TOTP verdict the test controls: `verifyTotpCode`'s generator
 * is not exported, so a valid code cannot be produced here without
 * reimplementing the algorithm, and a self-authored double of an algorithm
 * only validates the double.
 */
const findFirst = jest.fn();
const updateMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { nativeAuthCode: { findFirst, updateMany } },
    prisma: { nativeAuthCode: { findFirst, updateMany } },
}));

jest.mock('@/lib/db-context', () => ({
    asSystem: (fn: () => unknown) => fn(),
    runInTenantContext: jest.fn(),
}));

jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual<Record<string, unknown>>('@/lib/observability/logger'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const verifyMfaChallenge = jest.fn();
jest.mock('@/app-layer/usecases/mfa-challenge', () => ({
    verifyMfaChallenge: (...a: unknown[]) => verifyMfaChallenge(...a),
}));

import { redeemMfaTicket, MAX_MFA_TICKET_ATTEMPTS, deriveChallenge } from '@/lib/auth/native/auth-codes';

const VERIFIER = 'a-verifier-long-enough-to-be-plausible-0123456789';

/** A live ticket row with `attempts` wrong codes already spent. */
const ticketRow = (attempts: number) => ({
    id: 'code-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    codeChallenge: deriveChallenge(VERIFIER),
    expiresAt: new Date(Date.now() + 300_000),
    consumedAt: null,
    mfaAttempts: attempts,
    session: { revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) },
});

beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
});

describe('a wrong code costs one attempt and says how many are left', () => {
    it.each([
        [0, MAX_MFA_TICKET_ATTEMPTS - 1],
        [1, MAX_MFA_TICKET_ATTEMPTS - 2],
        [3, MAX_MFA_TICKET_ATTEMPTS - 4],
    ])('with %i spent, reports %i remaining', async (spent, expected) => {
        findFirst.mockResolvedValue(ticketRow(spent));
        verifyMfaChallenge.mockResolvedValue({ success: false, message: 'nope' });

        const r = await redeemMfaTicket({
            rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '000000',
        });

        expect(r).toEqual({ ok: false, reason: 'code_invalid', attemptsRemaining: expected });
    });

    it('does NOT consume the ticket while tries remain', async () => {
        findFirst.mockResolvedValue(ticketRow(0));
        verifyMfaChallenge.mockResolvedValue({ success: false, message: 'nope' });

        await redeemMfaTicket({ rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '000000' });

        const write = updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(write.data.mfaAttempts).toBe(1);
        // The person is mid-task. Burning the ticket on a typo would send
        // them back to the Apple button for a mistake they can fix.
        expect(write.data).not.toHaveProperty('consumedAt');
    });
});

describe('the final miss', () => {
    it('reports 0 remaining AND burns the ticket in the same write', async () => {
        findFirst.mockResolvedValue(ticketRow(MAX_MFA_TICKET_ATTEMPTS - 1));
        verifyMfaChallenge.mockResolvedValue({ success: false, message: 'nope' });

        const r = await redeemMfaTicket({
            rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '000000',
        });

        expect(r).toEqual({ ok: false, reason: 'code_invalid', attemptsRemaining: 0 });
        const write = updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
        // One write, not two. agrent-ios asked for `attemptsRemaining: 0` in
        // THIS response so the app can say "too many wrong codes, sign in
        // again" without a sixth request that would have to fail differently
        // to convey it.
        expect(write.data.consumedAt).toBeInstanceOf(Date);
        expect(updateMany).toHaveBeenCalledTimes(1);
    });

    it('never reports a negative number', async () => {
        // Defensive: a row whose counter is already past the cap (a racing
        // double-submit, or a hand-edited row) must not produce
        // `attemptsRemaining: -1`, which a client would render as nonsense.
        findFirst.mockResolvedValue(ticketRow(MAX_MFA_TICKET_ATTEMPTS + 3));
        verifyMfaChallenge.mockResolvedValue({ success: false, message: 'nope' });

        const r = await redeemMfaTicket({
            rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '000000',
        });

        expect(r).toEqual({ ok: false, reason: 'code_invalid', attemptsRemaining: 0 });
    });
});

describe('a correct code', () => {
    it('claims the ticket atomically and returns the session', async () => {
        findFirst.mockResolvedValue(ticketRow(2));
        verifyMfaChallenge.mockResolvedValue({ success: true, message: 'ok' });

        const r = await redeemMfaTicket({
            rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '654321',
        });

        // IDENTITY only — no session row. Returning one would mean a row
        // existed before the code was verified, which is the eviction this
        // shape exists to prevent: `recordNewSession` enforces
        // `maxConcurrentSessions`, so a ticket that wrote a session let
        // somebody holding only a stolen first factor evict the real
        // person's live sessions without ever knowing a code. The route
        // records the session after this returns.
        expect(r).toEqual({ ok: true, userId: 'user-1', tenantId: 'tenant-1' });
        expect(r).not.toHaveProperty('userSessionRowId');
        // The same claim shape the session exchange uses: the winner is
        // whoever moves `consumedAt` off null, so two concurrent correct
        // codes mint one pair rather than two.
        const write = updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
        expect(write.where).toEqual({ id: 'code-1', consumedAt: null });
    });

    it('loses the race rather than minting twice', async () => {
        findFirst.mockResolvedValue(ticketRow(0));
        verifyMfaChallenge.mockResolvedValue({ success: true, message: 'ok' });
        updateMany.mockResolvedValue({ count: 0 });

        const r = await redeemMfaTicket({
            rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '654321',
        });

        expect(r).toEqual({ ok: false, reason: 'ticket_invalid' });
    });

    it('passes the REMAINING allowance to the challenge, not the cap', async () => {
        // The web challenge takes `remaining` and words its own message from
        // it. Handing it the cap every time would tell a person on their
        // fourth try that they have five left.
        findFirst.mockResolvedValue(ticketRow(3));
        verifyMfaChallenge.mockResolvedValue({ success: true, message: 'ok' });

        await redeemMfaTicket({ rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '654321' });

        expect(verifyMfaChallenge).toHaveBeenCalledWith(
            'user-1', 'tenant-1', '654321', MAX_MFA_TICKET_ATTEMPTS - 3,
        );
    });
});

describe('a tenantless ticket is refused', () => {
    it('cannot be verified against any policy', async () => {
        // A ticket is only issued for a tenant whose policy requires a
        // factor, so a tenantless one is incoherent — and `verifyMfaChallenge`
        // needs a tenant to find the enrolment under.
        findFirst.mockResolvedValue({ ...ticketRow(0), tenantId: null });

        const r = await redeemMfaTicket({
            rawCode: 'raw', codeVerifier: VERIFIER, totpCode: '654321',
        });

        expect(r).toEqual({ ok: false, reason: 'ticket_invalid' });
        expect(verifyMfaChallenge).not.toHaveBeenCalled();
    });
});

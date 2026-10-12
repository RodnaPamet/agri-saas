/**
 * A suspended account may STOP an erasure and may not START one (#1667).
 *
 * `ACCOUNT_TERMINATED` sets `suspendedAt` as well as `deletionRequestedAt`, so
 * P5.9's check was refusing `DELETE /api/account/deletion` — the one route a
 * terminated person is entitled to use — while agrent-ios's recovery screen
 * (#282, installed) offered them the button. Owner ruling: they may cancel.
 *
 * ## The asymmetry is the subject
 *
 * Both verbs live in the same file, and only DELETE is exempt. A future
 * "hoist the ctx resolution out of the two handlers" refactor would silently
 * open POST, so the refusal on POST is asserted here rather than assumed from
 * the absence of an option.
 *
 * ## What cancelling does not do
 *
 * It clears `deletionRequestedAt` and nothing else — `suspendedAt` stays. So
 * the person stops the erasure and remains locked out, which is the honest
 * outcome and the reason the web `/suspended` page offers no cancel control
 * yet: a button that stops a clock without restoring access needs its own
 * wording, which is open on #1667.
 *
 * `tests/guards/suspension-escape-is-not-gated.test.ts` is the structural half
 * — it holds the `allowSuspended` call-site count at one.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const isAccountSuspended = jest.fn();
jest.mock('@/lib/auth/suspension', () => ({
    ...jest.requireActual('@/lib/auth/suspension'),
    isAccountSuspended: (userId: string) => isAccountSuspended(userId),
}));

const cancelAccountDeletion = jest.fn();
const requestAccountDeletion = jest.fn();
jest.mock('@/app-layer/usecases/account-erasure', () => ({
    ...jest.requireActual('@/app-layer/usecases/account-erasure'),
    cancelAccountDeletion: (...a: unknown[]) => cancelAccountDeletion(...a),
    requestAccountDeletion: (...a: unknown[]) => requestAccountDeletion(...a),
}));

import { NextRequest } from 'next/server';

import { DELETE, POST } from '@/app/api/account/deletion/route';

const SESSION = { user: { id: 'u-1', email: 'farmer@example.com' } };
const req = (method: string) =>
    new NextRequest('https://app.agrent.bg/api/account/deletion', { method });

/**
 * `withApiErrorHandling` types the handler it returns as `(req, ctx)` — the
 * Next-shaped signature — even where the inner handler ignores the second
 * argument. Jest does not care; `tsc` does, and it is the gate.
 */
const ctx = () => ({ params: Promise.resolve({}) });

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockResolvedValue(SESSION);
    isAccountSuspended.mockResolvedValue(false);
    cancelAccountDeletion.mockResolvedValue({ applied: true, wasRequested: true });
    requestAccountDeletion.mockResolvedValue({
        applied: true,
        alreadyRequested: false,
        erasesAt: new Date('2026-11-11T00:00:00Z'),
        sessionsRevoked: 1,
    });
});

describe('DELETE /api/account/deletion — the way out', () => {
    it('lets a SUSPENDED account cancel', async () => {
        isAccountSuspended.mockResolvedValue(true);
        const res = await DELETE(req('DELETE'), ctx());
        expect(res.status).toBe(200);
        expect(cancelAccountDeletion).toHaveBeenCalledWith('u-1');
    });

    it('still works for an account that is not suspended — the control', async () => {
        // Without this, an escape wired to ignore the session entirely would
        // satisfy the test above.
        const res = await DELETE(req('DELETE'), ctx());
        expect(res.status).toBe(200);
        expect(cancelAccountDeletion).toHaveBeenCalledWith('u-1');
    });

    it('still refuses a request with NO session', async () => {
        // `allowSuspended` exempts one check, not authentication. A terminated
        // person has a valid session; an anonymous caller does not.
        // `withApiErrorHandling` CATCHES the throw and returns a response, so
        // the assertion is on the STATUS. I wrote `rejects` first and it
        // reported "resolved instead of rejected" — which is the wrapper
        // working, not the refusal missing.
        auth.mockResolvedValue(null);
        const res = await DELETE(req('DELETE'), ctx());
        expect(res.status).toBe(401);
        expect(cancelAccountDeletion).not.toHaveBeenCalled();
    });
});

describe('POST /api/account/deletion — still refused', () => {
    it('refuses a SUSPENDED account with ACCOUNT_SUSPENDED', async () => {
        // The asymmetry: stop an erasure, yes; start one, no. Asserted rather
        // than inferred from the absence of an option, because both verbs sit
        // in one file and a shared ctx resolution would open this silently.
        isAccountSuspended.mockResolvedValue(true);
        const res = await POST(req('POST'), ctx());
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe('ACCOUNT_SUSPENDED');
        expect(requestAccountDeletion).not.toHaveBeenCalled();
    });

    it('still accepts an unsuspended account', async () => {
        const res = await POST(req('POST'), ctx());
        expect(res.status).toBe(200);
        expect(requestAccountDeletion).toHaveBeenCalledWith('u-1');
    });
});

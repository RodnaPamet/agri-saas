/**
 * A suspended account cannot accept an invite, and the invite SURVIVES (#1652).
 *
 * ## Why this file runs the real gate
 *
 * `authRefusingSuspended` could be mocked here and the tests would be shorter
 * and worthless: the thing #1652 was about is the WIRING — ten routes resolved
 * a session with a raw `auth()` and so never reached a check that already
 * existed and already worked. A test that mocks the door proves the door opens,
 * which was never in doubt. So `@/auth` and `@/lib/auth/suspension` are mocked
 * and the gate itself is real, which is the only arrangement where deleting the
 * gate call from a route turns this red.
 *
 * `tests/guards/api-routes-resolve-sessions-through-the-gate.test.ts` is the
 * structural half — no raw `auth()` under `src/app/api`, and the denominator
 * printed. Neither half subsumes the other: the guard cannot see a status code,
 * and this cannot see route 387.
 *
 * ## The assertion that carries the owner's ruling
 *
 * Owner ruling: refuse, and **the invite stays pending**. So every refusal test
 * asserts `redeemInvite` was NOT CALLED, not merely that the response was a
 * refusal. A route that redeemed the invite and then threw would satisfy a
 * status-only test while burning a single-use token — the person loses the
 * invite AND gains nothing, and the inviter has to issue another.
 *
 * ## And a positive control, because a gate that refuses everyone passes too
 *
 * `isAccountSuspended` is asserted to have been consulted, and the
 * not-suspended path is asserted to reach `redeemInvite`. Without that, a gate
 * wired to refuse unconditionally satisfies every negative in this file.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const isAccountSuspended = jest.fn();
jest.mock('@/lib/auth/suspension', () => ({
    // Spread the real module: a PARTIAL barrel mock makes every other export
    // `undefined`, and this repo has paid for that three times with
    // `X is not a function` at the first unmocked call.
    ...jest.requireActual('@/lib/auth/suspension'),
    isAccountSuspended: (userId: string) => isAccountSuspended(userId),
}));

const previewInviteByToken = jest.fn();
const redeemInvite = jest.fn();
jest.mock('@/app-layer/usecases/tenant-invites', () => ({
    previewInviteByToken: (...a: unknown[]) => previewInviteByToken(...a),
    redeemInvite: (...a: unknown[]) => redeemInvite(...a),
}));

import { NextRequest } from 'next/server';

import { GET as previewGET, POST as acceptPOST } from '@/app/api/invites/[token]/route';
import { GET as redirectGET } from '@/app/api/invites/[token]/accept-redirect/route';

const TOKEN = 'inv-token-1';
const SESSION = { user: { id: 'u-1', email: 'farmer@example.com' } };

const params = Promise.resolve({ token: TOKEN });
const req = (path = `/api/invites/${TOKEN}`) =>
    new NextRequest(`https://app.agrent.bg${path}`, { method: 'POST' });
const getReq = (path: string) =>
    new NextRequest(`https://app.agrent.bg${path}`, { method: 'GET' });

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockResolvedValue(SESSION);
    isAccountSuspended.mockResolvedValue(false);
    previewInviteByToken.mockResolvedValue({
        tenantName: 'Ферма Иванов',
        email: SESSION.user.email,
        role: 'EDITOR',
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        matchesSession: true,
    });
    redeemInvite.mockResolvedValue({ slug: 'ferma-ivanov' });
});

describe('POST /api/invites/[token] — accept', () => {
    it('refuses a suspended account with ACCOUNT_SUSPENDED', async () => {
        isAccountSuspended.mockResolvedValue(true);
        const res = await acceptPOST(req(), { params });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('LEAVES THE INVITE PENDING — redeemInvite is never called', async () => {
        // The owner's ruling, and the half a status-only assertion would miss.
        // Burning a single-use token on a refused acceptance costs the person
        // the invite and gains nothing.
        isAccountSuspended.mockResolvedValue(true);
        await acceptPOST(req(), { params });
        expect(redeemInvite).not.toHaveBeenCalled();
    });

    it('consults the suspension check at all', async () => {
        // Positive control on the WIRING: without this, a route that never
        // asked would satisfy the not-suspended test below by doing nothing.
        await acceptPOST(req(), { params });
        expect(isAccountSuspended).toHaveBeenCalledWith('u-1');
    });

    it('still accepts for an account that is NOT suspended', async () => {
        // The control that stops a gate refusing everyone from passing.
        const res = await acceptPOST(req(), { params });
        expect(res.status).toBe(200);
        expect(redeemInvite).toHaveBeenCalledWith(
            expect.objectContaining({ token: TOKEN, userId: 'u-1' }),
        );
    });
});

describe('GET /api/invites/[token] — preview', () => {
    it('PROCEEDS for a suspended account, deliberately', async () => {
        // Asserted rather than left implicit, because it is the line a later
        // reader is most likely to "tighten". The owner's ruling was about
        // ACCEPTANCE; a preview is a read of an invite the person was sent,
        // already enumeration-safe, and refusing it conceals what they are
        // being told about rather than stopping them acting on it.
        isAccountSuspended.mockResolvedValue(true);
        const res = await previewGET(getReq(`/api/invites/${TOKEN}`), { params });
        expect(res.status).toBe(200);
        expect(previewInviteByToken).toHaveBeenCalled();
    });
});

describe('GET /api/invites/[token]/accept-redirect', () => {
    it('redirects a suspended account to the invite page with a CODE', async () => {
        // A redirect rather than a thrown 403: this is a bare `GET` a browser
        // navigates to, where a JSON body is rendered as JSON. And a stable
        // code rather than a sentence — the route's own `catch` puts
        // `err.message` in this parameter, which is server-authored English on
        // a downward ratchet.
        isAccountSuspended.mockResolvedValue(true);
        const res = await redirectGET(
            getReq(`/api/invites/${TOKEN}/accept-redirect`),
            { params },
        );
        expect(res.status).toBe(307);
        const location = new URL(res.headers.get('location')!);
        expect(location.pathname).toBe(`/invite/${TOKEN}`);
        expect(location.searchParams.get('error')).toBe('ACCOUNT_SUSPENDED');
    });

    it('LEAVES THE INVITE PENDING on the redirect path too', async () => {
        isAccountSuspended.mockResolvedValue(true);
        await redirectGET(getReq(`/api/invites/${TOKEN}/accept-redirect`), { params });
        expect(redeemInvite).not.toHaveBeenCalled();
    });

    it('still redeems and sends an unsuspended account to its new farm', async () => {
        const res = await redirectGET(
            getReq(`/api/invites/${TOKEN}/accept-redirect`),
            { params },
        );
        expect(redeemInvite).toHaveBeenCalled();
        expect(new URL(res.headers.get('location')!).pathname).toBe(
            '/t/ferma-ivanov/dashboard',
        );
    });

    it('sends an account with NO session to sign-in, unchanged', async () => {
        // The 401/302 contracts are deliberately untouched by #1652 — the gate
        // returns the session unchanged, `null` included, so each route keeps
        // its own unauthenticated branch. Pinned so a later "unify the
        // refusals" change has to break a test rather than a client.
        auth.mockResolvedValue(null);
        const res = await redirectGET(
            getReq(`/api/invites/${TOKEN}/accept-redirect`),
            { params },
        );
        const location = new URL(res.headers.get('location')!);
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('callbackUrl')).toBe(
            `/api/invites/${TOKEN}/accept-redirect`,
        );
        // And no suspension read for a request with nobody to ask about.
        expect(isAccountSuspended).not.toHaveBeenCalled();
    });
});

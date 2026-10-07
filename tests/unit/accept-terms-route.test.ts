/**
 * `POST /api/auth/accept-terms` — the way OUT of the consent gate (P3.1).
 *
 * The properties that make it safe to be the one route an unconsented session
 * may call:
 *
 *   * it needs a session — there is nobody to record an acceptance for
 *     otherwise;
 *   * `acceptedTerms` is compared for IDENTITY with `true`, so a client that
 *     never rendered a control cannot satisfy a consent gate with any
 *     non-empty value;
 *   * the version is the one the server is SERVING, not whatever arrived —
 *     otherwise a page left open across a terms change files a consent to a
 *     document nobody read;
 *   * it is IDEMPOTENT and does not re-stamp. The timestamp is the artifact;
 *     moving it on every replay would destroy the only thing the column is
 *     for, which is being able to say WHEN somebody agreed.
 */
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: (...a: unknown[]) => mockAuth(...a) }));

const mockUpdateMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { user: { updateMany: (...a: unknown[]) => mockUpdateMany(...a) } },
}));

import { NextRequest } from 'next/server';

import { POST } from '@/app/api/auth/accept-terms/route';
import { TERMS_VERSION } from '@/lib/legal/terms';

function post(body: unknown): Promise<Response> {
    const req = new NextRequest('http://localhost/api/auth/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return POST(req as never, {} as never);
}

const VALID = { acceptedTerms: true, termsVersion: TERMS_VERSION };

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('it needs a session', () => {
    it('401s with no session, and writes nothing', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await post(VALID);
        expect(res.status).toBe(401);
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('401s for a session with no user id', async () => {
        mockAuth.mockResolvedValue({ user: {} });
        const res = await post(VALID);
        expect(res.status).toBe(401);
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });
});

describe('consent is checked for identity, not truthiness', () => {
    it('accepts a literal true', async () => {
        const res = await post(VALID);
        expect(res.status).toBe(200);
        expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    });

    it.each([false, 'yes', 1, {}, [], null, undefined])(
        'refuses %p and writes nothing',
        async (value) => {
            const res = await post({ ...VALID, acceptedTerms: value });
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: 'terms_not_accepted' });
            expect(mockUpdateMany).not.toHaveBeenCalled();
        },
    );
});

describe('the version must be the one being served', () => {
    it('refuses a stale version and names the current one', async () => {
        const res = await post({ ...VALID, termsVersion: 'some-older-version' });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: 'terms_version_stale',
            // So the client can say "reload and read the new terms" rather
            // than showing a generic failure.
            currentVersion: TERMS_VERSION,
        });
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('refuses a missing version even with acceptedTerms true', async () => {
        const res = await post({ acceptedTerms: true });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('terms_version_stale');
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('stores the SERVER constant', async () => {
        await post(VALID);
        const args = mockUpdateMany.mock.calls[0][0];
        expect(args.data.acceptedTermsVersion).toBe(TERMS_VERSION);
        expect(args.data.acceptedTermsAt).toBeInstanceOf(Date);
    });
});

describe('it is idempotent and does not re-stamp', () => {
    it('writes conditionally on the column still being null', async () => {
        // This is what makes a replay harmless: the predicate, not a
        // read-then-write. `updateMany` is deliberate — zero rows affected
        // means "already accepted", which is a success.
        await post(VALID);
        const args = mockUpdateMany.mock.calls[0][0];
        expect(args.where).toEqual({ id: 'user-1', acceptedTermsAt: null });
    });

    it('a replay that matches no row still returns 200', async () => {
        // The user already accepted. Answering 409 here would strand a client
        // that double-submitted, on a gate whose only exit is this route.
        mockUpdateMany.mockResolvedValue({ count: 0 });
        const res = await post(VALID);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, version: TERMS_VERSION });
    });

    it('scopes the write to the SESSION user, never a body-supplied id', async () => {
        // A caller-supplied id would let anybody record consent for somebody
        // else — which is both a false record and a way to open another
        // person's gate.
        await post({ ...VALID, userId: 'someone-else' });
        const args = mockUpdateMany.mock.calls[0][0];
        expect(args.where.id).toBe('user-1');
    });
});

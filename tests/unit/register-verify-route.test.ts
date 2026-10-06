/**
 * `POST /api/auth/register/verify` — the collapse, and the two things it must
 * not do.
 *
 * The property worth testing is NEGATIVE: three internally-distinguished
 * failures must become one externally-indistinguishable answer. `expired` and
 * `too_many_attempts` can only occur when a code row exists for that address,
 * so returning them would tell an attacker which addresses have recently begun
 * signing up — the same oracle `start` closes, one step later.
 *
 * It must also not create a farm (that is P3.6), and must not let junk
 * submissions burn a victim's attempt budget.
 */
const mockUserUpdateMany = jest.fn();
const mockUserFindFirst = jest.fn();

const throwOnFarmWrite = (model: string) =>
    jest.fn((..._a: unknown[]): never => {
        throw new Error(`${model}.create was called by register/verify — it must create no farm`);
    });

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
            findFirst: (...a: unknown[]) => mockUserFindFirst(...a),
        },
        tenant: { create: throwOnFarmWrite('tenant') },
        tenantMembership: { create: throwOnFarmWrite('tenantMembership') },
    },
}));

jest.mock('@/lib/security/encryption', () => ({
    __esModule: true,
    hashForLookupCandidates: (s: string) => [`H(${s})`],
}));

const mockVerify = jest.fn();
jest.mock('@/lib/auth/email-verification-code', () => ({
    __esModule: true,
    verifyEmailVerificationCode: (...a: unknown[]) => mockVerify(...a),
    normaliseEmail: (e: string) => (e ?? '').trim().toLowerCase(),
    CODE_LENGTH: 6,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/register/verify/route';

function verifyRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * Call the handler.
 *
 * `withApiErrorHandling` returns a TWO-argument Next route handler, so each
 * call needs a `ctx` placeholder plus casts. One helper keeps those casts in a
 * single place; sprinkled at every call site, a third cast added later could
 * quietly hide a real signature change.
 */
async function post(body: Record<string, unknown>): Promise<Response> {
    return POST(verifyRequest(body) as never, {} as never);
}

const VALID = { email: 'ivan@example.bg', code: '048212' };

beforeEach(() => {
    jest.clearAllMocks();
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
    mockUserFindFirst.mockResolvedValue({ id: 'u1' });
});

describe('a valid code verifies the email', () => {
    it('sets emailVerified and says so', async () => {
        mockVerify.mockResolvedValue({ ok: true });
        const res = await post(VALID);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true, verified: true });
    });

    it('guards the update on emailVerified being null', async () => {
        mockVerify.mockResolvedValue({ ok: true });
        await post(VALID);
        // Without the null guard a second verify would move the timestamp, and
        // the timestamp is what P3.5e's sweep and P3.5f's budget gate read.
        expect(mockUserUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ emailVerified: null }),
            }),
        );
    });

    it('a second verify is harmless rather than an error', async () => {
        mockVerify.mockResolvedValue({ ok: true });
        mockUserUpdateMany.mockResolvedValue({ count: 0 }); // already verified
        mockUserFindFirst.mockResolvedValue({ id: 'u1' }); // …but still present
        const res = await post(VALID);
        expect(res.status).toBe(200);
    });

    it('creates no farm', async () => {
        mockVerify.mockResolvedValue({ ok: true });
        // 200 rather than a 500 from the throwing doubles IS the assertion.
        expect((await post(VALID)).status).toBe(200);
    });
});

describe('every failure is the same failure', () => {
    async function bodyFor(reason: string): Promise<string> {
        jest.clearAllMocks();
        mockVerify.mockResolvedValue({ ok: false, reason });
        const res = await post(VALID);
        expect(res.status).toBe(400);
        return JSON.stringify(await res.json());
    }

    it('invalid, expired and too_many_attempts are byte-identical', async () => {
        const invalid = await bodyFor('invalid');
        const expired = await bodyFor('expired');
        const exhausted = await bodyFor('too_many_attempts');

        // `expired` and `too_many_attempts` are only reachable when a code row
        // EXISTS for the address, so leaking them apart from `invalid` would
        // mark which addresses recently started signing up.
        expect(expired).toBe(invalid);
        expect(exhausted).toBe(invalid);
        expect(invalid).toBe('{"error":"invalid_code"}');
    });

    it('a valid code for a user who has since vanished also gets it', async () => {
        mockVerify.mockResolvedValue({ ok: true });
        mockUserUpdateMany.mockResolvedValue({ count: 0 });
        mockUserFindFirst.mockResolvedValue(null); // swept between issue and verify
        const res = await post(VALID);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_code' });
    });
});

describe('junk cannot burn the attempt budget', () => {
    it.each([
        ['too short', '12345'],
        ['too long', '1234567'],
        ['non-digits', 'abcdef'],
        ['mixed', '12a456'],
        ['a 400-char payload', '1'.repeat(400)],
    ])('%s is refused without consulting the code at all', async (_l, code) => {
        const res = await post({ ...VALID, code });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_code' });
        // The point: `verifyEmailVerificationCode` increments the counter, so
        // reaching it with input that could never match would let anyone spend
        // a victim's five attempts without making a single real guess.
        expect(mockVerify).not.toHaveBeenCalled();
    });

    it('…but a well-formed wrong code DOES reach it', async () => {
        // The control for the above. A length check that rejected everything
        // would satisfy every assertion in this block while breaking the
        // feature, and `not.toHaveBeenCalled` cannot tell the difference.
        mockVerify.mockResolvedValue({ ok: false, reason: 'invalid' });
        await post({ ...VALID, code: '000000' });
        expect(mockVerify).toHaveBeenCalledWith('ivan@example.bg', '000000');
    });
});

describe('a malformed request is distinguishable from a bad code', () => {
    it.each([
        ['missing code', { email: 'a@b.bg' }],
        ['missing email', { code: '048212' }],
        ['code not a string', { email: 'a@b.bg', code: 48212 }],
    ])('%s → invalid_request, not invalid_code', async (_l, body) => {
        const res = await post(body as Record<string, unknown>);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_request' });
    });
});

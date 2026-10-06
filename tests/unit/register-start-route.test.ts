/**
 * `POST /api/auth/register/start` — the properties that make it safe.
 *
 * Three of these are security properties rather than behaviour, and each is
 * asserted in a way that fails if the property is lost:
 *
 * 1. **No farm is created.** This is the whole inversion P3.5 exists for. It
 *    is asserted by making `tenant.create` and `tenantMembership.create`
 *    THROW, borrowed from `register-route.test.ts`: a route that created
 *    either would 500 and the status assertion catches it. A plain
 *    `expect(spy).not.toHaveBeenCalled()` would also work, but only if the
 *    test author remembered to write it for every case — a throwing double
 *    covers cases nobody has written yet.
 *
 * 2. **Every branch answers identically.** Asserted on the serialised body,
 *    not field-by-field, because the risk is a branch GAINING a field.
 *
 * 3. **The password is hashed on every branch.** This is the timing defence,
 *    and it is invisible in the response — the only way to see it is to count
 *    `hashPassword` calls on the paths that discard the result.
 *
 * The HIBP assertion EXECUTES the reject branch (real POST, `breached: true`,
 * 400, nothing written). Per #1166: on 2026-08-19 the reject branch was
 * deleted from two routes by a PR about Playwright apt stalls, and a
 * `readFileSync`-plus-regex guardrail stayed green against the remains.
 *
 * bcrypt is mocked here, so the suite needs no CPU headroom — the real hash
 * is exercised in the integration tests.
 */
jest.setTimeout(30_000);

const mockUserFindFirst = jest.fn();
const mockUserCreate = jest.fn();
const mockUserUpdate = jest.fn();
const mockUserUpdateMany = jest.fn();

/** A farm must never be born on this route. See property 1 above. */
const throwOnFarmWrite = (model: string) =>
    jest.fn((..._a: unknown[]): never => {
        throw new Error(
            `${model}.create was called by register/start — this route must create NO farm; ` +
                `the tenant is created after verification by POST /api/me/farms (P3.6)`,
        );
    });

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        user: {
            findFirst: (...a: unknown[]) => mockUserFindFirst(...a),
            create: (...a: unknown[]) => mockUserCreate(...a),
            update: (...a: unknown[]) => mockUserUpdate(...a),
            updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
        },
        tenant: { create: throwOnFarmWrite('tenant') },
        tenantMembership: { create: throwOnFarmWrite('tenantMembership') },
        tenantOnboarding: { create: throwOnFarmWrite('tenantOnboarding') },
    },
}));

const mockHibp = jest.fn(async () => ({ breached: false }));
jest.mock('@/lib/security/password-check', () => ({
    __esModule: true,
    checkPasswordAgainstHIBP: (...a: unknown[]) => mockHibp(...(a as [])),
}));

const mockHashPassword = jest.fn(async () => 'hashed-pw');
jest.mock('@/lib/auth/passwords', () => ({
    __esModule: true,
    hashPassword: (...a: unknown[]) => mockHashPassword(...(a as [])),
    validatePasswordPolicy: jest.fn(() => ({ ok: true })),
}));

const mockIssueCode = jest.fn(async () => '048212');
jest.mock('@/lib/auth/email-verification-code', () => ({
    __esModule: true,
    issueEmailVerificationCode: (...a: unknown[]) => mockIssueCode(...(a as [])),
    normaliseEmail: (e: string) => (e ?? '').trim().toLowerCase(),
    CODE_LENGTH: 6,
}));

const mockVerifyTurnstile = jest.fn(async () => ({ ok: true, skipped: true }));
jest.mock('@/lib/security/turnstile', () => ({
    __esModule: true,
    verifyTurnstile: (...a: unknown[]) => mockVerifyTurnstile(...(a as [])),
}));

const mockSendCode = jest.fn(async () => undefined);
const mockSendExisting = jest.fn(async () => undefined);
jest.mock('@/lib/auth/registration-emails', () => ({
    __esModule: true,
    sendVerificationCodeEmail: (...a: unknown[]) => mockSendCode(...(a as [])),
    sendAlreadyRegisteredEmail: (...a: unknown[]) => mockSendExisting(...(a as [])),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/register/start/route';

function startRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost/api/auth/register/start', {
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
    return POST(startRequest(body) as never, {} as never);
}

const VALID = { email: 'ivan@example.bg', password: 'correct horse battery', name: 'Иван' };

beforeEach(() => {
    jest.clearAllMocks();
    mockHibp.mockResolvedValue({ breached: false });
    mockHashPassword.mockResolvedValue('hashed-pw');
    mockIssueCode.mockResolvedValue('048212');
    mockUserFindFirst.mockResolvedValue(null);
    mockUserCreate.mockResolvedValue({ id: 'u1', uiLanguage: 'bg' });
    mockVerifyTurnstile.mockResolvedValue({ ok: true, skipped: true });
});

describe('register/start creates no farm', () => {
    it('a brand-new signup writes a User and nothing else', async () => {
        const res = await post(VALID);
        // 200 rather than a 500 from the throwing doubles IS the assertion.
        expect(res.status).toBe(200);
        expect(mockUserCreate).toHaveBeenCalledTimes(1);
    });

    it('the created user is explicitly unverified', async () => {
        await post(VALID);
        const data = mockUserCreate.mock.calls[0][0].data;
        // P3.5e's sweep selects on this column, and P3.5f gates the AI budget
        // on it, so it being null is a contract rather than a default.
        expect(data.emailVerified).toBeNull();
        expect(data.passwordHash).toBe('hashed-pw');
    });
});

describe('every address gets the same answer', () => {
    async function bodyFor(existing: unknown): Promise<string> {
        jest.clearAllMocks();
        mockHibp.mockResolvedValue({ breached: false });
        mockHashPassword.mockResolvedValue('hashed-pw');
        mockIssueCode.mockResolvedValue('048212');
        mockUserCreate.mockResolvedValue({ id: 'u1', uiLanguage: 'bg' });
        mockUserFindFirst.mockResolvedValue(existing);
        const res = await post(VALID);
        expect(res.status).toBe(200);
        return JSON.stringify(await res.json());
    }

    it('new, unverified-existing and verified-existing are byte-identical', async () => {
        const fresh = await bodyFor(null);
        const pending = await bodyFor({ id: 'u2', emailVerified: null, uiLanguage: 'bg' });
        const taken = await bodyFor({
            id: 'u3',
            emailVerified: new Date('2026-01-01'),
            uiLanguage: 'bg',
        });

        // Compared as serialised strings on purpose: the failure mode is a
        // branch GAINING a field, which a field-by-field assertion written
        // today would not notice tomorrow.
        expect(pending).toBe(fresh);
        expect(taken).toBe(fresh);
        expect(fresh).toBe('{"ok":true}');
    });

    it('the password is hashed even when the work is thrown away', async () => {
        // The timing defence. If hashing moved inside the create branch, the
        // two known-address branches would return ~100ms sooner and the
        // enumeration oracle would simply move from the body to the clock.
        mockUserFindFirst.mockResolvedValue({
            id: 'u3',
            emailVerified: new Date('2026-01-01'),
            uiLanguage: 'bg',
        });
        await post(VALID);
        expect(mockHashPassword).toHaveBeenCalledTimes(1);
        expect(mockUserCreate).not.toHaveBeenCalled();
    });
});

describe('an existing account is not altered', () => {
    it('a verified address gets the notice, not a code', async () => {
        mockUserFindFirst.mockResolvedValue({
            id: 'u3',
            emailVerified: new Date('2026-01-01'),
            uiLanguage: 'bg',
        });
        await post(VALID);
        expect(mockSendExisting).toHaveBeenCalledTimes(1);
        expect(mockIssueCode).not.toHaveBeenCalled();
        expect(mockSendCode).not.toHaveBeenCalled();
    });

    it('an unverified address gets a fresh code and keeps its password', async () => {
        mockUserFindFirst.mockResolvedValue({ id: 'u2', emailVerified: null, uiLanguage: 'bg' });
        await post(VALID);
        expect(mockIssueCode).toHaveBeenCalledTimes(1);
        expect(mockSendCode).toHaveBeenCalledTimes(1);
        // The important half: "register again" must not be a password reset
        // that skips proving you own the mailbox.
        expect(mockUserUpdate).not.toHaveBeenCalled();
        expect(mockUserUpdateMany).not.toHaveBeenCalled();
        expect(mockUserCreate).not.toHaveBeenCalled();
    });
});

describe('HIBP screening executes', () => {
    it('a breached password is refused and writes nothing', async () => {
        mockHibp.mockResolvedValue({ breached: true });
        const res = await post(VALID);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
            error: 'This password appears in known data breaches. Please choose a different password.',
        });
        expect(mockUserCreate).not.toHaveBeenCalled();
        expect(mockIssueCode).not.toHaveBeenCalled();
    });

    it('is reached BEFORE the address is looked up', async () => {
        // Ordering matters: screening after the lookup would mean a breached
        // password still told the attacker (via timing) whether the address
        // existed. It also means HIBP cannot be skipped for known addresses.
        mockHibp.mockResolvedValue({ breached: true });
        await post(VALID);
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });
});

describe('known disposable domains are refused (P3.5a)', () => {
    it('a listed domain is a 400, before any address lookup', async () => {
        // Not mocked: the real domain set runs here, so this also proves the
        // module is actually reachable from this route rather than merely
        // imported — a library with no live caller is the exact trap P3.3 hit.
        const res = await post({ ...VALID, email: 'someone@mailinator.com' });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'disposable_email' });
        expect(mockUserFindFirst).not.toHaveBeenCalled();
        expect(mockUserCreate).not.toHaveBeenCalled();
    });

    it('an unlisted domain is allowed — the check fails OPEN', async () => {
        // The control. A check that refused everything would satisfy the
        // assertion above while breaking every real signup, and the test
        // could not tell the difference.
        const res = await post({ ...VALID, email: 'ivan@some-real-farm.bg' });
        expect(res.status).toBe(200);
        expect(mockUserCreate).toHaveBeenCalledTimes(1);
    });

    it('a subdomain of a listed domain is refused too', async () => {
        const res = await post({ ...VALID, email: 'a@mail.mailinator.com' });
        expect(res.status).toBe(400);
    });
});

describe('a malformed request is distinguishable, deliberately', () => {
    it.each([
        ['missing email', { password: 'x'.repeat(20), name: 'A' }],
        ['missing password', { email: 'a@b.bg', name: 'A' }],
        ['missing name', { email: 'a@b.bg', password: 'x'.repeat(20) }],
        ['email not a string', { email: 42, password: 'x'.repeat(20), name: 'A' }],
    ])('%s → 400 invalid_request', async (_label, body) => {
        const res = await post(body as Record<string, unknown>);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'invalid_request' });
    });

    it('a 400 for a bad request is NOT an enumeration leak', async () => {
        // Worth stating because it looks like one. These 400s are statements
        // about the REQUEST — they are returned before any address is
        // consulted, so they cannot vary with account state.
        await post({ email: 42, password: 'x'.repeat(20), name: 'A' });
        expect(mockUserFindFirst).not.toHaveBeenCalled();
    });
});

// ─── P3.5c — bot screening on the new front door ───

describe('Turnstile screening (P3.5c)', () => {
    it('refuses when Turnstile rejects, before anything is written', async () => {
        mockVerifyTurnstile.mockResolvedValue({
            ok: false,
            skipped: false,
            codes: ['invalid-input-response'],
        });

        const res = await post(VALID);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
            error: 'turnstile_failed',
            codes: ['invalid-input-response'],
        });

        // Screening is FIRST: no hash, no lookup, no write. bcrypt is most of
        // what a signup flood costs, so a screen that ran later would refuse
        // the request having already paid for it.
        expect(mockHashPassword).not.toHaveBeenCalled();
        expect(mockUserFindFirst).not.toHaveBeenCalled();
        expect(mockUserCreate).not.toHaveBeenCalled();
        expect(mockIssueCode).not.toHaveBeenCalled();
    });

    it('its 400 is distinguishable from the uniform 200 — deliberately', async () => {
        // Every account-state outcome returns an identical `{ok:true}`, so a
        // distinguishable refusal here looks inconsistent. It is not: this is
        // a statement about the REQUEST's challenge token, not about the
        // address, so it reveals nothing about who has an account — and the
        // client must know to reset the widget, since a token is single-use
        // and a blind retry always fails.
        mockVerifyTurnstile.mockResolvedValue({ ok: false, skipped: false, codes: ['x'] });
        const refused = await post(VALID);
        expect(refused.status).toBe(400);

        mockVerifyTurnstile.mockResolvedValue({ ok: true, skipped: true });
        const accepted = await post(VALID);
        expect(accepted.status).toBe(200);
        await expect(accepted.json()).resolves.toEqual({ ok: true });
    });

    it('proceeds when screening is dormant — the live configuration today', async () => {
        mockVerifyTurnstile.mockResolvedValue({ ok: true, skipped: true });
        expect((await post(VALID)).status).toBe(200);
        expect(mockUserCreate).toHaveBeenCalledTimes(1);
    });

    it('proceeds when Cloudflare is unreachable, which is deliberate', async () => {
        // Documented fail-open on TRANSPORT failure only. An attacker cannot
        // reach this branch at will: a forged token draws an explicit
        // rejection, which refuses.
        mockVerifyTurnstile.mockResolvedValue({ ok: true, skipped: false, degraded: true });
        expect((await post(VALID)).status).toBe(200);
    });
});

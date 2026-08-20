/**
 * Breached-password screening on the two password-SETTING routes, driven
 * through the real handlers.
 *
 * ## Why this file exists
 *
 * `/api/auth/register` has had an executing HIBP assertion since it shipped
 * (`register-route.test.ts` — real POST, `breached: true`, asserts 400 and that
 * the transaction never ran). `change-password` and `reset-password` had
 * nothing but `tests/guardrails/hibp-coverage.test.ts`, which is `readFileSync`
 * + regex.
 *
 * That asymmetry is not academic. On 2026-08-19 the reject branch was deleted
 * from BOTH routes by `3bd7c779` (#613) — a CI-only PR about Playwright apt
 * stalls, whose body never mentions them. The `await` stayed, the result was
 * discarded, and the guardrail's import-and-call regexes were satisfied by the
 * remains. It shipped in v2.3.0 and was live for a day: both routes accepted
 * known-breached passwords while signup still refused them.
 *
 * A grep cannot see a discarded return value. These tests can: each drives the
 * real exported POST with a mocked HIBP saying `breached: true` and asserts the
 * password was never changed. Restore the deletion and they fail.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/security/password-check', () => ({
    checkPasswordAgainstHIBP: jest.fn(),
}));
jest.mock('@/auth', () => ({
    auth: jest.fn(),
}));
jest.mock('@/lib/auth/password-management', () => ({
    changePassword: jest.fn(),
    consumePasswordReset: jest.fn(),
}));

import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
import { auth } from '@/auth';
import { changePassword, consumePasswordReset } from '@/lib/auth/password-management';

import { POST as changePasswordPOST } from '@/app/api/auth/change-password/route';
import { POST as resetPasswordPOST } from '@/app/api/auth/reset-password/route';

const hibp = checkPasswordAgainstHIBP as jest.Mock;
const mockAuth = auth as unknown as jest.Mock;
const mockChange = changePassword as jest.Mock;
const mockConsume = consumePasswordReset as jest.Mock;

/** Long enough to clear the length policy, so HIBP is the only thing left. */
const NEW_PASSWORD = 'correct-horse-battery-staple-42'; // pragma: allowlist secret -- test input to a mocked HIBP check, never a credential

function post(url: string, body: unknown): NextRequest {
    return new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    // Not clearAllMocks alone — a throwing implementation would survive it.
    hibp.mockReset();
    mockAuth.mockReset();
    mockChange.mockReset();
    mockConsume.mockReset();

    mockAuth.mockResolvedValue({ user: { id: 'usr_1', email: 'a@b.c' } });
    mockChange.mockResolvedValue({ ok: true });
    mockConsume.mockResolvedValue({ ok: true });
});

describe('POST /api/auth/change-password', () => {
    it('refuses a breached password with 400 and never changes it', async () => {
        hibp.mockResolvedValueOnce({ breached: true });

        const res = await changePasswordPOST(
            post('http://localhost:3000/api/auth/change-password', {
                currentPassword: 'old-password-that-is-long-enough', // pragma: allowlist secret -- test input, changePassword is mocked
                newPassword: NEW_PASSWORD,
            }) as never,
            {} as never,
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/known data breaches/i);
        // The assertion that actually matters: the write never happened.
        expect(mockChange).not.toHaveBeenCalled();
    });

    it('accepts a clean password — the control that proves the refusal is HIBP', async () => {
        // Without this, the test above would pass for any reason the handler
        // returns 400 (length policy, same-as-current, a thrown mock).
        hibp.mockResolvedValueOnce({ breached: false });

        const res = await changePasswordPOST(
            post('http://localhost:3000/api/auth/change-password', {
                currentPassword: 'old-password-that-is-long-enough', // pragma: allowlist secret -- test input, changePassword is mocked
                newPassword: NEW_PASSWORD,
            }) as never,
            {} as never,
        );

        expect(res.status).toBe(200);
        expect(mockChange).toHaveBeenCalledTimes(1);
    });

    it('consults the result, not merely the call', async () => {
        // The exact regression #613 shipped: `await checkPasswordAgainstHIBP(x)`
        // with the answer dropped. The call count is identical either way, so
        // asserting it would not have caught this.
        hibp.mockResolvedValueOnce({ breached: true });

        await changePasswordPOST(
            post('http://localhost:3000/api/auth/change-password', {
                currentPassword: 'old-password-that-is-long-enough', // pragma: allowlist secret -- test input, changePassword is mocked
                newPassword: NEW_PASSWORD,
            }) as never,
            {} as never,
        );

        expect(hibp).toHaveBeenCalledWith(NEW_PASSWORD);
        expect(mockChange).not.toHaveBeenCalled();
    });
});

describe('POST /api/auth/reset-password', () => {
    it('refuses a breached password with 400 and never consumes the token', async () => {
        hibp.mockResolvedValueOnce({ breached: true });

        const res = await resetPasswordPOST(
            post('http://localhost:3000/api/auth/reset-password', {
                token: 'a'.repeat(43),
                newPassword: NEW_PASSWORD,
            }) as never,
            {} as never,
        );

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/known data breaches/i);
        // A burnt token would also be a denial-of-service on the real user.
        expect(mockConsume).not.toHaveBeenCalled();
    });

    it('accepts a clean password — control', async () => {
        hibp.mockResolvedValueOnce({ breached: false });

        const res = await resetPasswordPOST(
            post('http://localhost:3000/api/auth/reset-password', {
                token: 'a'.repeat(43),
                newPassword: NEW_PASSWORD,
            }) as never,
            {} as never,
        );

        expect(res.status).toBe(200);
        expect(mockConsume).toHaveBeenCalledTimes(1);
    });
});

describe('the fail-open contract survives', () => {
    it('a HIBP outage does not brick either route', async () => {
        // checkPasswordAgainstHIBP is documented to fail OPEN — an outage
        // returns breached:false rather than throwing. Pinned here because
        // "reject on breach" and "do not brick on outage" are in tension and a
        // future hardening could quietly trade one for the other.
        hibp.mockResolvedValue({ breached: false });

        const a = await changePasswordPOST(
            post('http://localhost:3000/api/auth/change-password', {
                currentPassword: 'old-password-that-is-long-enough', // pragma: allowlist secret -- test input, changePassword is mocked
                newPassword: NEW_PASSWORD,
            }) as never,
            {} as never,
        );
        const b = await resetPasswordPOST(
            post('http://localhost:3000/api/auth/reset-password', {
                token: 'a'.repeat(43),
                newPassword: NEW_PASSWORD,
            }) as never,
            {} as never,
        );

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
    });
});

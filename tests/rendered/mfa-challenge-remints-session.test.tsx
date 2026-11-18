/**
 * #3212 — a correct MFA code re-mints the session cookie before navigating.
 *
 * Nothing re-minted it: the page navigated on success expecting "the JWT will
 * be refreshed on next request", which it is not without a SessionProvider. The
 * Edge then read the old cookie, still saw the farm as owed a factor, and sent
 * the person back to the challenge after every correct code.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('next=/t/farm/dashboard') }));
jest.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
jest.mock('next-auth/react', () => ({ getCsrfToken: jest.fn(async () => 'csrf-1') }));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/farm${p}`,
    useTenantHref: () => (p: string) => `/t/farm${p}`,
}));

import MfaChallengePage from '@/app/t/[tenantSlug]/(app)/auth/mfa/page';

const calls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
    calls.length = 0;
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const body = String(url).endsWith('/security/mfa/enroll')
            ? { isVerified: true }
            : String(url).endsWith('/challenge/verify') ? { success: true } : {};
        return { ok: true, json: async () => body } as Response;
    }) as typeof fetch;
});

it('POSTs /api/auth/session with the CSRF token and a JSON body after a correct code', async () => {
    render(<MfaChallengePage />);
    const input = await screen.findByRole('textbox', { hidden: true }).catch(() => document.getElementById('mfa-challenge-input')!);
    fireEvent.change(input as HTMLElement, { target: { value: '123456' } });
    fireEvent.click(document.getElementById('mfa-challenge-submit')!);

    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/session')).toBe(true));
    const remint = calls.find((c) => c.url === '/api/auth/session')!;
    expect(remint.init?.method).toBe('POST');
    expect((remint.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(remint.init?.body))).toEqual({ csrfToken: 'csrf-1', data: {} });
    // After the verify that cleared the factor, never before it.
    const order = calls.map((c) => c.url);
    expect(order.indexOf('/api/auth/session')).toBeGreaterThan(order.indexOf('/api/t/farm/security/mfa/challenge/verify'));
});

/**
 * Self-hosted billing — the checkout + portal routes must short-circuit
 * with a structured 403 ("billing_unavailable") instead of letting the
 * inner `getStripe()` throw a bare 500. Without this gate, the
 * client-side error path got an opaque "Failed (500)" and the user
 * had no way to tell whether Stripe was configured or there was a
 * real outage.
 *
 * Both routes share the same gate logic; the test covers each.
 */
import { NextRequest } from 'next/server';

// Force self-hosted mode by ensuring STRIPE_SECRET_KEY is unset BEFORE
// the route module evaluates `getBillingMode()`. The mode is computed
// once at module load, so order matters.
const originalKey = process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_SECRET_KEY;

// Stub `requirePermission` so we don't need a full session. It just
// passes the request through with a synthesised admin ctx.
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (_key: string, handler: unknown) =>
        async (req: unknown, routeArgs: unknown) =>
            (handler as (
                r: unknown,
                a: unknown,
                ctx: unknown,
            ) => Promise<unknown>)(req, routeArgs, {
                userId: 'u-1',
                tenantId: 't-1',
                tenantSlug: 'acme',
            }),
}));

// Stub the Stripe lib so a regression that bypasses the self-hosted
// gate would surface as "stripe was called in self-hosted mode" via
// the spy assertion below — the real function would have thrown
// "STRIPE_SECRET_KEY is not configured" anyway, but the spy gives a
// cleaner failure mode.
const stripeSpy = jest.fn(() => {
    throw new Error('stripe was called in self-hosted mode');
});
jest.mock('@/lib/stripe', () => ({
    findOrCreateCustomer: stripeSpy,
    createCheckoutSession: stripeSpy,
    createPortalSession: stripeSpy,
}));

afterAll(() => {
    if (originalKey !== undefined) process.env.STRIPE_SECRET_KEY = originalKey;
});

beforeEach(() => {
    stripeSpy.mockClear();
});

function makePostJson(url: string, body: unknown): NextRequest {
    return new NextRequest(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', host: 'localhost:3000' },
    });
}

describe('Billing routes — self-hosted mode', () => {
    it('checkout returns 403 billing_unavailable in self-hosted mode', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/billing/checkout/route'
        );
        const res = (await POST(
            makePostJson(
                'http://localhost/api/t/acme/billing/checkout',
                { plan: 'PRO' },
            ),
            { params: Promise.resolve({ tenantSlug: 'acme' }) } as never,
        )) as Response;
        expect(res.status).toBe(403);
        const body = (await res.json()) as {
            error?: { code?: string; message?: string; params?: Record<string, string> };
        };
        // A real code since #1679, where this was the generic `FORBIDDEN`.
        expect(body.error?.code).toBe('BILLING_UNAVAILABLE');
        expect(body.error?.params).toEqual({ mode: 'SELFHOSTED' });
        // #1677 — the message is the CATALOGUE's sentence now, in the
        // reader's language. There is no request-scoped `uiLanguage` here, so
        // `resolveRequestLocale` falls back to `bg` — which is the behaviour
        // worth pinning: the fallback must not be `DEFAULT_LOCALE` (`'en'`),
        // or a Bulgarian farmer whose claim failed to load gets English.
        //
        // This asserts the WHOLE chain in one line: the code reached the
        // envelope, the localiser found `errors.BILLING_UNAVAILABLE`, and the
        // Bulgarian came back. The legacy `billing_unavailable:` prefix is
        // gone — agrent-ios confirmed its only installed build knows the codes
        // (PR 287#issuecomment-6129859923), which is what released it.
        expect(body.error?.message).toBe(
            'Тази инсталация не предлага планове и плащания в приложението.',
        );
        expect(stripeSpy).not.toHaveBeenCalled();
    });

    it('portal returns 403 billing_unavailable in self-hosted mode', async () => {
        const { POST } = await import(
            '@/app/api/t/[tenantSlug]/billing/portal/route'
        );
        const res = (await POST(
            makePostJson(
                'http://localhost/api/t/acme/billing/portal',
                {},
            ),
            { params: Promise.resolve({ tenantSlug: 'acme' }) } as never,
        )) as Response;
        expect(res.status).toBe(403);
        const body = (await res.json()) as {
            error?: { code?: string; message?: string; params?: Record<string, string> };
        };
        // A real code since #1679, where this was the generic `FORBIDDEN`.
        expect(body.error?.code).toBe('BILLING_UNAVAILABLE');
        expect(body.error?.params).toEqual({ mode: 'SELFHOSTED' });
        // #1677 — the message is the CATALOGUE's sentence now, in the
        // reader's language. There is no request-scoped `uiLanguage` here, so
        // `resolveRequestLocale` falls back to `bg` — which is the behaviour
        // worth pinning: the fallback must not be `DEFAULT_LOCALE` (`'en'`),
        // or a Bulgarian farmer whose claim failed to load gets English.
        //
        // This asserts the WHOLE chain in one line: the code reached the
        // envelope, the localiser found `errors.BILLING_UNAVAILABLE`, and the
        // Bulgarian came back. The legacy `billing_unavailable:` prefix is
        // gone — agrent-ios confirmed its only installed build knows the codes
        // (PR 287#issuecomment-6129859923), which is what released it.
        expect(body.error?.message).toBe(
            'Тази инсталация не предлага планове и плащания в приложението.',
        );
        expect(stripeSpy).not.toHaveBeenCalled();
    });
});

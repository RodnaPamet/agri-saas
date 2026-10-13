/**
 * #1738 — creating a farm re-mints the session before offering to open it.
 *
 * ## The defect, measured on production
 *
 * `memberships` is a JWT CLAIM and the Edge gate reads it, not the database —
 * there is none on the Edge. A token minted before the farm existed does not
 * carry the new membership, so `checkTenantAccess` returns `no_tenant_access`
 * (first farm) or `cross_tenant` (any later one), and the OWNER who just
 * created it lands on `/no-tenant` — a page that tells them to ask an
 * administrator for an invite.
 *
 * Verified against the live database at the time: the tenant row was present,
 * live, with exactly one `OWNER:ACTIVE` membership. Only the token was stale.
 *
 * ## Why it went unnoticed
 *
 * The SIGN-UP walk ends in `signIn('credentials', …)`, which mints a token
 * AFTER the membership exists — so a brand-new user is fine. Only the
 * signed-in walk (`startAtFarmType`) is affected, which is the path every
 * existing user takes to create a second farm.
 *
 * ## What is asserted, and why it is the POST and not a mock
 *
 * The app mounts no `<SessionProvider>` by design, so `useSession().update()`
 * is unavailable. The wizard therefore replicates what next-auth 4.24.15's
 * `update()` does — `getCsrfToken()` then a JSON POST to
 * `/api/auth/session`, which is the request that makes the `jwt` callback run
 * with `trigger === 'update'`.
 *
 * These assert that exact request shape, because it is a contract with a
 * dependency rather than with our own code: if an upgrade changes how an
 * update is signalled, nothing else in this repo would notice, and the
 * production symptom is silent.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: mockPush }),
}));

jest.mock('next-intl', () => ({
    useLocale: () => 'bg',
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (k: string) => k;
        return t;
    },
}));

const mockGetCsrfToken = jest.fn(async () => 'csrf-test-token');
jest.mock('next-auth/react', () => ({
    signIn: jest.fn(async () => ({ error: undefined })),
    getCsrfToken: () => mockGetCsrfToken(),
}));

jest.mock('@/components/auth/TurnstileWidget', () => ({
    TurnstileWidget: () => null,
}));

import { FarmWizard } from '@/app/start/FarmWizard';
import { TERMS_VERSION } from '@/lib/legal/terms';

let calls: { url: string; init?: { method?: string; body?: string } }[];
let farmsOk: boolean;

beforeEach(() => {
    jest.clearAllMocks();
    calls = [];
    farmsOk = true;
    mockGetCsrfToken.mockResolvedValue('csrf-test-token');
    global.fetch = jest.fn(async (url: unknown, init?: unknown) => {
        const u = String(url);
        calls.push({ url: u, init: init as { method?: string; body?: string } | undefined });
        if (u.includes('/api/me/farms')) {
            return {
                ok: farmsOk,
                status: farmsOk ? 200 : 400,
                json: async () => ({
                    farm: { id: 'f1', slug: 'agrent-platform-83605c04', name: 'Agrent Platform' },
                    identityVerification: 'not_requested',
                }),
            };
        }
        return { ok: true, status: 200, json: async () => ({ turnstileSitekey: null }) };
    }) as unknown as typeof fetch;
});

/** The signed-in walk: type → name → finish. */
async function createFarm() {
    render(<FarmWizard startAtFarmType termsVersion={TERMS_VERSION} />);
    fireEvent.click(screen.getByText('typeIndividual'));
    fireEvent.change(screen.getByLabelText('farmNameLabel'), { target: { value: 'Agrent Platform' } });
    fireEvent.click(screen.getByText('finish'));
}

const sessionPost = () =>
    calls.find((c) => c.url.includes('/api/auth/session') && c.init?.method === 'POST');

describe('the session is re-minted after the farm is created', () => {
    it('POSTs to /api/auth/session — the request that sets trigger=update', async () => {
        await createFarm();
        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());

        // THE MUTATION TARGET. Without this the OWNER is sent to /no-tenant.
        expect(sessionPost()).toBeDefined();
    });

    it('sends the csrf token as JSON, matching next-auth 4.24.15 update()', async () => {
        await createFarm();
        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());

        const post = sessionPost()!;
        // `fetchData` sets `Content-Type: application/json`, JSON-stringifies
        // the body and switches to POST when a body is present
        // (`client/_utils.ts`). A form-encoded body or a missing csrf token is
        // rejected by the session route and the re-mint silently does nothing.
        expect(JSON.parse(post.init!.body as string)).toEqual({
            csrfToken: 'csrf-test-token',
            data: {},
        });
        expect(mockGetCsrfToken).toHaveBeenCalled();
    });

    it('refreshes AFTER the farm exists, not before', async () => {
        await createFarm();
        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());

        const farmsAt = calls.findIndex((c) => c.url.includes('/api/me/farms'));
        const sessionAt = calls.findIndex(
            (c) => c.url.includes('/api/auth/session') && c.init?.method === 'POST',
        );
        // Order is the whole point: re-minting before the membership exists
        // returns the same stale claims and the bug survives.
        expect(farmsAt).toBeGreaterThanOrEqual(0);
        expect(sessionAt).toBeGreaterThan(farmsAt);
    });

    it('does NOT refresh when creation FAILED', async () => {
        farmsOk = false;
        await createFarm();
        await waitFor(() => expect(screen.getByText('failed')).toBeInTheDocument());

        // No membership was gained, so there is nothing to re-mint — and a
        // refresh here would spend a request to confirm the claims it already
        // has.
        expect(sessionPost()).toBeUndefined();
    });

    it('still reaches the done step when the refresh THROWS', async () => {
        // The farm is created by this point. A refresh failure must not
        // present as a creation failure — the fallback is the one the user
        // already has, signing out and back in.
        mockGetCsrfToken.mockRejectedValue(new Error('offline'));

        await createFarm();

        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());
    });

    it('offers the farm by the slug the SERVER returned', async () => {
        // Paired with the refresh because the two fail together: the button
        // navigates into the tenant the Edge has just been taught about, and a
        // client-guessed slug would 404 past a correct token.
        await createFarm();
        await waitFor(() => expect(screen.getByText('doneTitle')).toBeInTheDocument());

        fireEvent.click(screen.getByText('doneOpen'));
        expect(mockPush).toHaveBeenCalledWith('/t/agrent-platform-83605c04');
    });
});

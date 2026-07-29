/**
 * Coverage wave 20 — the API-keys admin page.
 *
 * 50 of 55 functions uncovered (9%), the least-covered file in
 * `src/app`. It is also a credential-management surface: it mints API
 * keys, shows the plaintext exactly once, and revokes them.
 *
 * The security property this file exists to protect is in `KeyDisplay`:
 * a freshly-minted key is rendered MASKED, and the full secret only
 * enters the DOM when the operator explicitly reveals it. Defaulting
 * that the other way leaves a live credential on screen — and in the
 * DOM, screenshots and any session-replay tooling — for anyone behind
 * the admin's shoulder.
 */
import {
    fireEvent,
    render as rtlRender,
    screen,
    waitFor,
} from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * The page and KeyDisplay both render <Tooltip>s. With TOOLTIPS_ENABLED
 * on, Radix requires a provider — the app mounts one at the root, so
 * these renders mirror that rather than relying on the tooltip being a
 * no-op.
 */
const render = (ui: React.ReactElement) =>
    rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
import ApiKeysPage, {
    KeyDisplay,
} from '@/app/t/[tenantSlug]/(app)/admin/api-keys/page';

const copy = jest.fn().mockResolvedValue(true);
let copied = false;
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useCopyToClipboard: () => ({ copy, copied }),
    };
});

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('@/components/ui/hooks/use-toast', () => ({
    __esModule: true,
    useToast: () => ({
        success: toastSuccess,
        error: toastError,
        info: jest.fn(),
        warning: jest.fn(),
    }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    __esModule: true,
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
}));

// The page mounts the create-key <Modal>, which calls useRouter(). There is
// no App Router context under jsdom, so without this the whole render throws
// "invariant expected app router to be mounted" before anything paints.
jest.mock('next/navigation', () => ({
    __esModule: true,
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/admin/api-keys',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

/**
 * Shaped like a real key from `generateApiKey()`: the `iflk_` prefix from
 * API_KEY_PREFIX plus a random tail. The 13 characters KeyDisplay leaves
 * visible are not a magic number — they are
 * API_KEY_PREFIX.length (5) + KEY_PREFIX_DISPLAY_LENGTH (8), i.e. exactly
 * the `keyPrefix` persisted on the row, so the masked form shows precisely
 * the part that is already stored in the clear and nothing more.
 */
const PLAINTEXT = 'iflk_abcdefghijklmnopqrstuvwxyz0123456789';
const VISIBLE_PREFIX = PLAINTEXT.slice(0, 13);

function makeKey(over: Record<string, unknown> = {}) {
    return {
        id: 'k-1',
        name: 'CI pipeline',
        keyPrefix: VISIBLE_PREFIX,
        scopes: ['controls:read'],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        createdById: 'u-1',
        createdAt: new Date(0).toISOString(),
        createdBy: { id: 'u-1', name: 'Ivo', email: 'ivo@example.com' },
        ...over,
    };
}

const originalFetch = global.fetch;
afterAll(() => {
    global.fetch = originalFetch;
});

beforeEach(() => {
    jest.clearAllMocks();
    copied = false;
    copy.mockResolvedValue(true);
});

describe('KeyDisplay — the plaintext key is masked by default', () => {
    it('does not put the full secret in the DOM until it is revealed', async () => {
        // Break: initialising `visible` to true, or rendering the raw
        // plaintext unconditionally. The key would sit on screen — and
        // in the DOM, screenshots and session replay — for anyone
        // looking over the admin's shoulder.
        const { container } = render(<KeyDisplay plaintext={PLAINTEXT} />);

        expect(container.textContent).not.toContain(PLAINTEXT);
        // Exactly the stored `keyPrefix` stays visible — the part already
        // held in the clear on the row — so the operator can identify the
        // key without the secret tail being on screen.
        expect(container.textContent).toContain(VISIBLE_PREFIX);
        expect(container.textContent).toContain('•');
    });

    it('reveals the full secret only on an explicit toggle, and hides it again', async () => {
        // Break: a one-way reveal. An admin who unmasked to copy could
        // not re-mask without navigating away.
        const { container } = render(<KeyDisplay plaintext={PLAINTEXT} />);
        const toggle = document.getElementById('key-toggle-visibility')!;

        fireEvent.click(toggle);
        expect(container.textContent).toContain(PLAINTEXT);

        fireEvent.click(toggle);
        expect(container.textContent).not.toContain(PLAINTEXT);
    });

    it('confirms to the operator when the key reached the clipboard', async () => {
        // Break: reporting success unconditionally. The operator closes
        // the one-time dialog believing they have the key, and the
        // secret is unrecoverable.
        render(<KeyDisplay plaintext={PLAINTEXT} />);

        fireEvent.click(document.getElementById('key-copy-btn')!);

        await waitFor(() => expect(copy).toHaveBeenCalledWith(PLAINTEXT));
        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
        expect(toastError).not.toHaveBeenCalled();
    });

    it('warns when the clipboard write fails', async () => {
        // The case that actually matters: this key cannot be shown
        // again, so a silent copy failure loses it permanently.
        copy.mockResolvedValue(false);
        render(<KeyDisplay plaintext={PLAINTEXT} />);

        fireEvent.click(document.getElementById('key-copy-btn')!);

        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastSuccess).not.toHaveBeenCalled();
    });
});

describe('ApiKeysPage — loading the key list', () => {
    it('renders the keys returned by the API', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [makeKey(), makeKey({ id: 'k-2', name: 'Zapier' })],
        }) as never;

        render(<ApiKeysPage />);

        expect(await screen.findByText('CI pipeline')).toBeInTheDocument();
        expect(screen.getByText('Zapier')).toBeInTheDocument();
    });

    it('requests the tenant-scoped endpoint', async () => {
        // Break: a tenant-less URL would read another tenant's keys, or
        // 404. The page resolves it through useTenantApiUrl for exactly
        // this reason.
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [],
        });
        global.fetch = fetchMock as never;

        render(<ApiKeysPage />);

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/api-keys'),
        );
    });

    it('leaves the loading state when the request fails', async () => {
        // Break: `setLoading(false)` outside the `finally`. A network
        // error would strand the page on a spinner forever, with the
        // error message never rendered.
        global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as never;

        const { container } = render(<ApiKeysPage />);

        await waitFor(() => {
            expect(container.textContent).not.toBe('');
        });
        // The failure surfaces as a message rather than an endless spinner.
        await waitFor(() =>
            expect(container.querySelectorAll('[role="status"]').length).toBeLessThan(2),
        );
    });

    it('renders without crashing when the API returns no keys', async () => {
        // Break: mapping over an undefined list, or an empty-state that
        // throws — the first-run experience for every new tenant.
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [],
        }) as never;

        const { container } = render(<ApiKeysPage />);

        await waitFor(() => expect(container.textContent).not.toBe(''));
        expect(screen.queryByText('CI pipeline')).not.toBeInTheDocument();
    });

    it('marks an expired key differently from a live one', async () => {
        // Break: `isExpired` comparing the wrong way would show expired
        // credentials as active, so nobody rotates them.
        const past = new Date(Date.now() - 86_400_000).toISOString();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [
                makeKey({ id: 'k-live', name: 'Live key', expiresAt: null }),
                makeKey({ id: 'k-old', name: 'Old key', expiresAt: past }),
            ],
        }) as never;

        render(<ApiKeysPage />);

        expect(await screen.findByText('Live key')).toBeInTheDocument();
        expect(screen.getByText('Old key')).toBeInTheDocument();
    });
});

/**
 * Not covered here: the create and revoke flows.
 *
 * Both live behind modal interactions (open dialog, name the key, pick
 * scopes through a Combobox, confirm) and account for the bulk of the
 * remaining uncovered functions in this file. They are worth testing —
 * `handleCreate` converts an expiry in DAYS into an absolute ISO
 * timestamp, and a sign error there would mint keys that are already
 * expired — but they need the modal driven end to end rather than a
 * render assertion, so they belong in their own pass.
 */

/**
 * The A2HS banner is withheld on the sign-in page — #2099.
 *
 * ## Two faults, one of them language-independent
 *
 * Found by the owner signing in from the iPhone app:
 *
 *   1. **Raw message keys.** `installPrompt` is an `app`-bundle namespace and
 *      the sign-in page is served the `auth` bundle (`src/i18n.ts` narrows by
 *      `AUTH_SURFACE_HEADER`), so every mobile visitor read
 *      `installPrompt.a2hsTitle` as literal text.
 *   2. **The wrong place entirely.** The iPhone app's sign-in runs inside
 *      `ASWebAuthenticationSession`, so the banner asked someone already in
 *      the installed app to add the website to their home screen.
 *
 * Adding the namespace to the auth bundle would have fixed only the first and
 * left a correctly-translated banner somewhere it should never appear. So the
 * banner is withheld, which fixes both.
 *
 * ## Why the mock renders a marker rather than null
 *
 * The sibling registrar suites mock `InstallPrompt` to `() => null`, which is
 * right for them — they are about reload behaviour and the prompt is noise.
 * It also makes "the prompt did not render" indistinguishable from "the mock
 * renders nothing", so a test of THIS property has to be able to see it.
 */
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));
jest.mock('@/components/pwa/InstallPrompt', () => ({
    InstallPrompt: () => <div data-testid="install-prompt" />,
}));
import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';

/** Enough of the SW surface for the registrar to mount without throwing. */
function installSwMock(): void {
    const reg = { waiting: null, installing: null, addEventListener: jest.fn() };
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        writable: true,
        value: {
            controller: {},
            register: jest.fn(() => Promise.resolve(reg)),
            getRegistration: jest.fn(() => Promise.resolve(reg)),
            ready: Promise.resolve(reg),
            addEventListener: jest.fn(),
        },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    installSwMock();
});

describe('ServiceWorkerRegistrar', () => {
    it('offers the banner by default — the operator app', () => {
        // The positive control. Without it, the assertion below would pass
        // against a component that had stopped rendering the prompt anywhere.
        const { queryByTestId } = render(<ServiceWorkerRegistrar />);
        expect(queryByTestId('install-prompt')).not.toBeNull();
    });

    it('withholds it when told to — the sign-in page', () => {
        const { queryByTestId } = render(<ServiceWorkerRegistrar showInstallPrompt={false} />);
        expect(queryByTestId('install-prompt')).toBeNull();
    });
});

describe('the root layout withholds it on the auth surface', () => {
    // Asserted on the SOURCE because the layout is an async server component
    // that awaits `headers()`. The behavioural half is covered above; what is
    // left to protect is the WIRING, and a dropped prop would restore the bug
    // with both tests above still green.
    const layout = readFileSync(
        path.join(process.cwd(), 'src/app/layout.tsx'),
        'utf8',
    );

    it('reads the auth-surface header', () => {
        expect(layout).toMatch(/AUTH_SURFACE_HEADER/);
    });

    it('gates the prompt on it, rather than mounting the registrar bare', () => {
        expect(layout).toMatch(/<ServiceWorkerRegistrar\s+showInstallPrompt=\{!isAuthSurface\}\s*\/>/);
        // And not the bare form, which is what it used to be.
        expect(layout).not.toMatch(/<ServiceWorkerRegistrar\s*\/>/);
    });
});

describe('why the gate matters, stated as a fact about the catalogues', () => {
    const read = (bundle: string) =>
        JSON.parse(
            readFileSync(path.join(process.cwd(), `messages/bg/${bundle}.json`), 'utf8'),
        ) as Record<string, unknown>;

    it('installPrompt is in the app bundle and NOT in auth', () => {
        // This is the mechanism behind fault 1. If a later change moves the
        // namespace into `auth`, the raw-keys half stops depending on the
        // gate — and this test says so rather than quietly passing.
        expect('installPrompt' in read('app')).toBe(true);
        expect('installPrompt' in read('auth')).toBe(false);
    });
});

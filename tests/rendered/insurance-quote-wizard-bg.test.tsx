/**
 * @jest-environment jsdom
 *
 * The calculator in Bulgarian (#1120).
 *
 * A separate file rather than a case in `insurance-quote-wizard.test.tsx`: the
 * project-wide next-intl mock in `tests/rendered/setup.ts` resolves
 * `messages/en.json` and one jest module registry cannot hold two catalogues.
 * A test-file factory wins over the setup one, so this file swaps in `bg.json`.
 *
 * Bulgarian is the app's DEFAULT locale, so this is the screen most farmers
 * actually see — English is the fallback, not the main case.
 */
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import bgMessages from '../../messages/bg.json';
import { restoreViewport } from './viewport';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/farm-risk',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

// Bulgarian catalogue, with just enough ICU for these screens: `{var}`
// interpolation and the `other` branch of a plural.
jest.mock('next-intl', () => {
    const bg = require('../../messages/bg.json');
    const get = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
            bg,
        );
    const format = (msg: string, values: Record<string, unknown>) => {
        let out = msg.replace(
            /\{(\w+),\s*plural,[^]*?other\s*\{([^{}]*)\}\s*\}/g,
            (_m, v, branch) => String(branch).replace(/#/g, String(values[v])),
        );
        return out.replace(/\{(\w+)\}/g, (_m, k) =>
            values[k] != null ? String(values[k]) : `{${k}}`,
        );
    };
    const makeT = (ns?: string) => {
        const full = (k: string) => (ns ? `${ns}.${k}` : k);
        const t = (k: string, values?: Record<string, unknown>) => {
            const msg = get(full(k));
            if (typeof msg !== 'string') return full(k);
            return msg.includes('{') ? format(msg, values ?? {}) : msg;
        };
        t.has = (k: string) => typeof get(full(k)) === 'string';
        t.rich = (k: string) => String(get(full(k)) ?? full(k));
        t.markup = (k: string) => full(k);
        t.raw = (k: string) => get(full(k));
        return t;
    };
    const PassThrough = ({ children }: { children?: unknown }) => children;
    return {
        useTranslations: (ns?: string) => makeT(ns),
        useFormatter: () => ({ number: String, dateTime: String, relativeTime: String }),
        useLocale: () => 'bg',
        useNow: () => new Date(0),
        useTimeZone: () => 'UTC',
        useMessages: () => bg,
        NextIntlClientProvider: PassThrough,
        IntlProvider: PassThrough,
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantName: 'Acme', tenantSlug: 'acme', currencySymbol: '€' }),
    useTenantCurrencySymbol: () => '€',
}));

const apiPost = jest.fn();
jest.mock('@/lib/api-client', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ success: jest.fn(), info: jest.fn(), warning: jest.fn(), error: jest.fn() }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AskInsuranceModal } from '@/app/t/[tenantSlug]/(app)/farm-risk/AskInsuranceModal';

const ASK = bgMessages.ag.risk.ask;
const QUOTE = bgMessages.ag.risk.quote;
const PRODUCTS = bgMessages.insurance.products;
const el = (id: string) => document.getElementById(id) as HTMLElement;

afterEach(() => {
    restoreViewport();
    cleanup();
    jest.clearAllMocks();
});

beforeEach(() => {
    apiPost.mockReset().mockResolvedValue({ id: 'lead-1', status: 'PENDING' });
});

describe('the calculator in Bulgarian', () => {
    it('keeps the button label the product owner already had', () => {
        render(
            <TooltipProvider delayDuration={0}>
                <AskInsuranceModal
                    parcelId="p1" locationId="l1" parcelName="Северен блок"
                    risk={null} cropType="Пшеница" areaHa={100}
                    hasRequested={false} onRequested={jest.fn()}
                />
            </TooltipProvider>,
        );
        // The English label was renamed TO match this one; Bulgarian is unchanged.
        expect(screen.getByRole('button', { name: 'Поискай застрахователна оферта' })).toBeInTheDocument();
        expect(ASK.open).toBe('Поискай застрахователна оферта');
    });

    it('walks all three steps in Bulgarian and reaches the same premium', async () => {
        render(
            <TooltipProvider delayDuration={0}>
                <AskInsuranceModal
                    parcelId="p1" locationId="l1" parcelName="Северен блок"
                    risk={null} cropType="Пшеница" areaHa={100}
                    hasRequested={false} onRequested={jest.fn()}
                />
            </TooltipProvider>,
        );
        await userEvent.click(screen.getByRole('button', { name: ASK.open }));

        // Step 1 — the Bulgarian crop name preselects wheat through the shared
        // alias table, exactly as the English spelling does.
        expect(await screen.findByText(QUOTE.step1Title)).toBeInTheDocument();
        expect(screen.getByText(PRODUCTS.wheat.name)).toBeInTheDocument();
        expect(el('insurance-quote-product-wheat')).toHaveAttribute('data-state', 'checked');

        await userEvent.click(screen.getByTestId('wizard-next'));
        expect(await screen.findByText(QUOTE.step2Title)).toBeInTheDocument();
        // Декари, not hectares.
        expect(el('insurance-quote-area')).toHaveValue('1000');
        expect(screen.getByText(QUOTE.sumModeTotal)).toBeInTheDocument();
        expect(screen.getByText(QUOTE.sumModePerDca)).toBeInTheDocument();

        await userEvent.type(el('insurance-quote-sum'), '100 000');
        await waitFor(() => expect(screen.getByTestId('wizard-next')).toBeEnabled());
        await userEvent.click(screen.getByTestId('wizard-next'));

        // Step 3 — the premium is currency-formatted the same way; only the
        // words change.
        expect(await screen.findByText(QUOTE.step3Title)).toBeInTheDocument();
        expect(el('insurance-quote-premium')).toHaveTextContent('€10,000.00');
        expect(screen.getByText(QUOTE.premiumLabel)).toBeInTheDocument();
        expect(screen.getByText(QUOTE.disclaimer)).toBeInTheDocument();
        expect(screen.getByText(QUOTE.instalmentsOnce)).toBeInTheDocument();
        // The send label is the existing Bulgarian one, not new copy.
        expect(screen.getByTestId('wizard-finish')).toHaveTextContent(ASK.submit);
    });
});

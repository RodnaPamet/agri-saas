/** @jest-environment jsdom */
/**
 * Trends page client shell — Prices only (News was decoupled into its own
 * `/news` destination). The Prices tab body is stubbed; this test pins that the
 * shell renders the heading + Prices content and no longer mounts a tab bar.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => ({
    // P2.1c — `useLocale` is part of this module and these mocks did not
    // provide it, so the first component to call it threw
    // "useLocale is not a function". The mock was incomplete relative to the
    // module, not wrong about this suite: `useDateFormat()` needs the active
    // locale, and a partial barrel mock turns a new dependency into a crash
    // across every suite that stubs it.
    useLocale: () => 'en',
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/components/trends/PricesTab', () => ({
    PricesTab: () => <div data-testid="prices-tab-body" />,
}));

import { TrendsPageClient } from '@/components/trends/TrendsPageClient';

describe('TrendsPageClient', () => {
    it('renders the heading + Prices content', () => {
        render(<TrendsPageClient />);
        expect(screen.getByRole('heading', { name: 'title' })).toBeInTheDocument();
        expect(screen.getByTestId('prices-tab-body')).toBeInTheDocument();
    });

    it('no longer renders a tab bar (News moved to its own page)', () => {
        render(<TrendsPageClient />);
        expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    });
});

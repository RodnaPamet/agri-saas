/** @jest-environment jsdom */
/**
 * News page client shell — the standalone destination (its own nav button +
 * `/news` route). The NewsTab feed is stubbed; this test pins that the shell
 * renders the heading + the feed.
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

jest.mock('@/components/trends/NewsTab', () => ({
    NewsTab: () => <div data-testid="news-tab-body" />,
}));

import { NewsPageClient } from '@/components/trends/NewsPageClient';

describe('NewsPageClient', () => {
    it('renders the heading + News feed', () => {
        render(<NewsPageClient />);
        expect(screen.getByRole('heading', { name: 'news.pageTitle' })).toBeInTheDocument();
        expect(screen.getByTestId('news-tab-body')).toBeInTheDocument();
    });
});

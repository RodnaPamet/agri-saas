/** @jest-environment jsdom */
/**
 * Trends → News tab — card feed rendering + attribution-first click-through.
 *
 * Asserts each card links OUT to the publisher in a new tab (href = article
 * url, target=_blank, rel=noopener noreferrer), that the source + attribution
 * render, and that the unconfigured empty state surfaces the operator hint.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

const useTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => useTenantSWR(...args),
}));

import { NewsTab } from '@/components/trends/NewsTab';

const PAGE = {
    items: [
        {
            id: 'n1',
            feedSource: 'АГРО.БГ',
            title: 'Пшеницата поскъпва',
            snippet: 'Кратко резюме на новината.',
            url: 'https://www.agro.bg/article/1',
            imageUrl: 'https://www.agro.bg/img/1.webp',
            publishedAt: '2026-07-14T13:54:00.000Z',
        },
        {
            id: 'n2',
            feedSource: 'Agrozona.bg',
            title: 'Субсидиите стартират',
            snippet: '',
            url: 'https://agrozona.bg/news/2',
            imageUrl: null,
            publishedAt: '2026-07-13T05:00:00.000Z',
        },
    ],
    nextCursor: null,
};

describe('NewsTab', () => {
    beforeEach(() => useTenantSWR.mockReset());

    it('renders a card per item, each linking OUT to the publisher in a new tab', () => {
        useTenantSWR.mockReturnValue({ data: PAGE, error: undefined, mutate: jest.fn() });
        render(<NewsTab newsConfigured />);

        const cards = screen.getAllByTestId('news-card');
        expect(cards).toHaveLength(2);

        // Title (heading) + source badge render.
        expect(
            screen.getByRole('heading', { name: 'Пшеницата поскъпва' }),
        ).toBeInTheDocument();
        expect(screen.getByText('АГРО.БГ')).toBeInTheDocument();

        // Whole-card stretched link → publisher url, new tab, safe rel.
        const links = screen.getAllByRole('link');
        const first = links.find(
            (a) => a.getAttribute('href') === 'https://www.agro.bg/article/1',
        );
        expect(first).toBeDefined();
        expect(first).toHaveAttribute('target', '_blank');
        expect(first).toHaveAttribute('rel', 'noopener noreferrer');

        // Attribution footer names both sources.
        expect(screen.getByTestId('news-attribution')).toBeInTheDocument();
    });

    it('shows the operator hint on the empty unconfigured state', () => {
        useTenantSWR.mockReturnValue({
            data: { items: [], nextCursor: null },
            error: undefined,
            mutate: jest.fn(),
        });
        render(<NewsTab newsConfigured={false} />);
        expect(screen.getByTestId('news-empty')).toBeInTheDocument();
        expect(screen.getByTestId('news-operator-hint')).toBeInTheDocument();
    });

    it('renders the loading skeleton before data arrives', () => {
        useTenantSWR.mockReturnValue({ data: undefined, error: undefined, mutate: jest.fn() });
        render(<NewsTab newsConfigured />);
        expect(screen.getByTestId('news-loading')).toBeInTheDocument();
    });
});

/** @jest-environment jsdom */
/**
 * Trends → News tab. Pins the states (loading / empty+operator / no-matches /
 * ready), the category-filter refetch, the LIVE keyword search, and the "For
 * You" tab (interest-keyword filtering + the no-interests prompt that opens the
 * editor modal). The InterestsModal is stubbed; SWR is mocked per key so the
 * news feed and the interests read can be driven independently.
 */
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/components/trends/InterestsModal', () => ({
    InterestsModal: ({ open }: { open: boolean }) =>
        open ? <div data-testid="interests-modal" /> : null,
}));

const useTenantSWR = jest.fn();
// The operator-configuration hint names environment variables, so it is
// gated on an admin permission. Mocked per the house pattern (see
// market-trends-widget.test.tsx) — these tabs always render inside a
// TenantProvider in production, but they are mounted bare here.
let mockIsAdmin = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => ({ admin: { manage: mockIsAdmin } }),
}));

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => useTenantSWR(...args),
}));

import { NewsTab } from '@/components/trends/NewsTab';

const item = (over: Record<string, unknown> = {}) => ({
    id: 'n1',
    source: 'agri-bg',
    category: 'market',
    title: 'Цената на пшеницата се покачва',
    summary: 'Пазарен обзор за седмицата.',
    url: 'https://agri.bg/news/1',
    imageUrl: null,
    publishedAt: '2026-07-14T09:30:00.000Z',
    ...over,
});

const twoItems = {
    data: {
        category: 'all',
        items: [
            item(),
            item({ id: 'n2', title: 'Субсидии по ДФЗ', summary: 'Директни плащания', category: 'policy', url: 'https://x/2' }),
        ],
    },
    error: undefined,
};

/** Drive the two SWR reads independently: news feed + /me/interests. */
function mockSWR(news: unknown, interests?: string[]) {
    useTenantSWR.mockImplementation((key: unknown) => {
        if (typeof key === 'string' && key.includes('/me/interests')) {
            return {
                data: interests === undefined ? undefined : { keywords: interests },
                error: undefined,
                mutate: jest.fn(),
            };
        }
        if (!key) return { data: undefined, error: undefined, mutate: jest.fn() };
        return news;
    });
}

beforeEach(() => useTenantSWR.mockReset());

describe('NewsTab', () => {
    it('defaults to the All feed and renders a card per item', () => {
        mockSWR(twoItems);
        render(<NewsTab />);
        expect(screen.getByText('Цената на пшеницата се покачва')).toBeInTheDocument();
        expect(screen.getByText('Субсидии по ДФЗ')).toBeInTheDocument();
        expect(useTenantSWR).toHaveBeenCalledWith('/trends/news?category=all');
    });

    it('renders the combined empty + operator hint when the feed is empty', () => {
        mockSWR({ data: { category: 'all', items: [] }, error: undefined });
        render(<NewsTab />);
        expect(screen.getByTestId('trends-news-empty')).toBeInTheDocument();
        expect(screen.getByTestId('trends-news-operator-hint')).toBeInTheDocument();
    });

    it('refetches with the category on a filter click', () => {
        mockSWR({ data: { category: 'all', items: [] }, error: undefined });
        render(<NewsTab />);
        fireEvent.click(screen.getByRole('tab', { name: 'news.filters.policy' }));
        expect(useTenantSWR).toHaveBeenCalledWith('/trends/news?category=policy');
    });

    it('filters the visible cards LIVE as the user types', () => {
        mockSWR(twoItems);
        render(<NewsTab />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'пшеницата' } });
        expect(screen.getByText('Цената на пшеницата се покачва')).toBeInTheDocument();
        expect(screen.queryByText('Субсидии по ДФЗ')).not.toBeInTheDocument();
    });

    it('shows a no-matches state when the search matches nothing', () => {
        mockSWR(twoItems);
        render(<NewsTab />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzznotfound' } });
        expect(screen.getByTestId('trends-news-no-matches')).toBeInTheDocument();
    });

    describe('For You tab', () => {
        it('filters the feed to items matching the user\'s interest keywords', () => {
            mockSWR(twoItems, ['пшеница']);
            render(<NewsTab />);
            fireEvent.click(screen.getByRole('tab', { name: 'news.filters.foryou' }));
            // For You reads the full (all) feed + interests.
            expect(useTenantSWR).toHaveBeenCalledWith('/me/interests');
            // Only the wheat item matches the "пшеница" interest.
            expect(screen.getByText('Цената на пшеницата се покачва')).toBeInTheDocument();
            expect(screen.queryByText('Субсидии по ДФЗ')).not.toBeInTheDocument();
            // Interest count + edit affordance.
            expect(screen.getByText('news.forYou.count')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'news.forYou.edit' })).toBeInTheDocument();
        });

        it('prompts to add interests (and opens the modal) when none are set', () => {
            mockSWR(twoItems, []);
            render(<NewsTab />);
            fireEvent.click(screen.getByRole('tab', { name: 'news.filters.foryou' }));
            expect(screen.getByTestId('trends-news-no-interests')).toBeInTheDocument();
            expect(screen.queryByTestId('interests-modal')).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'news.forYou.addFirst' }));
            expect(screen.getByTestId('interests-modal')).toBeInTheDocument();
        });
    });
});

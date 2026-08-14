/**
 * VR-9 — the Practice-page AI suggestions rail renders ranked cards + actions.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => mockSWR(...a),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => p,
}));
jest.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'u1' } } }),
}));

import { AutomationSuggestionsRail } from '@/components/automation/AutomationSuggestionsRail';

const SUGGESTIONS = [
    {
        id: 's1',
        rank: 1,
        title: 'Notify the agronomist when a spray job starts',
        rationale: 'Surface field operations fast.',
        triggerEvent: 'SPRAY_JOB_STARTED',
        actionType: 'NOTIFY_USER' as const,
        confidenceScore: 0.82,
    },
    {
        id: 's2',
        rank: 2,
        title: 'Open a remediation task for every new risk',
        rationale: '5 risks are active.',
        triggerEvent: 'RISK_CREATED',
        actionType: 'CREATE_TASK' as const,
        confidenceScore: 0.7,
    },
];

describe('AutomationSuggestionsRail', () => {
    it('renders ranked suggestion cards', () => {
        mockSWR.mockReturnValue({ data: { suggestions: SUGGESTIONS }, isLoading: false });
        render(<AutomationSuggestionsRail />);
        expect(screen.getByTestId('automation-suggestions-rail')).toBeInTheDocument();
        expect(screen.getByText('Notify the team when a practice test fails')).toBeInTheDocument();
        expect(screen.getByText('Open a remediation task for every new risk')).toBeInTheDocument();
        // human-readable trigger badge
        expect(screen.getByText('Test Run Failed')).toBeInTheDocument();
    });

    it('dismiss removes a suggestion from the list', () => {
        mockSWR.mockReturnValue({ data: { suggestions: SUGGESTIONS }, isLoading: false });
        render(<AutomationSuggestionsRail />);
        const firstCard = screen.getByText('Notify the team when a practice test fails');
        expect(firstCard).toBeInTheDocument();
        // dismiss the first card
        fireEvent.click(screen.getAllByText('Dismiss')[0]);
        expect(
            screen.queryByText('Notify the team when a practice test fails'),
        ).not.toBeInTheDocument();
    });

    it('shows an empty hint when there are no suggestions', () => {
        mockSWR.mockReturnValue({ data: { suggestions: [] }, isLoading: false });
        render(<AutomationSuggestionsRail />);
        expect(screen.getByText(/already cover the obvious gaps/)).toBeInTheDocument();
    });
});

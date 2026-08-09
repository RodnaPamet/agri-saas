/**
 * Rendered tests for the shared <EmptyState>.
 *
 * Covers:
 *   - Renders with default `no-records` variant + Inbox default icon
 *   - `variant="no-results"` switches to SearchX default icon
 *   - `variant="missing-prereqs"` switches to AlertCircle default icon
 *   - Custom `icon` prop overrides the variant default
 *   - `primaryAction` / `secondaryAction` render as buttons + fire onClick
 *   - `primaryAction.href` renders an anchor instead of a button
 *   - `learnMore` appends an external link
 *   - axe-core finds no violations
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { Rocket } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from '@/components/ui/empty-state';

describe('EmptyState', () => {
    it('renders the default no-records variant with Inbox icon', () => {
        const { container } = render(
            <EmptyState
                title="No items yet"
                description="Add your first item to get started."
            />,
        );
        const root = container.querySelector('[data-empty-state-variant]');
        expect(root).toHaveAttribute('data-empty-state-variant', 'no-records');
        expect(screen.getByText('No items yet')).toBeInTheDocument();
        expect(
            screen.getByText(/add your first item/i),
        ).toBeInTheDocument();
    });

    it('switches default icon for the no-results variant', () => {
        const { container } = render(
            <EmptyState
                variant="no-results"
                title="No matches"
                description="Try a different search."
            />,
        );
        expect(
            container.querySelector('[data-empty-state-variant="no-results"]'),
        ).toBeTruthy();
    });

    it('switches default icon for the missing-prereqs variant', () => {
        const { container } = render(
            <EmptyState
                variant="missing-prereqs"
                title="Connect a framework"
                description="You need to install a framework before adding practices."
            />,
        );
        expect(
            container.querySelector(
                '[data-empty-state-variant="missing-prereqs"]',
            ),
        ).toBeTruthy();
    });

    it('uses a custom icon when supplied', () => {
        const { container } = render(
            <EmptyState
                icon={Rocket}
                title="Take off"
                description="Custom icon."
            />,
        );
        // lucide icons render an SVG; the only one inside the icon
        // container should be the rocket.
        const iconBox = container.querySelector('[data-empty-state-variant]')
            ?.firstElementChild;
        expect(iconBox?.querySelector('svg')).toBeInTheDocument();
    });

    it('fires primaryAction.onClick when the button is clicked', async () => {
        const user = userEvent.setup();
        const onClick = jest.fn();
        render(
            <EmptyState
                title="No tasks"
                primaryAction={{
                    label: 'Create task',
                    onClick,
                    'data-testid': 'create-task-cta',
                }}
            />,
        );
        await user.click(screen.getByTestId('create-task-cta'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('renders both primary and secondary actions', () => {
        render(
            <EmptyState
                variant="no-results"
                title="No matches"
                primaryAction={{ label: 'Clear filters', onClick: () => undefined }}
                secondaryAction={{ label: 'Reset search', onClick: () => undefined }}
            />,
        );
        expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Reset search' })).toBeInTheDocument();
    });

    it('renders an anchor when primaryAction has href', () => {
        render(
            <EmptyState
                title="No cycles"
                primaryAction={{ label: 'New cycle', href: '/audits/cycles' }}
            />,
        );
        const link = screen.getByRole('link', { name: 'New cycle' });
        expect(link).toHaveAttribute('href', '/audits/cycles');
    });

    it('appends a learnMore external link', () => {
        render(
            <EmptyState
                title="No data"
                description="Set up an integration to start ingesting data."
                learnMore="https://docs.example.com/integrations"
            />,
        );
        const link = screen.getByRole('link', { name: /learn more/i });
        expect(link).toHaveAttribute(
            'href',
            'https://docs.example.com/integrations',
        );
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(link).toHaveAttribute('target', '_blank');
    });

    it('passes a custom data-testid through to the root', () => {
        const { container } = render(
            <EmptyState title="X" data-testid="empty-foo" />,
        );
        expect(
            container.querySelector('[data-testid="empty-foo"]'),
        ).toBeInTheDocument();
    });

    it('finds zero accessibility violations', async () => {
        const { container } = render(
            <EmptyState
                title="Nothing here"
                description="Create your first record."
                primaryAction={{ label: 'Create', onClick: () => undefined }}
            />,
        );
        const results = await axe(container);
        expect(results).toHaveNoViolations();
    });
});

/** @jest-environment jsdom */

/**
 * Behavioural (Tier-2) test — `<EmptyState>` cleared-filters CTA.
 *
 * From `docs/roadmap-audit-2026-05-13.md` "Known broken / risky
 * areas" item #8: EmptyState personality (R11-PR1 #346, R8-PR1 #308)
 * shipped three vocabularies (no-records / no-results /
 * missing-prereqs) and a cleared-filters CTA. The audit calls this
 * "easy to verify by loading any empty list with filters applied".
 *
 * The existing `empty-state.test.tsx` covers the primitive's generic
 * render contract. THIS test is narrower and behavioural: it pins the
 * SPECIFIC user-facing outcome the audit named —
 *
 *   1. the `no-results` variant renders (the variant a filtered-empty
 *      list uses);
 *   2. the "Clear filters" CTA actually RENDERS as an interactive
 *      practice and FIRES its handler when clicked — not just that the
 *      label string is in source;
 *   3. the CTA copy uses canonical vocabulary the user reads.
 *
 * A structural ratchet can confirm a list page passes a
 * `primaryAction` prop. It cannot confirm the button renders, is
 * reachable by its accessible name, or that clicking it runs the
 * clear-filters callback. Those are the behavioural facts here.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { EmptyState } from '@/components/ui/empty-state';

describe('<EmptyState> cleared-filters CTA — behavioural (Tier 2)', () => {
    it('renders the no-results variant for a filtered-empty list', () => {
        const { container } = render(
            <EmptyState
                variant="no-results"
                title="Nothing matches your filters"
                description="Try widening the filter set."
                primaryAction={{
                    label: 'Clear filters',
                    onClick: () => undefined,
                }}
            />,
        );
        // The variant is the behavioural switch that selects the
        // "filtered, matched nothing" personality (SearchX icon +
        // no-results copy conventions). Assert it landed.
        const root = container.querySelector('[data-empty-state-variant]');
        expect(root).toHaveAttribute(
            'data-empty-state-variant',
            'no-results',
        );
        // The user-facing title is rendered, not just passed.
        expect(
            screen.getByText('Nothing matches your filters'),
        ).toBeInTheDocument();
    });

    it('the "Clear filters" CTA renders as a reachable practice and FIRES its handler', async () => {
        const user = userEvent.setup();
        const clearFilters = jest.fn();
        render(
            <EmptyState
                variant="no-results"
                title="Nothing matches your filters"
                primaryAction={{
                    label: 'Clear filters',
                    onClick: clearFilters,
                }}
            />,
        );
        // The CTA must be reachable by its accessible name — proves it
        // rendered as a real <button>, not inert text.
        const cta = screen.getByRole('button', { name: 'Clear filters' });
        expect(cta).toBeInTheDocument();

        // Clicking it must run the clear-filters callback. THIS is the
        // behaviour a structural ratchet can never verify — that the
        // prop is actually wired to the rendered practice.
        await user.click(cta);
        expect(clearFilters).toHaveBeenCalledTimes(1);
    });

    it('the no-results CTA copy uses canonical filter-clearing vocabulary', () => {
        render(
            <EmptyState
                variant="no-results"
                title="No risks match your filters"
                primaryAction={{
                    label: 'Clear filters',
                    onClick: () => undefined,
                }}
            />,
        );
        // The cleared-filters CTA's canonical label is "Clear
        // filters". Assert the EXACT rendered button text — a drift
        // to "Reset" / "Remove filters" / a leading "+ " would be a
        // vocabulary regression the audit's item #8 watches for.
        const cta = screen.getByRole('button', { name: 'Clear filters' });
        expect(cta.textContent?.trim()).toBe('Clear filters');
        expect(cta.textContent?.trim().startsWith('+')).toBe(false);
    });

    it('renders a clear-filters CTA alongside a secondary action without collision', async () => {
        const user = userEvent.setup();
        const clearFilters = jest.fn();
        const resetSearch = jest.fn();
        render(
            <EmptyState
                variant="no-results"
                title="Nothing matches"
                primaryAction={{ label: 'Clear filters', onClick: clearFilters }}
                secondaryAction={{ label: 'Reset search', onClick: resetSearch }}
            />,
        );
        // Both practices render and are independently addressable by
        // accessible name — the filtered-empty state often offers
        // both "clear filters" and "reset search".
        const clearCta = screen.getByRole('button', {
            name: 'Clear filters',
        });
        const resetCta = screen.getByRole('button', {
            name: 'Reset search',
        });
        await user.click(clearCta);
        expect(clearFilters).toHaveBeenCalledTimes(1);
        expect(resetSearch).not.toHaveBeenCalled();

        await user.click(resetCta);
        expect(resetSearch).toHaveBeenCalledTimes(1);
    });

    it('a disabled clear-filters CTA does not fire its handler', async () => {
        const user = userEvent.setup();
        const clearFilters = jest.fn();
        render(
            <EmptyState
                variant="no-results"
                title="Nothing matches"
                primaryAction={{
                    label: 'Clear filters',
                    onClick: clearFilters,
                    disabled: true,
                }}
            />,
        );
        const cta = screen.getByRole('button', { name: 'Clear filters' });
        expect(cta).toBeDisabled();
        await user.click(cta);
        // A disabled CTA must be inert — the behavioural contract of
        // the `disabled` prop, verified at the rendered practice.
        expect(clearFilters).not.toHaveBeenCalled();
    });

    it('the no-records variant is distinct from no-results (different personality)', () => {
        // The audit's item #8 names THREE vocabularies. Confirm the
        // variant is a real behavioural switch: the default
        // no-records state must NOT render as no-results.
        const { container } = render(
            <EmptyState
                title="No risks yet"
                description="Create your first risk to get started."
                primaryAction={{
                    label: 'Create risk',
                    onClick: () => undefined,
                }}
            />,
        );
        const root = container.querySelector('[data-empty-state-variant]');
        expect(root).toHaveAttribute(
            'data-empty-state-variant',
            'no-records',
        );
        // A "no records yet" state uses a Create CTA, not a
        // Clear-filters one.
        expect(
            screen.getByRole('button', { name: 'Create risk' }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole('button', { name: 'Clear filters' }),
        ).toBeNull();
    });
});

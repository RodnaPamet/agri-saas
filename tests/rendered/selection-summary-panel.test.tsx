/** @jest-environment jsdom */

/**
 * Rendered (Tier-2) test — `<SelectionSummaryPanel>` (right-rail
 * Phase 2).
 *
 * Pins the selection-summary rail content: the count headline
 * pluralises on `count`, the batch verbs render and fire their
 * callbacks, "Clear selection" fires `onClear`, and the verb section
 * is dropped when no actions are supplied (the viewer-without-edit
 * case — count still shows).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import { SelectionSummaryPanel } from '@/components/ui/selection-summary-panel';

const resourceLabel = { singular: 'practice', plural: 'practices' };

describe('<SelectionSummaryPanel>', () => {
    it('renders the count with the pluralised resource word', () => {
        render(
            <SelectionSummaryPanel
                count={3}
                resourceLabel={resourceLabel}
                onClear={() => {}}
            />,
        );
        const count = screen.getByTestId('selection-summary-count');
        expect(count).toHaveTextContent('3');
        expect(count).toHaveTextContent('practices selected');
    });

    it('uses the singular resource word when exactly one row is selected', () => {
        render(
            <SelectionSummaryPanel
                count={1}
                resourceLabel={resourceLabel}
                onClear={() => {}}
            />,
        );
        expect(
            screen.getByTestId('selection-summary-count'),
        ).toHaveTextContent('practice selected');
    });

    it('renders the batch verbs and fires their callbacks', async () => {
        const user = userEvent.setup();
        const onImplemented = jest.fn();
        render(
            <SelectionSummaryPanel
                count={2}
                resourceLabel={resourceLabel}
                onClear={() => {}}
                actions={[
                    { label: 'Mark Implemented', onClick: onImplemented },
                ]}
            />,
        );
        await user.click(
            screen.getByRole('button', { name: 'Mark Implemented' }),
        );
        expect(onImplemented).toHaveBeenCalledTimes(1);
    });

    it('fires onClear from the Clear selection button', async () => {
        const user = userEvent.setup();
        const onClear = jest.fn();
        render(
            <SelectionSummaryPanel
                count={5}
                resourceLabel={resourceLabel}
                onClear={onClear}
            />,
        );
        await user.click(
            screen.getByRole('button', { name: /clear selection/i }),
        );
        expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('omits the verb section when no actions are supplied (count still shows)', () => {
        render(
            <SelectionSummaryPanel
                count={4}
                resourceLabel={resourceLabel}
                onClear={() => {}}
            />,
        );
        // Only the Clear-selection button — no batch verbs.
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(
            screen.getByTestId('selection-summary-count'),
        ).toHaveTextContent('4');
    });
});

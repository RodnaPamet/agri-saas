/**
 * ProcessInspector edge-mode practice field.
 *
 * Was a Combobox over `GET /api/t/<slug>/practices`. GRC teardown phase 3
 * deleted that route with the Practice model and dropped
 * `ProcessEdgePractice.practiceId`, so there was no row to pick and nowhere
 * to store a pick — the dropdown could only ever render empty, while its
 * hook re-fetched on every mount and re-404'd on a 30s poll.
 *
 * `ProcessEdgePractice` now holds `practiceKey` + `label`, so the affordance
 * is a free-text label. These cases assert what that means:
 *   1. the block mounts under its canonical testid, with NO network call
 *   2. a pre-attached practice populates the field from its label
 *   3. typing and blurring emits one `{ practices: [{ practiceKey, label }] }`
 *   4. clearing the text emits `{ practices: [] }`
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, fireEvent } from '@testing-library/react';
import { ProcessInspector } from '@/components/processes/ProcessInspector';

function makeEdge(overrides: any = {}) {
    return {
        id: 'edge-1',
        source: 'node-1',
        target: 'node-2',
        data: { variant: 'flow' },
        ...overrides,
    };
}

describe('ProcessInspector — edge-mode practice field', () => {
    it('mounts the block and makes NO network call', async () => {
        const fetchSpy = jest.fn();
        (global as unknown as { fetch: unknown }).fetch = fetchSpy;

        render(
            <ProcessInspector
                node={null}
                edge={makeEdge() as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
                onEdgeUpdate={jest.fn()}
            />,
        );

        expect(screen.getByTestId('inspector-edge-practice-picker')).toBeInTheDocument();
        // The load-bearing half: the old picker fetched a deleted route on
        // mount and polled it every 30s. A free-text field talks to nobody.
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('populates from a pre-attached practice label', () => {
        render(
            <ProcessInspector
                node={null}
                edge={makeEdge({
                    data: {
                        variant: 'flow',
                        practices: [{ practiceKey: 'prac-key-1', label: 'Spray interval respected' }],
                    },
                }) as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
                onEdgeUpdate={jest.fn()}
            />,
        );
        expect(screen.getByDisplayValue('Spray interval respected')).toBeInTheDocument();
    });

    it('typing then blurring emits one practice with a generated key', () => {
        const onEdgeUpdate = jest.fn();
        render(
            <ProcessInspector
                node={null}
                edge={makeEdge() as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
                onEdgeUpdate={onEdgeUpdate}
            />,
        );
        const input = screen.getByLabelText(/linked practice/i);
        fireEvent.change(input, { target: { value: '  Buffer zone maintained  ' } });
        fireEvent.blur(input);

        expect(onEdgeUpdate).toHaveBeenCalledTimes(1);
        const [, patch] = onEdgeUpdate.mock.calls[0];
        expect(patch.practices).toHaveLength(1);
        // Trimmed, and carrying no practiceId — the column is gone.
        expect(patch.practices[0].label).toBe('Buffer zone maintained');
        expect(patch.practices[0].practiceKey).toEqual(expect.any(String));
        expect(patch.practices[0]).not.toHaveProperty('practiceId');
    });

    it('clearing the text emits the canonical { practices: [] } patch', () => {
        const onEdgeUpdate = jest.fn();
        render(
            <ProcessInspector
                node={null}
                edge={makeEdge({
                    data: {
                        variant: 'flow',
                        practices: [{ practiceKey: 'prac-key-1', label: 'Spray interval respected' }],
                    },
                }) as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
                onEdgeUpdate={onEdgeUpdate}
            />,
        );
        const input = screen.getByLabelText(/linked practice/i);
        fireEvent.change(input, { target: { value: '   ' } });
        fireEvent.blur(input);

        expect(onEdgeUpdate).toHaveBeenCalledWith(expect.any(String), { practices: [] });
    });

    it('keeps the existing practiceKey when only the label changes', () => {
        // The key is the row's stable identity across saves; re-minting it
        // on every edit would orphan the old row and create a new one.
        const onEdgeUpdate = jest.fn();
        render(
            <ProcessInspector
                node={null}
                edge={makeEdge({
                    data: {
                        variant: 'flow',
                        practices: [{ practiceKey: 'prac-key-1', label: 'Old' }],
                    },
                }) as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
                onEdgeUpdate={onEdgeUpdate}
            />,
        );
        const input = screen.getByLabelText(/linked practice/i);
        fireEvent.change(input, { target: { value: 'New' } });
        fireEvent.blur(input);

        expect(onEdgeUpdate.mock.calls[0][1].practices[0].practiceKey).toBe('prac-key-1');
    });
});

/**
 * VR-4 — Automation inspector panel renders the right per-kind form and the
 * unsynced hint when the node has no linked rule.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => p,
}));

import { AutomationInspectorPanel } from '@/components/processes/AutomationInspectorPanel';

const RULE = {
    id: 'r1',
    name: 'My rule',
    description: null,
    triggerEvent: 'RISK_CREATED',
    triggerFilterJson: null,
    actionType: 'NOTIFY_USER',
    actionConfigJson: {},
    status: 'ENABLED',
    slaWindowMinutes: null,
};

beforeEach(() => {
    mockSWR.mockReturnValue({ data: RULE, mutate: jest.fn() });
});

describe('AutomationInspectorPanel', () => {
    it('shows the unsynced hint when there is no ruleId', () => {
        mockSWR.mockReturnValue({ data: undefined, mutate: jest.fn() });
        render(<AutomationInspectorPanel kind="action" ruleId={null} />);
        expect(screen.getByTestId('automation-inspector-unsynced')).toBeInTheDocument();
    });

    // ── The draft is seeded once per rule, not per server change (#1471) ──
    //
    // The effect behind these used to depend on `rule.name`, and the inputs
    // auto-save on blur and then `mutate()`. So a server copy that changed
    // while someone was typing re-seeded the input and discarded what they
    // had typed since the blur. These two tests are the pair: the draft
    // SURVIVES a server change, and switching rules still re-seeds.

    it('keeps what the user typed when the server copy changes under them', () => {
        const { rerender } = render(<AutomationInspectorPanel kind="action" ruleId="r1" />);
        const input = screen.getByDisplayValue('My rule');

        fireEvent.change(input, { target: { value: 'My rule, edited' } });
        expect(screen.getByDisplayValue('My rule, edited')).toBeInTheDocument();

        // What `mutate()` does after an auto-save, or what an SWR focus
        // revalidation does with no save at all: same rule id, new name.
        mockSWR.mockReturnValue({ data: { ...RULE, name: 'My rule' }, mutate: jest.fn() });
        rerender(<AutomationInspectorPanel kind="action" ruleId="r1" />);

        // Still the draft. Before the fix this read 'My rule'.
        expect(screen.getByDisplayValue('My rule, edited')).toBeInTheDocument();
    });

    it('DOES re-seed when the inspector moves to a different rule', () => {
        const { rerender } = render(<AutomationInspectorPanel kind="action" ruleId="r1" />);
        fireEvent.change(screen.getByDisplayValue('My rule'), {
            target: { value: 'stale draft' },
        });

        // The control for the test above: if seeding were simply disabled,
        // that one would still pass and this one would fail.
        mockSWR.mockReturnValue({
            data: { ...RULE, id: 'r2', name: 'Another rule' },
            mutate: jest.fn(),
        });
        rerender(<AutomationInspectorPanel kind="action" ruleId="r2" />);

        expect(screen.getByDisplayValue('Another rule')).toBeInTheDocument();
        expect(screen.queryByDisplayValue('stale draft')).not.toBeInTheDocument();
    });

    it('renders the trigger-event field for a trigger node', () => {
        render(<AutomationInspectorPanel kind="trigger" ruleId="r1" />);
        expect(screen.getByTestId('automation-inspector')).toBeInTheDocument();
        expect(screen.getByText('Trigger event')).toBeInTheDocument();
    });

    it('renders the action-type field for an action node', () => {
        render(<AutomationInspectorPanel kind="action" ruleId="r1" />);
        expect(screen.getByText('Action type')).toBeInTheDocument();
    });

    it('renders the SLA window field for an slaGate node', () => {
        render(<AutomationInspectorPanel kind="slaGate" ruleId="r1" />);
        expect(screen.getByText('SLA window (minutes)')).toBeInTheDocument();
    });
});

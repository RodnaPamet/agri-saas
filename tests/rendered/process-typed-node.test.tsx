/**
 * R26-PR-B — ProcessTypedNode rendered tests.
 *
 * One render per canonical kind to cover the per-kind chrome the
 * structural ratchet can't see (shape selector, accent border,
 * icon presence, annotation's no-handles invariant).
 *
 * Why per-kind tests vs. one parametrised render:
 *   The kind-to-chrome mapping is the load-bearing contract this
 *   PR ships. A single parametrised test passing only `processStep`
 *   would silently let the other six drop their accents on a
 *   future refactor. Explicit per-kind runs make a regression on
 *   any single kind a discrete failure.
 *
 * What's NOT tested here:
 *   • Drag-drop interaction — covered by E2E.
 *   • xyflow internal selection state — relies on the
 *     ReactFlowProvider context which the structural ratchet
 *     locks. Pure node-render assertions only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import {
    ProcessTypedNode,
    type ProcessTypedNodeData,
} from '@/components/processes/ProcessTypedNode';
import { NODE_TAXONOMY, NODE_TAXONOMY_ORDER, type ProcessNodeKind } from '@/components/processes/node-taxonomy';

function renderNode(
    kind: ProcessNodeKind,
    overrides: Partial<ProcessTypedNodeData> = {},
) {
    const data = { label: 'Test label', kind, ...overrides };
    // xyflow passes a NodeProps shape; the renderer reads `data`
    // + `selected` only.
    return render(
        <ReactFlowProvider>
            <ProcessTypedNode {...({ data, selected: false } as any)} />
        </ReactFlowProvider>,
    );
}

describe('ProcessTypedNode — per-kind chrome', () => {
    for (const kind of NODE_TAXONOMY_ORDER) {
        const meta = NODE_TAXONOMY[kind];
        describe(`kind=${kind}`, () => {
            it(`renders the label`, () => {
                renderNode(kind);
                expect(screen.getByText('Test label')).toBeInTheDocument();
            });

            it(`stamps data-process-node-kind=${kind}`, () => {
                const { container } = renderNode(kind);
                const root = container.querySelector(
                    '[data-process-node]',
                );
                expect(root).not.toBeNull();
                expect(root!.getAttribute('data-process-node-kind')).toBe(kind);
            });

            it(`uses the ${meta.shape} shape selector`, () => {
                const { container } = renderNode(kind);
                const root = container.querySelector('[data-process-node]');
                expect(root).not.toBeNull();
                const cls = root!.className;
                // R31 — diamond branch retired. The decision kind
                // now reads as a rect with a "?" corner sticker;
                // the per-shape assertions below cover the two
                // remaining geometries (rect, note) plus the
                // category-group branch.
                if (meta.shape === 'note') {
                    expect(cls).toMatch(/rounded-\[6px\]/);
                    // Note shape carries the subtle background tint.
                    expect(cls).toMatch(/bg-bg-subtle/);
                } else if (meta.category === 'group') {
                    // R30 — the group container takes its size from
                    // xyflow's `style` (set when the group is
                    // created), not the per-size selectors. The
                    // wrapper sits at h-full + w-full + a 12px
                    // radius + dashed border so the eye reads
                    // "container", not "card".
                    expect(cls).toMatch(/h-full/);
                    expect(cls).toMatch(/w-full/);
                    expect(cls).toMatch(/border-dashed/);
                } else {
                    expect(cls).toMatch(/min-w-\[180px\]/);
                }
            });

            const hasHandlesText = meta.hasHandles ? 'has' : 'has NO';
            it(`${hasHandlesText} xyflow handles`, () => {
                const { container } = renderNode(kind);
                // xyflow's <Handle> renders as a div with the
                // `react-flow__handle` class.
                const handles = container.querySelectorAll(
                    '.react-flow__handle',
                );
                if (meta.hasHandles) {
                    expect(handles.length).toBeGreaterThanOrEqual(2);
                } else {
                    expect(handles.length).toBe(0);
                }
            });

            it('renders the per-kind icon', () => {
                const { container } = renderNode(kind);
                const svgs = container.querySelectorAll('svg');
                // At minimum the lucide kind icon should be there.
                // Annotation also has its sticky-note icon mounted
                // inside the chassis.
                expect(svgs.length).toBeGreaterThanOrEqual(1);
            });

            it('falls back to the default label when none is provided', () => {
                renderNode(kind, { label: '' });
                expect(screen.getByText(meta.defaultLabel)).toBeInTheDocument();
            });
        });
    }

    it('falls back to processStep when the kind is unknown', () => {
        const { container } = render(
            <ReactFlowProvider>
                <ProcessTypedNode
                    {...({
                        data: { label: 'Fallback', kind: 'not-a-real-kind' },
                        selected: false,
                    } as any)}
                />
            </ReactFlowProvider>,
        );
        const root = container.querySelector('[data-process-node]');
        expect(root).not.toBeNull();
        // Even when the kind is unknown the node renders with the
        // default shape (rect) and handles enabled.
        expect(root!.getAttribute('data-process-node-kind')).toBe('processStep');
    });
});

/**
 * R27-PR-A — nodes became SOLID elevated cards on the recessed
 * canvas plane. These assert the computed surface classes per
 * category + the preserved selected-state vocabulary.
 */
describe('ProcessTypedNode — R27 elevated surfaces', () => {
    it('the default (flow) node is a solid elevated card', () => {
        const { container } = renderNode('processStep');
        const cls = container.querySelector('[data-process-node]')!.className;
        expect(cls).toMatch(/bg-canvas-node(?!-)/);
        expect(cls).toMatch(/shadow-canvas-node/);
        // No translucent tint of the plane.
        expect(cls).not.toMatch(/backdrop-blur/);
    });

    it('a context node uses the quieter elevated fill', () => {
        const { container } = renderNode('asset');
        const cls = container.querySelector('[data-process-node]')!.className;
        expect(cls).toMatch(/bg-canvas-node-muted/);
    });

    it('an annotation stays a flat sticker tint (no card lift)', () => {
        const { container } = renderNode('annotation');
        const cls = container.querySelector('[data-process-node]')!.className;
        expect(cls).toMatch(/bg-bg-subtle/);
        expect(cls).not.toMatch(/shadow-canvas-node/);
    });

    it('the selected state keeps the brand ring + elevated tint', () => {
        const { container } = render(
            <ReactFlowProvider>
                <ProcessTypedNode
                    {...({
                        data: { label: 'Selected', kind: 'processStep' },
                        selected: true,
                    } as any)}
                />
            </ReactFlowProvider>,
        );
        const cls = container.querySelector('[data-process-node]')!.className;
        expect(cls).toMatch(/ring-2/);
        expect(cls).toMatch(/bg-bg-elevated/);
    });
});

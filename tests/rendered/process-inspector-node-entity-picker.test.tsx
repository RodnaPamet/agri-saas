/**
 * Epic P2-PR-B — ProcessInspector node-mode entity picker.
 *
 * Asserts the picker block mounts on `asset` nodes and NOT on any other
 * kind. It also used to mount on `practice` nodes, fed by
 * `GET /api/t/<slug>/practices` — a route GRC teardown phase 3 deleted
 * with the model. The `practice` NODE kind survives (node-taxonomy marks
 * it legacy, with edge-mounted practices as canonical), so an old map
 * still renders it; what it no longer gets is a picker over rows that do
 * not exist. That absence is asserted, not just un-tested.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, waitFor } from '@testing-library/react';
import { ProcessInspector } from '@/components/processes/ProcessInspector';
import { __resetTenantAssetsCacheForTests } from '@/lib/processes/use-tenant-assets';

function makeNode(kind: string, extra: any = {}) {
    return {
        id: `node-${kind}-1`,
        type: kind,
        position: { x: 0, y: 0 },
        data: { label: `${kind} node`, kind, ...extra },
    };
}

describe('ProcessInspector — node-mode entity picker (P2-PR-B)', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        __resetTenantAssetsCacheForTests();
        global.fetch = jest.fn(async (url: string | URL) => {
            const u = url.toString();
            if (u.includes('/api/t/acme/practices')) {
                return new Response(
                    JSON.stringify([
                        { id: 'ctrl-1', ref: 'AC-1', title: 'Access policy' },
                    ]),
                    { status: 200 },
                );
            }
            if (u.includes('/api/t/acme/assets')) {
                return new Response(
                    JSON.stringify([
                        { id: 'asset-1', key: 'AST-1', name: 'Customer DB' },
                    ]),
                    { status: 200 },
                );
            }
            return new Response('not found', { status: 404 });
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.clearAllMocks();
    });

    it('does NOT mount the picker on a practice node, and fetches nothing', async () => {
        render(
            <ProcessInspector
                node={makeNode('practice') as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
            />,
        );
        expect(screen.queryByTestId('inspector-node-entity-picker')).toBeNull();
        // The hook call sat ABOVE the nodeKind guard, so it fired on every
        // node selection — not only practice ones. Asserting no request at
        // all is what pins that.
        expect(global.fetch).not.toHaveBeenCalledWith('/api/t/acme/practices');
    });


    it('mounts the picker on an asset node + fetches assets', async () => {
        render(
            <ProcessInspector
                node={makeNode('asset') as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
            />,
        );
        const picker = screen.getByTestId('inspector-node-entity-picker');
        expect(picker.getAttribute('data-entity-kind')).toBe('asset');
        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                '/api/t/acme/assets',
            );
        });
    });

    it('does NOT mount the picker on processStep / decision / annotation', () => {
        for (const kind of ['processStep', 'decision', 'annotation']) {
            const { unmount } = render(
                <ProcessInspector
                    node={makeNode(kind) as any}
                    tenantSlug="acme"
                    onUpdate={jest.fn()}
                />,
            );
            expect(
                screen.queryByTestId('inspector-node-entity-picker'),
            ).toBeNull();
            unmount();
        }
    });
});

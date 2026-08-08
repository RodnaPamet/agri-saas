/**
 * Epic P2-PR-B — ProcessInspector node-mode entity picker.
 *
 * Asserts the picker block mounts on the three compliance-entity
 * node kinds (control / asset), and does NOT mount on the
 * other kinds (processStep / decision / external / annotation /
 * group). Three cases run against the three entity-kind responses
 * so a refactor that swaps a hook breaks loudly.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen, waitFor } from '@testing-library/react';
import { ProcessInspector } from '@/components/processes/ProcessInspector';
import { __resetTenantControlsCacheForTests } from '@/lib/processes/use-tenant-controls';
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
        __resetTenantControlsCacheForTests();
        __resetTenantAssetsCacheForTests();
        global.fetch = jest.fn(async (url: string | URL) => {
            const u = url.toString();
            if (u.includes('/api/t/acme/controls')) {
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

    it('mounts the picker on a control node + fetches controls', async () => {
        render(
            <ProcessInspector
                node={makeNode('control') as any}
                tenantSlug="acme"
                onUpdate={jest.fn()}
            />,
        );
        const picker = screen.getByTestId('inspector-node-entity-picker');
        expect(picker).toBeInTheDocument();
        expect(picker.getAttribute('data-entity-kind')).toBe('control');
        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                '/api/t/acme/controls',
            );
        });
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

/* eslint-disable @typescript-eslint/no-explicit-any -- xyflow Node/Edge fixtures are
 * structurally typed; full generic construction per fixture has poor cost/benefit. */

/**
 * Zero-coverage canvas modules, wave 8: the pure half of `src/lib/processes`.
 *
 *   canvas-clipboard · canvas-drill-filter · edge-controls
 *   switch-canvas-mode · version-conflict-toast
 *
 * These are the modules the process canvas was decomposed INTO — extracted
 * specifically so `PersistedProcessCanvas.tsx` stays under the R32-PR10
 * 1900-line ratchet. Their own docblocks say they were pulled out because
 * they are "easy to unit-test, no React state"; none of them had a test.
 *
 * The clipboard is the interesting one. It deliberately lives at MODULE
 * scope, not in React state, so a copy survives navigating between maps —
 * which means its behaviour is global mutable state and every rule about
 * re-keying is load-bearing. Three of those rules produce silent data
 * corruption if they regress rather than an error:
 *
 *   - every node id is re-minted on paste, so pasting twice yields two
 *     copies instead of one clobbering the other;
 *   - internal edges are re-pointed at the NEW ids, not left aimed at the
 *     originals (which would silently rewire the source graph);
 *   - a `parentId` is remapped only when the parent was also copied, and
 *     otherwise DROPPED — a pasted child that kept a stale parentId would
 *     render inside a group it does not belong to.
 */
import {
    copyToClipboard,
    hasClipboard,
    pasteFromClipboard,
    clearClipboard,
    __resetClipboardForTests,
} from '@/lib/processes/canvas-clipboard';
import { filterByDrillScope, buildDrillBreadcrumbs } from '@/lib/processes/canvas-drill-filter';
import { edgeControlsForSave } from '@/lib/processes/edge-controls';
import { patchCanvasMode } from '@/lib/processes/switch-canvas-mode';
import { surfaceVersionConflict } from '@/lib/processes/version-conflict-toast';

const node = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, position: { x: 100, y: 200 }, data: { label: id }, ...over }) as any;
const edge = (id: string, source: string, target: string, over: Record<string, unknown> = {}) =>
    ({ id, source, target, ...over }) as any;

beforeEach(() => {
    __resetClipboardForTests();
    jest.clearAllMocks();
});

// ─── canvas-clipboard ────────────────────────────────────────────────

describe('canvas-clipboard', () => {
    // Deterministic minting so the re-key assertions can name ids.
    let n = 0;
    const idMint = () => `new-${++n}`;
    beforeEach(() => {
        n = 0;
    });

    it('starts empty', () => {
        expect(hasClipboard()).toBe(false);
        expect(pasteFromClipboard()).toBeNull();
    });

    it('copying an EMPTY selection clears the clipboard rather than doing nothing', () => {
        // Worth pinning because "no-op on empty" is the intuitive reading,
        // and the difference is whether Cmd+V after a click-away pastes
        // stale content.
        copyToClipboard([node('a')], []);
        expect(hasClipboard()).toBe(true);

        copyToClipboard([], []);

        expect(hasClipboard()).toBe(false);
        expect(pasteFromClipboard()).toBeNull();
    });

    it('captures internal edges and drops external ones', () => {
        // An edge with one endpoint outside the selection has nothing to
        // attach to after the paste, so the copies land floating.
        const edges = [
            edge('e-int', 'a', 'b'),
            edge('e-out', 'b', 'outside'),
            edge('e-in', 'outside', 'a'),
        ];
        copyToClipboard([node('a'), node('b')], edges);

        const pasted = pasteFromClipboard({ idMint })!;
        expect(pasted.nodes).toHaveLength(2);
        expect(pasted.edges).toHaveLength(1);
    });

    it('snapshots the payload so later mutations do not bleed in', () => {
        const live = node('a', { data: { label: 'original' } });
        copyToClipboard([live], []);

        live.data.label = 'mutated after copy';

        expect(pasteFromClipboard({ idMint })!.nodes[0].data.label).toBe('original');
    });

    describe('re-keying on paste', () => {
        it('re-mints every node id, so pasting twice yields two copies', () => {
            copyToClipboard([node('a'), node('b')], []);

            const first = pasteFromClipboard({ idMint })!;
            const second = pasteFromClipboard({ idMint })!;

            expect(first.nodes.map((x) => x.id)).toEqual(['new-1', 'new-2']);
            expect(second.nodes.map((x) => x.id)).toEqual(['new-3', 'new-4']);
            // No overlap — a clobber would be silent data loss.
            const all = [...first.nodes, ...second.nodes].map((x) => x.id);
            expect(new Set(all).size).toBe(4);
        });

        it('re-points internal edges at the NEW node ids', () => {
            // Leaving these aimed at the originals would silently rewire
            // the source graph instead of the copy.
            copyToClipboard([node('a'), node('b')], [edge('e1', 'a', 'b')]);

            const { nodes, edges } = pasteFromClipboard({ idMint })!;
            const [na, nb] = nodes;
            expect(edges[0].source).toBe(na.id);
            expect(edges[0].target).toBe(nb.id);
            expect(edges[0].id).not.toBe('e1');
            expect(edges[0].id).toMatch(/^edge-/);
        });

        it('remaps parentId when the parent was copied too', () => {
            copyToClipboard([node('group'), node('child', { parentId: 'group' })], []);

            const { nodes } = pasteFromClipboard({ idMint })!;
            const [g, c] = nodes;
            expect(c.parentId).toBe(g.id);
        });

        it('DROPS parentId when the parent was not copied', () => {
            // A pasted child that kept a stale parentId would render inside
            // a group it does not belong to — or inside nothing at all.
            copyToClipboard([node('child', { parentId: 'group-left-behind' })], []);

            expect(pasteFromClipboard({ idMint })!.nodes[0].parentId).toBeUndefined();
        });

        it('offsets the pasted block so it is visually distinguishable', () => {
            copyToClipboard([node('a')], []);

            expect(pasteFromClipboard({ idMint })!.nodes[0].position).toEqual({ x: 128, y: 228 });
        });

        it('selects the pasted nodes and deselects the pasted edges', () => {
            copyToClipboard([node('a', { selected: false }), node('b')], [edge('e1', 'a', 'b')]);

            const { nodes, edges } = pasteFromClipboard({ idMint })!;
            expect(nodes.every((x) => x.selected === true)).toBe(true);
            expect(edges[0].selected).toBe(false);
        });

        it('falls back to a timestamp+random id when no minter is supplied', () => {
            copyToClipboard([node('a')], []);

            const id = pasteFromClipboard()!.nodes[0].id;
            expect(id).toMatch(/^n-[a-z0-9]+-[a-z0-9]{6}$/);
        });
    });

    it('clearClipboard empties it', () => {
        copyToClipboard([node('a')], []);
        clearClipboard();

        expect(hasClipboard()).toBe(false);
        expect(pasteFromClipboard()).toBeNull();
    });
});

// ─── canvas-drill-filter ─────────────────────────────────────────────

describe('filterByDrillScope', () => {
    const nodes = [
        node('root-1'),
        node('group'),
        node('child-1', { parentId: 'group' }),
        node('child-2', { parentId: 'group' }),
        node('grandchild', { parentId: 'child-1' }),
    ];
    const edges = [
        edge('e-root', 'root-1', 'group'),
        edge('e-inside', 'child-1', 'child-2'),
        edge('e-crossing', 'root-1', 'child-1'),
    ];

    it('returns the whole graph at root and does not copy the arrays', () => {
        // NOTE: the module's header comment describes root as "top-level
        // nodes AND their immediate children", but the implementation (and
        // its own inline comment) returns EVERYTHING. Pinning the real
        // behaviour; the header block is stale documentation.
        const r = filterByDrillScope(nodes, edges, null);

        expect(r.visibleNodes).toBe(nodes);
        expect(r.visibleEdges).toBe(edges);
    });

    it('shows only the group’s direct children when drilled in', () => {
        const r = filterByDrillScope(nodes, edges, 'group');

        expect(r.visibleNodes.map((x) => x.id)).toEqual(['child-1', 'child-2']);
        // The group itself is hidden — the breadcrumb already says where we
        // are, so rendering the container around its own contents is noise.
        expect(r.visibleNodes.map((x) => x.id)).not.toContain('group');
        // Grandchildren belong to the next level down, not this one.
        expect(r.visibleNodes.map((x) => x.id)).not.toContain('grandchild');
    });

    it('keeps only edges whose BOTH endpoints are visible', () => {
        const r = filterByDrillScope(nodes, edges, 'group');

        expect(r.visibleEdges.map((x) => x.id)).toEqual(['e-inside']);
        // e-crossing has one endpoint outside the scope — a half-anchored
        // edge would render as a line into nowhere.
        expect(r.visibleEdges.map((x) => x.id)).not.toContain('e-crossing');
    });

    it('yields nothing for an empty or unknown group', () => {
        expect(filterByDrillScope(nodes, edges, 'no-such-group')).toEqual({
            visibleNodes: [],
            visibleEdges: [],
        });
    });
});

describe('buildDrillBreadcrumbs', () => {
    const nodes = [
        node('g1', { data: { label: 'Intake' } }),
        node('g2', { data: { label: 'Drying' } }),
        node('g3', { data: {} }),
        node('g4', { data: { label: '' } }),
    ];

    it('always starts with a root row', () => {
        expect(buildDrillBreadcrumbs([], nodes)).toEqual([{ id: null, label: 'All' }]);
    });

    it('accepts a custom root label', () => {
        expect(buildDrillBreadcrumbs([], nodes, 'All processes')[0].label).toBe('All processes');
    });

    it('walks the stack root → deepest', () => {
        expect(buildDrillBreadcrumbs(['g1', 'g2'], nodes)).toEqual([
            { id: null, label: 'All' },
            { id: 'g1', label: 'Intake' },
            { id: 'g2', label: 'Drying' },
        ]);
    });

    it.each([
        ['a node with no label', 'g3'],
        ['a node with an empty label', 'g4'],
        ['a node that no longer exists', 'deleted'],
    ])('falls back to "Group" for %s', (_label, id) => {
        // A breadcrumb rendering `undefined` is worse than a generic word.
        expect(buildDrillBreadcrumbs([id], nodes)[1]).toEqual({ id, label: 'Group' });
    });
});

// ─── edge-controls ───────────────────────────────────────────────────

describe('edgeControlsForSave', () => {
    it('returns an empty list for a pre-P2 edge with no controls', () => {
        // Tolerance for older edges is the point — a save must not throw on
        // a graph created before edge controls existed.
        expect(edgeControlsForSave(edge('e', 'a', 'b'))).toEqual([]);
        expect(edgeControlsForSave(edge('e', 'a', 'b', { data: {} }))).toEqual([]);
        expect(edgeControlsForSave(edge('e', 'a', 'b', { data: { controls: 'nope' } }))).toEqual([]);
        expect(edgeControlsForSave(edge('e', 'a', 'b', { data: { controls: null } }))).toEqual([]);
    });

    it('serialises a full row unchanged and always adds the dataJson slot', () => {
        const e = edge('e', 'a', 'b', {
            data: { controls: [{ controlKey: 'C-1', label: 'Temp check', controlId: 'ctl-1' }] },
        });

        expect(edgeControlsForSave(e)).toEqual([
            { controlKey: 'C-1', label: 'Temp check', controlId: 'ctl-1', dataJson: null },
        ]);
    });

    it('defaults a missing or non-string label to the control key', () => {
        const e = edge('e', 'a', 'b', {
            data: { controls: [{ controlKey: 'C-1' }, { controlKey: 'C-2', label: 42 }] },
        });

        expect(edgeControlsForSave(e).map((r) => r.label)).toEqual(['C-1', 'C-2']);
    });

    it('normalises a non-string controlId to null', () => {
        const e = edge('e', 'a', 'b', {
            data: { controls: [{ controlKey: 'C-1', controlId: 0 }] },
        });

        expect(edgeControlsForSave(e)[0].controlId).toBeNull();
    });

    it('drops rows with no usable controlKey', () => {
        // The key is the join back to the Control row; without it the entry
        // is unrecoverable, so it must not reach the wire.
        const e = edge('e', 'a', 'b', {
            data: { controls: [{ label: 'orphan' }, { controlKey: 7 }, { controlKey: 'C-ok' }] },
        });

        expect(edgeControlsForSave(e).map((r) => r.controlKey)).toEqual(['C-ok']);
    });

    it.each([
        ['null', null],
        ['a bare string', 'C-1'],
        ['a number', 3],
        ['undefined', undefined],
    ])('drops a %s entry instead of throwing', (_label, junk) => {
        // Regression: this used to throw. The row was cast to an object and
        // dereferenced without a null/type check, so a single null entry in
        // persisted graph JSON took down the SAVE path — the user could not
        // persist the map at all. This helper's documented job is tolerance
        // of malformed edge data, so it now drops the entry like any other
        // unusable row.
        const e = edge('e', 'a', 'b', {
            data: { controls: [junk, { controlKey: 'C-ok' }] },
        });

        expect(() => edgeControlsForSave(e)).not.toThrow();
        expect(edgeControlsForSave(e).map((r) => r.controlKey)).toEqual(['C-ok']);
    });
});

// ─── switch-canvas-mode ──────────────────────────────────────────────

describe('patchCanvasMode', () => {
    const fetchMock = jest.fn();
    beforeEach(() => {
        (globalThis as any).fetch = fetchMock;
        fetchMock.mockResolvedValue({ ok: true, status: 200 });
    });

    it('PATCHes only the canvasMode — a metadata edit, never a graph save', async () => {
        await patchCanvasMode('acme', 'map-1', 'AUTOMATION');

        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/processes/map-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canvasMode: 'AUTOMATION' }),
        });
    });

    it('round-trips back to DOCUMENT', async () => {
        await patchCanvasMode('acme', 'map-1', 'DOCUMENT');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ canvasMode: 'DOCUMENT' });
    });

    it('throws with the status so the caller can surface it', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 409 });

        await expect(patchCanvasMode('acme', 'map-1', 'AUTOMATION')).rejects.toThrow(
            'Mode switch failed (409)',
        );
    });
});

// ─── version-conflict-toast ──────────────────────────────────────────

describe('surfaceVersionConflict', () => {
    const toast = () => ({ error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() }) as any;

    it('passes through any non-409 so the caller keeps its normal branches', async () => {
        const t = toast();
        const json = jest.fn();

        for (const status of [200, 400, 403, 500]) {
            expect(await surfaceVersionConflict({ status, json } as any, t, jest.fn())).toBe(false);
        }
        expect(t.error).not.toHaveBeenCalled();
        // No body read either — a 500's body may not be JSON at all.
        expect(json).not.toHaveBeenCalled();
    });

    it('surfaces the conflict with the server version and a Reload action', async () => {
        const t = toast();
        const onReload = jest.fn();
        const res = {
            status: 409,
            json: jest.fn().mockResolvedValue({
                error: { code: 'STALE_DATA', details: { currentVersion: 7 } },
            }),
        } as any;

        expect(await surfaceVersionConflict(res, t, onReload)).toBe(true);

        const [message, opts] = t.error.mock.calls[0];
        expect(message).toMatch(/Someone else saved this map/);
        expect(opts.description).toContain('v7');
        expect(opts.action.label).toBe('Reload');

        // The action is the safety mechanism — verify it is actually wired.
        opts.action.onClick();
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('still toasts when the body is unparseable — the Reload action is what matters', async () => {
        // A misbehaving proxy can return a bodyless 409. The version line is
        // polish; losing the toast entirely would lose the recovery path.
        const t = toast();
        const res = { status: 409, json: jest.fn().mockRejectedValue(new SyntaxError('eof')) } as any;

        expect(await surfaceVersionConflict(res, t, jest.fn())).toBe(true);
        expect(t.error.mock.calls[0][1].description).toBe('Your edits will be lost on reload.');
    });

    it.each([
        ['an empty object', {}],
        ['no details', { error: { code: 'STALE_DATA' } }],
        ['a null body', null],
    ])('omits the version line for %s', async (_label, body) => {
        const t = toast();
        const res = { status: 409, json: jest.fn().mockResolvedValue(body) } as any;

        expect(await surfaceVersionConflict(res, t, jest.fn())).toBe(true);
        expect(t.error.mock.calls[0][1].description).toBe('Your edits will be lost on reload.');
    });
});

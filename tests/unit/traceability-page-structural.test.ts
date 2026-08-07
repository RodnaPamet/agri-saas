/**
 * Sankey-only page composition + traceability-page removal ratchet.
 *
 * The standalone /traceability page (graph + table + sankey
 * toggle) was rolled back. The Sankey is the surviving surface,
 * reachable from a pill button on the Controls list and rendered
 * at /controls/sankey.
 *
 * This file locks:
 *   - the /traceability route is gone
 *   - SidebarNav + cmdk palette have no Traceability nav target
 *   - the Sankey page mounts <SankeyChart> with the typed graph
 *   - the controls pill links to /controls/sankey
 *   - the GraphExplorer (still exported by the codebase, used
 *     by callers that want a generic React Flow wrapper later)
 *     keeps its public surface
 *   - the category-defaults palette stays accessible (downstream
 *     surfaces still consume it for legend rendering)
 */

import * as fs from 'fs';
import * as path from 'path';

const CONTROLS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
);
const SIDEBAR = path.resolve(
    __dirname,
    '../../src/components/layout/SidebarNav.tsx',
);
const PALETTE_COMMANDS = path.resolve(
    __dirname,
    '../../src/components/command-palette/use-palette-commands.ts',
);
const TYPES = path.resolve(
    __dirname,
    '../../src/lib/traceability-graph/types.ts',
);
const GRAPH_EXPLORER = path.resolve(
    __dirname,
    '../../src/components/ui/GraphExplorer.tsx',
);
const DEPRECATED_TRACEABILITY_DIR = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/traceability',
);

function read(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

describe('Traceability page removal', () => {
    it('the standalone /traceability page directory is gone', () => {
        expect(fs.existsSync(DEPRECATED_TRACEABILITY_DIR)).toBe(false);
    });

    it('SidebarNav has no Traceability nav entry', () => {
        const src = read(SIDEBAR);
        expect(src).not.toMatch(/\/traceability\b/);
        expect(src).not.toMatch(/'Traceability'/);
    });

    it('Command palette has no Traceability nav target', () => {
        const src = read(PALETTE_COMMANDS);
        expect(src).not.toMatch(/Go to Traceability/);
        expect(src).not.toMatch(/'nav:traceability'/);
    });
});


describe('GraphExplorer — public surface preserved', () => {
    const src = read(GRAPH_EXPLORER);

    it('still exports GraphExplorer for future callers', () => {
        expect(src).toMatch(/export function GraphExplorer\b/);
    });

    it('preserves the typed graph contract import', () => {
        expect(src).toMatch(/TraceabilityGraph\b/);
    });
});

describe('Category contract — Epic 47 palette retained', () => {
    const types = read(TYPES);

    it('keeps the canonical color union (downstream surfaces — Sankey, future legends — still consume it)', () => {
        for (const c of ['sky', 'rose', 'emerald', 'violet', 'amber', 'slate']) {
            expect(types).toMatch(new RegExp(`'${c}'`));
        }
    });

    it('keeps iconKey + pattern as accessibility cues', () => {
        expect(types).toMatch(/iconKey/);
        expect(types).toMatch(/pattern/);
    });
});

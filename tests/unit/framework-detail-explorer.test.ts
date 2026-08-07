/**
 * Epic 46 — structural ratchet for the framework detail page's
 * tree-explorer migration.
 *
 * The page used to render a flat grouped-by-section requirements
 * list with hand-rolled expand/collapse-row state. The migration
 * replaced that block with `<FrameworkExplorer>` (which mounts
 * `<TreeView>` + `<TreeExpandCollapseToggle>`) and switched the
 * data fetch from `?action=requirements` to the new `/tree`
 * endpoint.
 *
 * A future "simplify" PR could quietly revert this and the
 * regression would be silent (the page would still render
 * SOMETHING). This test catches that by asserting the page
 * structurally depends on the new pieces.
 */

import * as fs from 'fs';
import * as path from 'path';

const PAGE = path.resolve(
    __dirname,
);
const EXPLORER = path.resolve(
    __dirname,
    '../../src/components/frameworks/FrameworkExplorer.tsx',
);

function read(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

describe('framework detail page — Epic 46 explorer wiring', () => {
    const src = read(PAGE);

    it('imports FrameworkExplorer', () => {
        expect(src).toMatch(
            /import\s*\{\s*FrameworkExplorer\s*\}\s*from\s*'@\/components\/frameworks\/FrameworkExplorer'/,
        );
    });

    it('fetches the new /tree endpoint instead of ?action=requirements', () => {
        expect(src).toMatch(/\/frameworks\/\$\{frameworkKey\}\/tree/);
        // The legacy flat-requirements FETCH must be gone (the
        // string can still appear in the migration-rationale
        // comment — match a real `fetch(...)` call to keep the
        // assertion honest).
        expect(src).not.toMatch(/fetch\([^)]*\?action=requirements/);
    });

    it('renders <FrameworkExplorer> inside the requirements tab', () => {
        // Match `<FrameworkExplorer ... />` (props irrelevant). The
        // tab wrapper id stays stable so existing tests / E2E
        // selectors don't break.
        expect(src).toMatch(/id="requirements-panel"/);
        expect(src).toMatch(/<FrameworkExplorer\b/);
    });

    it('does not retain the old flat grouped-list rendering block', () => {
        // The old code mapped `Object.entries(filteredGroups)` to
        // build the flat list. Its disappearance is the canonical
        // signal the migration stuck.
        expect(src).not.toMatch(/filteredGroups/);
        expect(src).not.toMatch(/groupedReqs/);
        expect(src).not.toMatch(/expandedReq/);
    });
});

describe('FrameworkExplorer — structural composition', () => {
    const src = read(EXPLORER);

    it('mounts <TreeView> from the generic primitive', () => {
        expect(src).toMatch(/from\s*'@\/components\/ui\/TreeView'/);
        expect(src).toMatch(/<TreeView\b/);
    });

    it('mounts <TreeExpandCollapseToggle> for global expand/collapse', () => {
        expect(src).toMatch(
            /from\s*'@\/components\/ui\/TreeExpandCollapseToggle'/,
        );
        expect(src).toMatch(/<TreeExpandCollapseToggle\b/);
    });

    it('uses collectExpandableIds for the expand-all behavior', () => {
        // The expand-all path passes every expandable id as the new
        // expansion set — `collectExpandableIds` is the canonical
        // source. A regression that hand-rolls a substitute would
        // bypass the unit-tested path.
        expect(src).toMatch(/collectExpandableIds\b/);
    });

    it('uses filterTree for search filtering', () => {
        expect(src).toMatch(/filterTree\b/);
    });

    it('mounts the FrameworkMinimap (Epic 46.3)', () => {
        expect(src).toMatch(
            /from\s*'@\/components\/ui\/FrameworkMinimap'/,
        );
        expect(src).toMatch(/<FrameworkMinimap\b/);
    });

    it('renders the ComplianceStatusIndicator on tree rows + detail pane', () => {
        expect(src).toMatch(
            /from\s*'@\/components\/ui\/ComplianceStatusIndicator'/,
        );
        expect(src).toMatch(/<ComplianceStatusIndicator\b/);
    });

    it('passes the tree scroll-container ref to the minimap so scroll sync is real', () => {
        // The minimap MUST receive the live scroll container's ref —
        // without it the active-section observer can't run and the
        // highlight is decorative-only. A regression that drops the
        // ref would silently leave the minimap painted but inert.
        expect(src).toMatch(/scrollContainerRef\s*=\s*\{?\s*treeScrollRef/);
    });
});

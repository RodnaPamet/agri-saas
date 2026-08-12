/**
 * B4 — filter + nav consistency ratchet.
 *
 *   1. Documents tab on the vendor detail page carries a search +
 *      type filter on the LEFT, action button on the RIGHT —
 *      matching the position other list pages put their
 *      FilterToolbar in.
 *   2. Clauses entry-point is reachable from the Audits page header
 *      (next to Frameworks). The user wants Clauses grouped with
 *      Frameworks rather than living as a standalone primary-nav
 *      destination.
 *   3. The workspace switcher (`<TenantSwitcher>`) accepts an
 *      `orgMemberships` prop and renders an "Organizations" section
 *      in the popover when non-empty.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B4 — filter + nav consistency', () => {
    describe('Documents filter placement', () => {
        const src = read(
        );

        it('docs tab carries a search input', () => {
            // The search input lives ABOVE the table inside the
            // documents tab block. Anchor on the id so unrelated
            // search inputs don't false-match.
            expect(src).toMatch(/id="doc-search-input"/);
            // T09 i18n — placeholder routes through next-intl
            // (`t('searchDocuments')`); the literal lives in messages/en.json.
            expect(src).toMatch(/placeholder=\{\w+\(['"]searchDocuments['"]\)\}/);
        });

        it('docs tab carries a type filter combobox', () => {
            expect(src).toMatch(/id="doc-type-filter"/);
            expect(src).toMatch(/DOC_TYPE_FILTER_OPTIONS/);
        });

        it('filter row positions search-left, action-right', () => {
            // Anchor on the "DOCUMENTS" comment block so the
            // structural shape is locked relative to the tab. The
            // slice window grew in B8 — the folder filter Combobox
            // + the folder input inside the form push the
            // `add-doc-btn` position past the original 2500-char
            // budget. 6000 keeps headroom for one more inline field.
            const start = src.indexOf('{/* DOCUMENTS */}');
            const block = src.slice(start, start + 6000);
            // Search input comes BEFORE the Add document button.
            const searchIdx = block.indexOf('doc-search-input');
            const addIdx = block.indexOf('id="add-doc-btn"');
            expect(searchIdx).toBeGreaterThan(0);
            expect(addIdx).toBeGreaterThan(searchIdx);
            // The shared parent uses `justify-between` so the two
            // groups sit at opposite ends of the row.
            expect(block).toMatch(/justify-between/);
        });

        it('docs list is filtered by both search and type', () => {
            const start = src.indexOf('<VendorDocsTable');
            // B8 — folder filter sits between the table mount and
            // the docs.filter() lambda; the slice has to span it.
            const block = src.slice(start, start + 1600);
            expect(block).toMatch(/docs\.filter\(/);
            expect(block).toMatch(/docTypeFilter/);
            expect(block).toMatch(/docSearch/);
        });
    });

    describe('Clauses entry-point lives on the Audits page', () => {
        const audits = read(
        );

        it('Audits header carries a Clauses link', () => {
            expect(audits).toMatch(/id="audits-clauses-link"/);
            expect(audits).toMatch(
                /href=\{`\/t\/\$\{tenantSlug\}\/clauses`\}/,
            );
        });

        it('Clauses link sits adjacent to the Frameworks link', () => {
            const fwIdx = audits.indexOf('id="audits-frameworks-link"');
            const clIdx = audits.indexOf('id="audits-clauses-link"');
            expect(fwIdx).toBeGreaterThan(0);
            expect(clIdx).toBeGreaterThan(0);
            // Sibling ordering: Frameworks first, Clauses next —
            // matches the user's "Clauses next to Frameworks" intent.
            expect(clIdx).toBeGreaterThan(fwIdx);
            // The two should be within the same actions array
            // (~800 chars apart in practice).
            expect(clIdx - fwIdx).toBeLessThan(2000);
        });
    });

    describe('Workspace switcher shows organizations', () => {
        const switcher = read(
            'src/components/layout/tenant-switcher.tsx',
        );
        const topChrome = read('src/components/layout/TopChrome.tsx');
        const layout = read(
            'src/app/t/[tenantSlug]/(app)/layout.tsx',
        );

        it('TenantSwitcher declares the orgMemberships prop', () => {
            expect(switcher).toMatch(
                /orgMemberships\?:\s*TenantSwitcherOrgMembership\[\]/,
            );
            expect(switcher).toMatch(
                /export interface TenantSwitcherOrgMembership/,
            );
        });

        it('popover renders an Organizations section when non-empty', () => {
            // Anchor on the header copy + per-row testid + the
            // org route href. A regression that collapses the
            // section would miss at least one of these probes.
            // T04 i18n — the header moved behind t('organizations'); match
            // the t() reference and cross-check the en.json copy.
            expect(switcher).toMatch(/t\(['"]organizations['"]\)/);
            expect(JSON.parse(read('messages/en.json')).switcher.organizations).toBe('Organizations');
            expect(switcher).toMatch(/tenant-switcher-org-/);
            expect(switcher).toMatch(/href=\{`\/org\/\$\{o\.slug\}`\}/);
        });

        it('TopChrome accepts and forwards orgMemberships', () => {
            expect(topChrome).toMatch(/orgMemberships\?:\s*Array</);
            expect(topChrome).toMatch(
                /orgMemberships=\{user\.orgMemberships\s*\?\?\s*\[\]\}/,
            );
        });

        it('tenant-layout threads session.user.orgMemberships through', () => {
            expect(layout).toMatch(
                /orgMemberships:\s*session\.user\.orgMemberships/,
            );
        });
    });
});

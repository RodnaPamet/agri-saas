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

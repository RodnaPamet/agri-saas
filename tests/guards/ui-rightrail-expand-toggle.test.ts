/**
 * UI roadmap 13 — practices Browse right-rail expand toggle.
 *
 * The "Expand all / Collapse all" TEXT button is now a single left-aligned
 * chevron toggle: ChevronDown when every section is expanded, ChevronLeft when
 * collapsed. The hint rides a canonical <Tooltip>; the E2E test-id is preserved.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = fs.readFileSync(
    path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)/practices/PracticesClient.tsx'),
    'utf8',
);

describe('UI-13 — browse expand toggle is a chevron, not a text button', () => {
    it('renders ChevronDown when expanded and ChevronLeft when collapsed', () => {
        expect(SRC).toMatch(/allExpanded \? <ChevronDown \/> : <ChevronLeft \/>/);
        expect(SRC).toMatch(/ChevronDown,\s*ChevronLeft/);
    });
    it('is left-aligned (justify-start), not the old right-aligned text button', () => {
        // The toggle block is left-aligned now (was justify-end).
        expect(SRC).toContain('flex justify-start');
        expect(SRC).toContain('practices-browse-expand-all');
        // The visible button label is no longer the literal text — it's an icon
        // with the hint on aria-label / Tooltip.
        expect(SRC).not.toMatch(/>\s*\{allExpanded \? 'Collapse all' : 'Expand all'\}\s*</);
    });
    it('keeps the canonical Tooltip hint + preserved test-id + aria-label', () => {
        // i18n batch T07 — the Collapse/Expand copy routes through
        // next-intl (`t('list.collapseAll')` / `t('list.expandAll')`);
        // assert the keys are wired AND the en.json values preserve copy.
        expect(SRC).toMatch(/<Tooltip\s+content=\{allExpanded \? t\('list\.collapseAll'\) : t\('list\.expandAll'\)\}/);
        expect(SRC).toMatch(/data-testid="practices-browse-expand-all"/);
        expect(SRC).toMatch(/aria-label=\{allExpanded \? t\('list\.collapseAll'\) : t\('list\.expandAll'\)\}/);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const en = require('../../messages/en.json').practices.list;
        expect(en.collapseAll).toBe('Collapse all');
        expect(en.expandAll).toBe('Expand all');
    });
});

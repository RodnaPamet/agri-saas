/**
 * VR-9 — Practice-page AI rule-suggestions ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-9 — practice AI suggestions', () => {
    it('the suggester usecase + route exist', () => {
        expect(exists('src/app-layer/usecases/automation-suggestions.ts')).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/ai/automation-suggestions/route.ts'),
        ).toBe(true);
        const uc = read('src/app-layer/usecases/automation-suggestions.ts');
        expect(uc).toMatch(/export function rankRuleSuggestions/);
        expect(uc).toMatch(/assertCanReadAutomation/);
        // excludes already-covered events
        expect(uc).toMatch(/coveredEvents/);
    });

    it('the rail component is mounted in the Practice detail page right rail', () => {
        const rail = 'src/components/automation/AutomationSuggestionsRail.tsx';
        expect(exists(rail)).toBe(true);
        const page = read('src/app/t/[tenantSlug]/(app)/practices/[practiceId]/page.tsx');
        expect(page).toMatch(/AutomationSuggestionsRail/);
        expect(page).toMatch(/rail=\{/);
        expect(page).toMatch(/surfaceKey="practices-detail-ai"/);
    });
});

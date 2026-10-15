/**
 * Automation Epic 8 — structural ratchet for the template library.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
// Comments blanked before matching (#1774). Comments only, NOT strings:
// an assertion about a string LITERAL would pass vacuously under
// `{ strings: true }`, which is why this stays a per-file decision.
const read = (p: string) =>
    blankNonCode(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Automation Epic 8 — template library', () => {
    it('templates data + usecase + route + modal exist', () => {
        expect(exists('src/data/automation-templates/index.ts')).toBe(true);
        expect(exists('src/app-layer/usecases/automation-templates.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/automation/templates/route.ts')).toBe(true);
        expect(exists('src/components/processes/TemplateLibraryModal.tsx')).toBe(true);
    });

    it('the route lists (GET) + imports (POST) templates via the usecase', () => {
        const src = read('src/app/api/t/[tenantSlug]/automation/templates/route.ts');
        expect(src).toMatch(/export const GET/);
        expect(src).toMatch(/export const POST/);
        expect(src).toMatch(/automation-templates/);
        expect(src).not.toMatch(/AUTOMATION_TEMPLATES/); // goes through the usecase, not raw data
    });

    it('import creates a DRAFT rule', () => {
        expect(read('src/app-layer/usecases/automation-templates.ts')).toMatch(/status: 'DRAFT'/);
    });

    it('RulesTab mounts the template library', () => {
        expect(read('src/app/t/[tenantSlug]/(app)/processes/RulesTab.tsx')).toMatch(
            /TemplateLibraryModal/,
        );
    });
});

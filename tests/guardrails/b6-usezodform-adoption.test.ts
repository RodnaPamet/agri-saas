/**
 * B6 — Phase 3 useZodForm adoption ratchet.
 *
 *   1. The `useZodForm` hook lives at `src/lib/hooks/use-zod-form.ts`
 *      and exposes the full contract the user asked for
 *      (`values`, `setField`, `touchField`, `fieldError`,
 *      `canSubmit`).
 *   2. Frontend-safe Zod schemas exist for every adopted entity
 *      under `src/lib/schemas/`.
 *   3. At least four modal form hooks compose useZodForm — vendor,
 *      task, asset, audit.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B6 — Phase 3 useZodForm adoption', () => {
    describe('useZodForm primitive', () => {
        const src = read('src/lib/hooks/use-zod-form.ts');

        it('exports the hook + the option / return types', () => {
            expect(src).toMatch(/export function useZodForm</);
            expect(src).toMatch(/export interface UseZodFormOptions/);
            expect(src).toMatch(/export interface UseZodFormReturn/);
        });

        it('exposes the full contract: values · setField · touchField · fieldError · canSubmit', () => {
            const block = src.slice(
                src.indexOf('export interface UseZodFormReturn'),
                src.indexOf('export function useZodForm'),
            );
            expect(block).toMatch(/values:/);
            expect(block).toMatch(/setField:/);
            expect(block).toMatch(/touchField:/);
            expect(block).toMatch(/fieldError:/);
            expect(block).toMatch(/canSubmit:/);
            expect(block).toMatch(/submit:/);
            expect(block).toMatch(/submitting:/);
            expect(block).toMatch(/isDirty:/);
        });

        it('uses Zod safeParse and field-level error scoping', () => {
            expect(src).toMatch(/safeParse/);
            expect(src).toMatch(/parseResult\.error\.issues/);
        });
    });

    describe('Frontend-safe schemas in src/lib/schemas/', () => {
        const ENTITIES = ['vendor', 'task', 'asset', 'audit'] as const;
        for (const entity of ENTITIES) {
            it(`${entity}-form.ts schema exists + exports the export shape`, () => {
                const src = read(`src/lib/schemas/${entity}-form.ts`);
                expect(src).toMatch(/import \{ z \} from ['"]zod['"]/);
                const exportName =
                    `New${entity.charAt(0).toUpperCase() + entity.slice(1)}FormSchema`;
                expect(src).toMatch(
                    new RegExp(`export const ${exportName}\\b`),
                );
            });
        }
    });

    describe('Canonical 6-tab structure on detail pages (B6 +1)', () => {
        // The user asked for risks + assets to wear the same submenu
        // structure as controls: Overview, Tasks, Evidence, Mappings,
        // Traceability, Activity. (A seventh tab, Tests, was dropped in the
        // compliance uproot along with the test-plan feature it opened.)
        const CANONICAL_TABS = [
            'overview',
            'tasks',
            'evidence',
            'mappings',
            'traceability',
            'activity',
        ] as const;
        // RQ2-4: Risks left the canonical 7-tab club — its IA is now
        // assessment-centric (Overview · Assessment · Quantification ·
        // Bow-Tie · History · Tasks · Evidence · Traceability), locked
        // by tests/guards/rq2-4-assessment-ia.test.ts.
        const PAGES: Array<{ label: string; file: string }> = [
            {
                label: 'Controls (canonical)',
                file: 'src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx',
            },
            {
                label: 'Assets',
                file: 'src/app/t/[tenantSlug]/(app)/assets/[id]/page.tsx',
            },
        ];

        for (const { label, file } of PAGES) {
            it(`${label} declares the 6-tab Tab union`, () => {
                const src = read(file);
                for (const t of CANONICAL_TABS) {
                    expect(src).toMatch(new RegExp(`['"]${t}['"]`));
                }
            });

            it(`${label} passes tabs to EntityDetailLayout`, () => {
                const src = read(file);
                expect(src).toMatch(/tabs=\{tabs\}/);
                // Each page uses its own local state name (controls
                // calls it `tab`, risks/assets call it `activeTab`);
                // either is fine as long as the prop is wired.
                expect(src).toMatch(/activeTab=\{(activeTab|tab)\}/);
                expect(src).toMatch(/onTabChange=/);
            });
        }
    });

    describe('Four modal form hooks adopt useZodForm', () => {
        const HOOKS: Array<{ label: string; file: string }> = [
            {
                label: 'vendor',
                file: 'src/app/t/[tenantSlug]/(app)/vendors/_form/useNewVendorForm.ts',
            },
            {
                label: 'task',
                file: 'src/components/tasks/_form/useNewTaskForm.ts',
            },
            {
                label: 'asset',
                file: 'src/app/t/[tenantSlug]/(app)/assets/_form/useNewAssetForm.ts',
            },
            {
                label: 'audit',
                file: 'src/app/t/[tenantSlug]/(app)/audits/_form/useNewAuditForm.ts',
            },
        ];

        for (const { label, file } of HOOKS) {
            it(`${label} hook composes useZodForm`, () => {
                const src = read(file);
                expect(src).toMatch(/from ['"]@\/lib\/hooks\/use-zod-form['"]/);
                expect(src).toMatch(/useZodForm\(/);
                expect(src).toMatch(/from ['"]@\/lib\/schemas\//);
            });

            it(`${label} hook preserves the legacy fields/setField contract`, () => {
                const src = read(file);
                // Either expose zod's values directly, OR wrap zod's
                // values with extras (the task hook merges extras
                // outside the schema). Both shapes are valid as
                // long as the caller's `form.fields.X` access works.
                const directExposure = /fields:\s*zod\.values/.test(src);
                const mergedExposure =
                    /const fields:[^=]+=\s*\{[\s\S]{0,200}\.\.\.zod\.values/.test(src) &&
                    /\bfields,/.test(src);
                expect(directExposure || mergedExposure).toBe(true);
                // The hook must still expose the canonical surface
                // (even if it intermediates setField / touchField /
                // fieldError for type-narrowing).
                expect(src).toMatch(/setField/);
                expect(src).toMatch(/touchField/);
                expect(src).toMatch(/fieldError/);
                expect(src).toMatch(/canSubmit/);
            });
        }
    });
});

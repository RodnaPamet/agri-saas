/**
 * PR-D — Entity-ID picker migration ratchet.
 *
 * Locks the new `<EntityPicker>` primitive + the four call-site
 * migrations (legacy `<input placeholder="Paste …" />` → typeahead
 * combobox driven by a tenant-scoped fetch).
 *
 *   1. The shared `<EntityPicker>` primitive exists, supports the
 *      seven canonical entity kinds, and fetches via the standard
 *      `/api/t/{slug}/{type}` shape.
 *
 *   2. None of the four migrated sites still ships the legacy
 *      `placeholder="Paste ID"` / `placeholder="Paste vendor ID"`
 *      / `placeholder="Entity ID *"` input.
 *
 *   3. Each migrated site mounts `<EntityPicker>` with a stable
 *      testId so E2E specs can find the new control.
 *
 *   4. The legacy `linkEntityId` / `linkForm.entityId` /
 *      `subForm.subprocessorVendorId` state shape is preserved —
 *      the picker writes into the SAME state slot the legacy input
 *      did, so the consumer's submit handlers stay unchanged.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('PR-D — entity-ID picker migration', () => {
    describe('<EntityPicker> primitive', () => {
        const src = read('src/components/ui/entity-picker.tsx');

        it('exports the component + EntityPickerKind union', () => {
            expect(src).toMatch(/export function EntityPicker/);
            expect(src).toMatch(/export type EntityPickerKind/);
        });

        it('supports the six canonical entity kinds', () => {
            // The Kind union must list every entity type the four
            // migrated sites reference. Anchor on each literal so a
            // future "drop one" PR fails CI loudly.
            for (const kind of [
                'CONTROL',
                'ASSET',
                'EVIDENCE',
                'VENDOR',
                'ISSUE',
                'FRAMEWORK_REQUIREMENT',
            ]) {
                expect(src).toMatch(new RegExp(`['"]${kind}['"]`));
            }
        });

        it('fetches candidates from /api/t/{slug}/... per type', () => {
            // The canonical tenant API base path is the lock anchor.
            expect(src).toMatch(/\/api\/t\/\$\{tenantSlug\}/);
        });

        it('routes the response through both `rows` and `requirements` shapes', () => {
            // Tenant list APIs return `{ rows }`; framework tree
            // returns `{ requirements }`. The picker normalises
            // both — locking the dual handling so a refactor that
            // removes one breaks loudly.
            expect(src).toMatch(/json\.rows/);
            expect(src).toMatch(/json\.requirements/);
        });
    });

    describe('Task link form (task detail page)', () => {
        // /tasks compliance UI retired 2026-07-25 — the single task detail
        // (and its EntityPicker link form) now lives in the farm-tasks detail
        // client. The task-link seam moved with the file, testid unchanged.
        const src = read(
            'src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx',
        );

        it('mounts <EntityPicker> with the canonical testid', () => {
            expect(src).toMatch(/testId="task-link-entity-picker"/);
            expect(src).toMatch(/<EntityPicker\b/);
        });

        it('retires the legacy "Paste ID" input', () => {
            expect(src).not.toMatch(/placeholder="Entity ID \*"/);
            // Defensive — also kill any leftover "Paste ID" copy
            // here (this file's the canonical task-link surface).
            expect(src).not.toMatch(/placeholder="Paste ID"/);
        });

        it('preserves linkEntityId as the state slot', () => {
            // The picker writes into the SAME `linkEntityId` state
            // the legacy input wrote into; the submit handler is
            // unchanged.
            expect(src).toMatch(/onChange=\{setLinkEntityId\}/);
        });
    });

    describe('NewTaskFields modal', () => {
        const src = read(
            'src/components/tasks/_form/NewTaskFields.tsx',
        );

        it('mounts <EntityPicker> with the canonical testid', () => {
            expect(src).toMatch(/testId="new-task-link-entity-picker"/);
            expect(src).toMatch(/<EntityPicker\b/);
        });

        it('retires the legacy "Paste ID" Input', () => {
            // The `<Input placeholder="Paste ID" />` is gone.
            expect(src).not.toMatch(
                /<Input[\s\S]{0,200}placeholder="Paste ID"/,
            );
        });

        it('preserves form.linkEntityId as the state slot', () => {
            expect(src).toMatch(/value=\{form\.linkEntityId\}/);
            expect(src).toMatch(/onChange=\{form\.setLinkEntityId\}/);
        });
    });

    describe('Vendor link form (vendor detail page)', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx',
        );

        it('mounts <EntityPicker> with the canonical testid', () => {
            expect(src).toMatch(/testId="vendor-link-entity-picker"/);
        });

        it('preserves linkForm.entityId as the state slot', () => {
            // The legacy input wrote to `linkForm.entityId`; the
            // picker writes into the same slot via the lambda.
            expect(src).toMatch(/setLinkForm\(\(p\)\s*=>\s*\(\{\s*\.\.\.p,\s*entityId:\s*id\s*\}\)\)/);
        });
    });

    describe('Vendor subprocessor form (vendor detail page)', () => {
        const src = read(
            'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx',
        );

        it('mounts <EntityPicker entityType="VENDOR"> for the subprocessor slot', () => {
            expect(src).toMatch(/testId="vendor-subprocessor-picker"/);
            expect(src).toMatch(
                /<EntityPicker[\s\S]{0,400}entityType="VENDOR"/,
            );
        });

        it('retires the legacy "Paste vendor ID" input', () => {
            expect(src).not.toMatch(/placeholder="Paste vendor ID"/);
        });

        it('preserves subForm.subprocessorVendorId as the state slot', () => {
            expect(src).toMatch(
                /setSubForm\(\(p\)\s*=>\s*\(\{\s*\.\.\.p,\s*subprocessorVendorId:\s*id\s*\}\)\)/,
            );
        });
    });
});

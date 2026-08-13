/**
 * Modal-form P1 — structural lock that the four entity form
 * extractions (`use<Entity>Form` + `<Entity>Fields`) exist and
 * compose the canonical pattern. P2 adds the modal wrappers; P3
 * hardens a11y/focus/unsaved-state. See
 * `docs/implementation-notes/2026-05-24-modal-form-architecture.md`.
 *
 * This is a structural test, not a deep behavioural one — the
 * full-page wrappers (`tasks` modal, `assets/[id]`) cover the
 * existing user-facing flows via E2E. The job here is to keep the
 * extracted seam intact so the P2 modal migration has a stable
 * contract to bolt onto.
 *
 * GRC teardown phase 2 deleted the policies and vendors surfaces
 * (models, pages, routes and their `_form/` extractions), so two of
 * the original four flows are gone. The tasks + assets flows below
 * still exercise every assertion in this file — including both P2
 * sub-contracts (the `/new` redirect shim and the list client that
 * auto-opens on `?create=1`), which are re-pointed at the surviving
 * assets equivalents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)');

interface Extraction {
    /** Human-readable label for the assertion error message. */
    name: string;
    /** Relative to APP root. */
    hookPath: string;
    /** Relative to APP root. */
    fieldsPath: string;
    /** Exported hook name (`useFooForm`). */
    hookExport: string;
    /** Exported component name (`FooFields`). */
    fieldsExport: string;
    /** Each return-shape key the hook must surface to the wrappers. */
    requiredReturnKeys: string[];
    /** Page that must wire the hook + fields (refactored in P1). */
    pageWrapperPath: string;
}

// GRC teardown phase 2 removed the `policies (create)` and
// `vendors (create)` extractions with their surfaces — both entities
// and every file they named are deleted.
const EXTRACTIONS: Extraction[] = [
    {
        name: 'tasks (create)',
        // Relocated out of the app dir to src/components/tasks/ when the
        // /tasks compliance UI was retired (the modal is shared by calendar +
        // LinkedTasksPanel). Paths reach up out of APP to src/components/.
        hookPath: '../../../../components/tasks/_form/useNewTaskForm.ts',
        fieldsPath: '../../../../components/tasks/_form/NewTaskFields.tsx',
        hookExport: 'useNewTaskForm',
        fieldsExport: 'NewTaskFields',
        requiredReturnKeys: [
            'fields',
            'setField',
            'pendingLinks',
            'addPendingLink',
            'removePendingLink',
            'submitting',
            'error',
            'canSubmit',
            'validationMessage',
            'submit',
        ],
        pageWrapperPath: '../../../../components/tasks/NewTaskModal.tsx',
    },
    {
        name: 'assets (edit)',
        hookPath: 'assets/_form/useEditAssetForm.ts',
        fieldsPath: 'assets/_form/EditAssetFields.tsx',
        hookExport: 'useEditAssetForm',
        fieldsExport: 'EditAssetFields',
        requiredReturnKeys: [
            'fields',
            'setField',
            'submitting',
            'error',
            'canSubmit',
            'submit',
        ],
        // Modal-form P2 — the asset detail page launches EditAssetModal
        // from its header; the modal composes the hook + fields.
        pageWrapperPath: 'assets/EditAssetModal.tsx',
    },
];

function read(rel: string): string {
    return fs.readFileSync(path.join(APP, rel), 'utf8');
}

describe.each(EXTRACTIONS)('modal-form extraction — $name', (extraction) => {
    it('the hook file exists and exports the named hook', () => {
        const src = read(extraction.hookPath);
        expect(src).toMatch(new RegExp(`export function ${extraction.hookExport}\\b`));
    });

    it('the hook return shape carries every key the wrappers compose against', () => {
        const src = read(extraction.hookPath);
        for (const key of extraction.requiredReturnKeys) {
            // Look for the key on the return object — `key,` or `key:` form.
            const re = new RegExp(`\\b${key}\\b\\s*[:,}]`);
            expect(src).toMatch(re);
        }
    });

    it('the fields component file exists and exports the named component', () => {
        const src = read(extraction.fieldsPath);
        expect(src).toMatch(
            new RegExp(`export function ${extraction.fieldsExport}\\b`),
        );
    });

    it('the fields component reads from a form prop typed as the hook return', () => {
        // Canonical pattern: the fields component receives
        // `{ form: <HookReturn> }` and reads `form.fields.<key>` /
        // `form.setField(...)`. The structural check is that the
        // component never declares its own form state — it must be
        // controlled. `useState` would indicate state leakage.
        const src = read(extraction.fieldsPath);
        expect(src).not.toMatch(/\buseState\s*\(/);
        expect(src).toMatch(/\bform\.fields\b|\bform\.setField\b/);
    });

    it('the page wrapper composes the hook + fields', () => {
        const src = read(extraction.pageWrapperPath);
        expect(src).toContain(extraction.hookExport);
        expect(src).toContain(extraction.fieldsExport);
    });

    it('the page wrapper does not re-declare the hook state inline', () => {
        // Page wrappers must not maintain a parallel `useState` set for
        // the same form fields — the hook is the single source.
        // (`useState` is allowed for non-form chrome like tab state.)
        const src = read(extraction.pageWrapperPath);
        // Heuristic — bare `setTitle`/`setName`/`setForm` calls in the
        // page wrapper indicate the old inline form survived.
        expect(src).not.toMatch(/\bsetForm\(/);
    });
});

// ─── P2 — modal wrappers + redirect shims ───────────────────────────

describe('modal-form P2 — modal wrappers exist', () => {
    // GRC teardown phase 2 deleted NewPolicyModal + NewVendorModal with
    // their surfaces.
    const MODALS = [
        {
            label: 'NewTaskModal',
            file: 'src/components/tasks/NewTaskModal.tsx',
        },
        {
            label: 'EditAssetModal',
            file: 'src/app/t/[tenantSlug]/(app)/assets/EditAssetModal.tsx',
        },
    ];

    it.each(MODALS)('$label exists and mounts <Modal>', (m) => {
        const full = path.join(ROOT, m.file);
        expect(fs.existsSync(full)).toBe(true);
        const src = fs.readFileSync(full, 'utf8');
        // Composes the canonical Modal.Form shell (matches the
        // NewRiskModal Epic 54 precedent).
        expect(src).toMatch(/<Modal\b/);
        expect(src).toMatch(/Modal\.Form\b/);
        expect(src).toMatch(/Modal\.Actions\b/);
        // Mounts the P1 hook + fields (the seam).
        expect(src).toMatch(/use[A-Z]\w*Form\(/);
        expect(src).toMatch(/<[A-Z]\w*Fields\b/);
    });
});

describe('modal-form P2 — /new routes are redirect shims', () => {
    // GRC teardown phase 2 deleted `policies/new` + `vendors/new`, the two
    // shims this ratchet originally pinned. Re-pointed at `assets/new`,
    // which is the same shim built to the same pattern, so the contract
    // (redirect to `?create=1`, no form primitives left behind) is still
    // enforced instead of dropped.
    const REDIRECTS = [
        {
            label: 'assets/new',
            file: 'src/app/t/[tenantSlug]/(app)/assets/new/page.tsx',
            target: '/assets?create=1',
        },
    ];

    it.each(REDIRECTS)('$label → ?create=1 shim', (r) => {
        const full = path.join(ROOT, r.file);
        expect(fs.existsSync(full)).toBe(true);
        const src = fs.readFileSync(full, 'utf8');
        expect(src).toMatch(/redirect\(/);
        expect(src).toContain(r.target);
        // The shim must NOT mount any form primitives — that's the
        // tell-tale that it's still a full page instead of a redirect.
        expect(src).not.toMatch(/<FormField\b/);
        expect(src).not.toMatch(/useState\b/);
    });
});

describe('modal-form P2 — list clients open the modal on ?create=1', () => {
    // GRC teardown phase 2 deleted PoliciesClient + VendorsClient.
    // Re-pointed at AssetsClient, the surviving list client wired to the
    // same `?create=1` → open-modal → strip-flag contract.
    const CLIENTS = [
        {
            label: 'AssetsClient',
            file: 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx',
            modal: 'NewAssetModal',
        },
    ];

    it.each(CLIENTS)('$label mounts $modal + auto-opens on ?create=1', (c) => {
        const full = path.join(ROOT, c.file);
        expect(fs.existsSync(full)).toBe(true);
        const src = fs.readFileSync(full, 'utf8');
        // Mounts the modal.
        expect(src).toContain(c.modal);
        expect(src).toMatch(new RegExp(`<${c.modal}\\b`));
        // Reads the `?create=1` flag.
        expect(src).toMatch(/useSearchParams\b/);
        // `[\s\S]*` substitutes for the `/s` (dotAll) flag — the
        // project tsconfig targets ES2017 and rejects ES2018 regex
        // flags. `dotAll`-style match across newlines is what we
        // want for this multi-line ratchet.
        expect(src).toMatch(/searchParams[\s\S]*create[\s\S]*===[\s\S]*1/);
        // Strips the flag after open (router.replace with the flag deleted).
        expect(src).toMatch(/router\.replace\(/);
        expect(src).toMatch(/next\.delete\(['"]create['"]\)/);
    });
});

describe('modal-form architecture — design doc anchor', () => {
    it('the design-doc lives at the documented path', () => {
        const docPath = path.join(
            ROOT,
            'docs/implementation-notes/2026-05-24-modal-form-architecture.md',
        );
        expect(fs.existsSync(docPath)).toBe(true);
    });

    it('the design doc names every entity covered by P1', () => {
        const docPath = path.join(
            ROOT,
            'docs/implementation-notes/2026-05-24-modal-form-architecture.md',
        );
        const content = fs.readFileSync(docPath, 'utf8');
        for (const e of EXTRACTIONS) {
            // Look for the entity name (without `(create)` / `(edit)`).
            const entity = e.name.split(' ')[0];
            expect(content.toLowerCase()).toContain(entity);
        }
    });
});

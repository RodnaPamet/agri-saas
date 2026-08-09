/**
 * Epic 54 — Create Control modal migration contract.
 *
 * Node-env jest can't render .tsx, so this suite source-inspects the
 * migrated surface:
 *
 *   1. The modal component exists, uses the shared <Modal> primitives,
 *      and composes Body / Actions through <Modal.Form>.
 *   2. Every existing E2E form ID is preserved so the pre-migration test
 *      suite continues to pass untouched (no ratchet bump required).
 *   3. Business behaviour is intact — same POST body, same applicability
 *      follow-up, same post-create navigation, same React-Query cache
 *      invalidation.
 *      so deep links keep working against the modal-based flow.
 *   5. ControlsClient wires the trigger + auto-opens on `?create=1`.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const MODAL_SRC = read('src/app/t/[tenantSlug]/(app)/controls/NewControlModal.tsx');
const CLIENT_SRC = read('src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');

// ─── 1. Modal composition ────────────────────────────────────────

describe('NewControlModal — shared Modal composition', () => {
    it('is a client component', () => {
        expect(MODAL_SRC).toMatch(/^'use client'/);
    });

    it('imports the shared Modal (not a bespoke overlay)', () => {
        expect(MODAL_SRC).toMatch(/from ['"]@\/components\/ui\/modal['"]/);
        expect(MODAL_SRC).not.toMatch(/fixed inset-0 bg-black/);
    });

    it('renders <Modal.Form> + <Modal.Body> + <Modal.Actions>', () => {
        expect(MODAL_SRC).toMatch(/<Modal\.Form\b/);
        expect(MODAL_SRC).toMatch(/<Modal\.Body\b/);
        expect(MODAL_SRC).toMatch(/<Modal\.Actions\b/);
    });

    it('uses size="lg" so the CRUD form breathes', () => {
        expect(MODAL_SRC).toMatch(/size=["']lg["']/);
    });

    it('passes title + description for a11y naming (via next-intl)', () => {
        // i18n batch T07 — the modal title/description now route through
        // next-intl. Assert the keys are wired AND the en.json values
        // preserve the original English copy (E2E getByText contract).
        expect(MODAL_SRC).toMatch(/title=\{t\(['"]newModal\.title['"]\)\}/);
        expect(MODAL_SRC).toMatch(/description=\{t\(['"]newModal\.description['"]\)\}/);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const en = require('../../messages/en.json').controls.newModal;
        expect(en.title).toBe('New control');
        expect(en.description).toBe('Create a custom control for your register.');
    });

    it('guards close-during-save via preventDefaultClose tied to RHF isSubmitting', () => {
        // After Epic 64-FORM (RHF + zodResolver migration), the save-in-progress
        // signal comes from RHF's `formState.isSubmitting` instead of a hand-rolled
        // `saving` useState. Either name is acceptable as long as the prop is
        // wired to the live submit-pending flag.
        expect(MODAL_SRC).toMatch(
            /preventDefaultClose=\{(saving|isSubmitting)\}/,
        );
    });
});

// ─── 2. E2E ID preservation ──────────────────────────────────────

describe('NewControlModal — preserved E2E IDs', () => {
    const REQUIRED_IDS = [
        'control-name-input',
        'control-code-input',
        'control-description-input',
        'control-category-input',
        'control-frequency-input',
        'control-justification-input',
        'create-control-btn',
    ];

    it.each(REQUIRED_IDS)('preserves id="%s"', (id) => {
        expect(MODAL_SRC).toMatch(new RegExp(`id=["']${id}["']`));
    });

    it('adds a cancel affordance with a dedicated id', () => {
        expect(MODAL_SRC).toMatch(/id=["']new-control-cancel-btn["']/);
    });
});

// ─── 3. Business behaviour preserved ─────────────────────────────

describe('NewControlModal — business behaviour preserved', () => {
    it('POSTs to /controls with the documented payload shape', () => {
        expect(MODAL_SRC).toMatch(/apiUrl\(['"]\/controls['"]\)/);
        expect(MODAL_SRC).toMatch(/method:\s*['"]POST['"]/);
        // Same fields as the legacy page: name, optional code, description,
        // category, frequency, isCustom=true. After the RHF migration the
        // payload is built from RHF's `values.<field>` instead of the
        // useState `form.<field>` — match either shape.
        expect(MODAL_SRC).toMatch(/name:\s*(form|values)\.name/);
        expect(MODAL_SRC).toMatch(
            /code:\s*(form|values)\.code[\s\S]*\|\|\s*undefined/,
        );
        expect(MODAL_SRC).toMatch(/isCustom:\s*true/);
    });

    it('follows up with the applicability POST when user chose NOT_APPLICABLE', () => {
        // After RHF migration, the conditional reads from `values.applicability`
        // rather than the local useState; the resulting record id is bound to
        // either `control` (legacy) or `created` (new).
        expect(MODAL_SRC).toMatch(
            /(applicability|values\.applicability)\s*===\s*['"]NOT_APPLICABLE['"]/,
        );
        expect(MODAL_SRC).toMatch(
            /apiUrl\(`\/controls\/\$\{(control|created)\.id\}\/applicability`\)/,
        );
    });

    it('invalidates the Controls react-query cache on success', () => {
        expect(MODAL_SRC).toMatch(/queryClient\.invalidateQueries/);
        expect(MODAL_SRC).toMatch(/queryKeys\.controls\.all\(tenantSlug\)/);
    });

    it('navigates to the new control detail page after create (preserves downstream E2E chain)', () => {
        // `control` was the legacy variable name; `created` is the RHF-era
        // name. Either is acceptable as long as the navigation target is
        // the new entity's detail page.
        expect(MODAL_SRC).toMatch(
            /router\.push\(tenantHref\(`\/controls\/\$\{(control|created)\.id\}`\)\)/,
        );
    });

    it('surfaces API error messages in an alert region', () => {
        expect(MODAL_SRC).toMatch(/role=["']alert["']/);
        expect(MODAL_SRC).toMatch(/id=["']new-control-error["']/);
        // Falls back to the shared "Failed to create control" message.
        expect(MODAL_SRC).toMatch(/Failed to create control/);
    });

    it('enforces required-name + NA-needs-justification via Zod', () => {
        // After Epic 64-FORM the form rules live in a Zod schema bound
        // to RHF via zodResolver — not in a hand-rolled `canSubmit`.
        // Locking the schema invariants here keeps the contract intact
        // regardless of form-state plumbing.
        // Required name:
        expect(MODAL_SRC).toMatch(/name:\s*z\.string\(\)\.min\(1/);
        // Cross-field rule for NOT_APPLICABLE → justification required:
        expect(MODAL_SRC).toMatch(/superRefine/);
        expect(MODAL_SRC).toMatch(/applicability === ['"]NOT_APPLICABLE['"]/);
        expect(MODAL_SRC).toMatch(/justification/);
    });
});

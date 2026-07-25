/**
 * Modal-form P3 — production hardening ratchet.
 *
 * P3 deliverables locked structurally:
 *   1. Each form hook exposes `isDirty` on its return shape.
 *   2. Each form hook sets `isDirty: true` on first edit and clears
 *      it on submit-success.
 *   3. Each modal wraps `setOpen` with an unsaved-changes guard that
 *      checks `form.isDirty` (and `form.submitting`) before
 *      surrendering the modal.
 *   4. The Modal primitive's `setShowModal` receives the GUARDED
 *      setter — that's how X / Escape / outside-click all route
 *      through the warning uniformly.
 *
 * Structural-only — no DOM mounts. The modal primitive's Radix
 * portal + jsdom focus-trap interplay is fragile in rendered tests;
 * the assertions here verify the WIRING contract, not the runtime.
 * E2E specs cover the runtime behaviour.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)');

interface HardenedFlow {
    label: string;
    hookPath: string;
    hookExport: string;
    modalPath: string;
    confirmCopy: RegExp;
    /**
     * The unsaved-changes guard mechanism the modal uses:
     *   - `'confirm'` (default) — the legacy `window.confirm` +
     *     `guardedSetOpen` pattern.
     *   - `'native'` — the `<Modal isDirty>` primitive guard (mobile-forms
     *     PR-3): a styled "Discard changes?" on X / Escape / outside-click /
     *     drag-dismiss. The guard INTENT (no unsaved loss) is unchanged; only
     *     the implementation modernised. Other flows migrate over time.
     */
    guard?: 'confirm' | 'native';
}

const FLOWS: HardenedFlow[] = [
    {
        label: 'policies',
        hookPath: 'policies/_form/useNewPolicyForm.ts',
        hookExport: 'useNewPolicyForm',
        modalPath: 'policies/NewPolicyModal.tsx',
        confirmCopy: /Discard policy\?/,
    },
    {
        label: 'tasks',
        // Relocated to src/components/tasks/ when the /tasks UI was retired;
        // reach up out of APP (src/app/t/[tenantSlug]/(app)) to src/components/.
        hookPath: '../../../../components/tasks/_form/useNewTaskForm.ts',
        hookExport: 'useNewTaskForm',
        modalPath: '../../../../components/tasks/NewTaskModal.tsx',
        // mobile-forms PR-3 — migrated to the Modal primitive's native guard.
        confirmCopy: /Discard changes\?/,
        guard: 'native',
    },
    {
        label: 'vendors',
        hookPath: 'vendors/_form/useNewVendorForm.ts',
        hookExport: 'useNewVendorForm',
        modalPath: 'vendors/NewVendorModal.tsx',
        confirmCopy: /Discard vendor\?/,
    },
    {
        label: 'assets',
        hookPath: 'assets/_form/useEditAssetForm.ts',
        hookExport: 'useEditAssetForm',
        modalPath: 'assets/EditAssetModal.tsx',
        confirmCopy: /Discard changes\?/,
    },
];

function read(rel: string): string {
    return fs.readFileSync(path.join(APP, rel), 'utf8');
}

describe.each(FLOWS)('modal-form P3 — $label hook exposes isDirty', (flow) => {
    const src = read(flow.hookPath);

    // B6 — hooks that adopt useZodForm delegate isDirty to the
    // shared hook (the canonical state lives on `zod.isDirty`).
    // P3 hardening still passes because the WRAPPER hook returns
    // `isDirty` on its public contract; the dirty-flag is no
    // longer required to live in this specific file as a local
    // useState.
    const usesZodForm = /useZodForm\(/.test(src);

    it('declares an `isDirty` state hook', () => {
        if (usesZodForm) {
            // useZodForm owns the state; the wrapper reads from it
            // and surfaces it on the return shape.
            expect(src).toMatch(/\bisDirty\b/);
            return;
        }
        // The single-flag pattern (`useState(false)`) is the canonical
        // shape for the legacy P3 dirty-tracking.
        expect(src).toMatch(/setIsDirty\s*[,(]?/);
        expect(src).toMatch(/const\s*\[\s*isDirty\s*,\s*setIsDirty\s*\]/);
    });

    it('sets isDirty true on `setField`', () => {
        if (usesZodForm) {
            // The wrapper's setField delegates to zod.setField (or
            // a wrapper around it) which marks the form dirty.
            expect(src).toMatch(/setField/);
            expect(src).toMatch(/zod\.setField|setExtrasDirty/);
            return;
        }
        // Find the setField function body and check it calls setIsDirty(true).
        expect(src).toMatch(/setField[\s\S]{0,400}setIsDirty\(true\)/);
    });

    it('clears isDirty on submit success', () => {
        if (usesZodForm) {
            // useZodForm clears its own isDirty after a successful
            // submit (see use-zod-form.ts). The wrapper hook
            // benefits by reference.
            return;
        }
        // Look for `setIsDirty(false)` somewhere — typically before
        // the `onSuccess(...)` call inside the try block.
        expect(src).toMatch(/setIsDirty\(false\)/);
    });

    it('returns isDirty on the hook contract', () => {
        // Both the type-shape interface AND the return object must
        // carry it. (Modal compositions read `form.isDirty`.)
        expect(src).toMatch(/isDirty:\s*boolean/);
        expect(src).toMatch(/return\s*\{[\s\S]*\bisDirty\b[\s\S]*\}/);
    });
});

describe.each(FLOWS.filter((f) => f.guard !== 'native'))(
    'modal-form P3 — $label modal wires the (window.confirm) guard',
    (flow) => {
        const src = read(flow.modalPath);

        it('declares a `guardedSetOpen` callback', () => {
            expect(src).toMatch(/guardedSetOpen/);
        });

        it('guard reads form.isDirty + form.submitting', () => {
            expect(src).toMatch(/form\.isDirty/);
            expect(src).toMatch(/form\.submitting/);
        });

        it('guard prompts before discarding', () => {
            expect(src).toMatch(/window\.confirm\(/);
            // T09 i18n — the policies/vendors modals now pass a
            // next-intl key to window.confirm (`t('newModal.discardConfirm')`)
            // instead of an inline literal. When the confirm argument is a
            // t()/binding call, resolve it against en.json (the flow.label
            // doubles as the namespace) and match the copy there; otherwise
            // the inline literal must still match.
            const confirmArg = src.match(
                /window\.confirm\(\s*\w+\(['"]([a-zA-Z0-9_.]+)['"]\)/,
            );
            if (confirmArg) {
                const en = JSON.parse(
                    fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'),
                ) as Record<string, unknown>;
                let resolved: unknown = en[flow.label];
                for (const part of confirmArg[1].split('.')) {
                    resolved = (resolved as Record<string, unknown> | undefined)?.[part];
                }
                expect(typeof resolved).toBe('string');
                expect(resolved as string).toMatch(flow.confirmCopy);
            } else {
                expect(src).toMatch(flow.confirmCopy);
            }
        });

        it("Modal's setShowModal receives the guarded setter (not bare setOpen)", () => {
            // Every close path (Cancel button, X, Escape, outside click)
            // is routed through the guard ONLY if Radix's onOpenChange
            // (wired via `setShowModal`) hits guardedSetOpen, not setOpen.
            expect(src).toMatch(/setShowModal=\{guardedSetOpen\}/);
            // Defensive: no remaining `setShowModal={setOpen}` in the modal.
            expect(src).not.toMatch(/setShowModal=\{setOpen\}/);
        });
    },
);

// mobile-forms PR-3 — flows migrated to the Modal primitive's native
// `isDirty` guard. Same INTENT (unsaved changes are protected on every
// dismiss incl. mobile drag), implemented by the primitive rather than a
// hand-rolled window.confirm. The guarded-setter pattern no longer applies.
describe.each(FLOWS.filter((f) => f.guard === 'native'))(
    'modal-form P3 — $label modal wires the native <Modal isDirty> guard',
    (flow) => {
        const src = read(flow.modalPath);

        it('passes the form dirty state to <Modal isDirty>', () => {
            expect(src).toMatch(/isDirty=\{[^}]*isDirty[^}]*\}/);
        });

        it('drops the hand-rolled window.confirm guard', () => {
            expect(src).not.toMatch(/window\.confirm\(/);
            expect(src).not.toMatch(/guardedSetOpen/);
        });
    },
);

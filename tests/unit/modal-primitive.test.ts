/**
 * Epic 54 — canonical Modal primitive contract.
 *
 * Complements `responsive-modal-sheet.test.ts` (foundation). This suite
 * pins the production-grade CRUD layer:
 *
 *   1. Size variants resolve to the documented Tailwind widths.
 *   2. Structured slots pin header/body/footer with independent scroll.
 *   3. Modal.Confirm renders a tone-driven icon + primary button, supports
 *      async onConfirm with pending semantics, and routes cancel consistently.
 *   4. Form sugar lets CRUD flows wire onSubmit without re-implementing
 *      focus / scroll gymnastics.
 *   5. Ratchet on bespoke `fixed inset-0 bg-black/…` overlays — they can
 *      exist during migration, but a guarded baseline prevents growth.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const MODAL_SRC = read('src/components/ui/modal.tsx');

// ─── 1. Size variants ────────────────────────────────────────────

describe('Modal — size variants via CVA', () => {
    it('uses class-variance-authority for the Dialog surface', () => {
        expect(MODAL_SRC).toMatch(/from ["']class-variance-authority["']/);
        expect(MODAL_SRC).toMatch(/modalContentVariants/);
        expect(MODAL_SRC).toMatch(/cva\(/);
    });

    it('defines the documented size vocabulary', () => {
        for (const size of ['xs', 'sm', 'md', 'lg', 'xl', 'full']) {
            expect(MODAL_SRC).toMatch(new RegExp(`\\b${size}:`));
        }
    });

    it('each size maps to a max-width Tailwind utility', () => {
        for (const utility of ['max-w-sm', 'max-w-md', 'max-w-lg', 'max-w-2xl', 'max-w-4xl']) {
            expect(MODAL_SRC).toContain(utility);
        }
    });

    it('default size is md (the CRUD baseline)', () => {
        expect(MODAL_SRC).toMatch(/defaultVariants:\s*\{\s*size:\s*["']md["']/);
    });

    it('caps total height so tall forms scroll instead of overflowing the viewport', () => {
        expect(MODAL_SRC).toMatch(/max-h-\[min\(85vh,680px\)\]/);
    });
});

// ─── 2. Structured slots with independent scroll ─────────────────

describe('Modal — structured header / body / footer', () => {
    it('exports Header / Body / Footer / Actions / Form / Confirm / Close', () => {
        const composite = MODAL_SRC.split(/export const Modal\s*=/)[1] ?? '';
        for (const slot of ['Header', 'Body', 'Footer', 'Actions', 'Form', 'Confirm', 'Close']) {
            expect(composite).toContain(slot);
        }
    });

    it('Header renders Dialog.Title inside the visible heading for a11y', () => {
        expect(MODAL_SRC).toMatch(/<Dialog\.Title asChild/);
    });

    it('Header is shrink-0 so it stays pinned while body scrolls', () => {
        // The drift sentinel — a future refactor must not let the header
        // flex-grow and eat the scroll region.
        const headerBlock = MODAL_SRC.split(/function Header/)[1]?.split(/function Body/)[0] ?? '';
        expect(headerBlock).toMatch(/shrink-0/);
    });

    it('Body flex-1 + overflow-y-auto so long forms scroll in-place', () => {
        const bodyBlock = MODAL_SRC.split(/function Body/)[1]?.split(/function Footer/)[0] ?? '';
        expect(bodyBlock).toMatch(/flex-1/);
        expect(bodyBlock).toMatch(/overflow-y-auto/);
    });

    it('Footer is shrink-0 so primary/secondary buttons stay visible', () => {
        const footerBlock = MODAL_SRC.split(/function Footer/)[1]?.split(/function Actions/)[0] ?? '';
        expect(footerBlock).toMatch(/shrink-0/);
    });

    it('Actions supports left / right / between alignment', () => {
        expect(MODAL_SRC).toMatch(/align\?\:\s*["']left["']\s*\|\s*["']right["']\s*\|\s*["']between["']/);
        expect(MODAL_SRC).toMatch(/justify-start/);
        expect(MODAL_SRC).toMatch(/justify-between/);
    });
});

// ─── 3. Modal.Form sugar ─────────────────────────────────────────

describe('Modal.Form — CRUD-friendly wrapper', () => {
    it('renders a <form> with a noValidate attribute (consumers handle validation)', () => {
        expect(MODAL_SRC).toMatch(/<form\b[\s\S]*?noValidate/);
    });

    it('flex-1 + overflow-hidden so the inner Body can own the scroll', () => {
        const formBlock = MODAL_SRC.split(/function Form/)[1]?.split(/\/\/ ─── Confirm/)[0] ?? '';
        expect(formBlock).toMatch(/flex-1/);
        expect(formBlock).toMatch(/flex-col/);
        expect(formBlock).toMatch(/overflow-hidden/);
    });

    it('accepts onSubmit with the right FormEventHandler type', () => {
        expect(MODAL_SRC).toMatch(/onSubmit\?\:\s*FormEventHandler<HTMLFormElement>/);
    });
});

// ─── 4. Modal.Confirm — destructive / confirm semantics ──────────

describe('Modal.Confirm — tone-driven confirmation dialog', () => {
    it('exports the ConfirmTone union', () => {
        expect(MODAL_SRC).toMatch(/export type ConfirmTone/);
        expect(MODAL_SRC).toMatch(/["']danger["']\s*\|\s*["']warning["']\s*\|\s*["']info["']/);
    });

    it('maps each tone to a dedicated icon', () => {
        expect(MODAL_SRC).toMatch(/toneIcon/);
        expect(MODAL_SRC).toMatch(/text-content-error/);
        expect(MODAL_SRC).toMatch(/text-content-warning/);
        expect(MODAL_SRC).toMatch(/text-content-info/);
    });

    it('danger tone drives a destructive Button variant (post v2-PR-1)', () => {
        // Legacy `.btn .btn-danger` CSS classes were retired in the
        // .btn → <Button> migration; v2-PR-1 then renamed the Button
        // variant `danger` → `destructive`. The modal Confirm wires
        // `variant={tonePrimaryVariant[tone]}` where tone='danger'
        // resolves to the destructive <Button> variant (which itself
        // paints bg-bg-error-emphasis).
        expect(MODAL_SRC).toMatch(/tonePrimaryVariant/);
        expect(MODAL_SRC).toMatch(/destructive.*\|.*primary/);
    });

    it('handles async onConfirm with success-to-close semantics', () => {
        // When onConfirm returns a Promise we await it and only close on
        // success — so caller can keep the modal open on error.
        expect(MODAL_SRC).toMatch(/const result = onConfirm\(\)/);
        expect(MODAL_SRC).toMatch(/result instanceof Promise/);
        expect(MODAL_SRC).toMatch(/await result/);
    });

    it('renders a dedicated cancel affordance wired to onCancel', () => {
        expect(MODAL_SRC).toMatch(/data-modal-cancel/);
        expect(MODAL_SRC).toMatch(/data-modal-confirm/);
    });

    it('uses the xs size so confirms stay tight and unmissable', () => {
        // Key consistency invariant — the ConfirmModal spawns the same
        // ModalRoot with size="xs" so all confirmation dialogs feel alike.
        expect(MODAL_SRC).toMatch(/size="xs"/);
    });
});

// ─── 5. Focus + close behaviour ──────────────────────────────────

describe('Modal — focus + dismissal', () => {
    it('preventDefault on onOpenAutoFocus so cmdk / filter popovers keep focus practice', () => {
        expect(MODAL_SRC).toMatch(/onOpenAutoFocus=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/);
    });

    it('preventDefault on onCloseAutoFocus so focus doesn\'t flash on the trigger', () => {
        expect(MODAL_SRC).toMatch(/onCloseAutoFocus=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/);
    });

    it('preventDefaultClose suppresses backdrop + Escape (unsaved-state pattern)', () => {
        expect(MODAL_SRC).toMatch(/preventDefaultClose/);
        // Close button is hidden too when preventDefaultClose is set.
        expect(MODAL_SRC).toMatch(/showCloseButton\s*&&\s*!preventDefaultClose/);
    });

    it('close button carries aria-label="Close" + focus-visible ring token', () => {
        // Close label is i18n-routed (common.close = "Close").
        expect(MODAL_SRC).toMatch(/aria-label=\{tc\(["']close["']\)\}/);
        expect(MODAL_SRC).toMatch(/focus-visible:ring-ring/);
    });

    it('drag dismissal still closes the drawer variant (mobile UX)', () => {
        // The onOpenChange handler for the drawer passes `dragged: true`
        // so preventDefaultClose-guarded modals still close when dragged.
        expect(MODAL_SRC).toMatch(/closeModal\(\s*\{\s*dragged:\s*true\s*\}\s*\)/);
    });
});

// ─── 6. Token drift sentinel ─────────────────────────────────────

describe('Modal — token drift sentinel', () => {
    it('uses semantic tokens only (no Dub-native palette)', () => {
        for (const pattern of [
            /\bbg-white\b/,
            /\btext-black\b/,
            /\bbg-neutral-\d/,
            /\btext-neutral-\d/,
            /\bborder-neutral-\d/,
        ]) {
            expect(MODAL_SRC).not.toMatch(pattern);
        }
    });

    it('reaches the shared semantic token namespace', () => {
        for (const token of ['bg-bg-default', 'bg-bg-overlay', 'border-border-subtle', 'text-content-emphasis']) {
            expect(MODAL_SRC).toContain(token);
        }
    });
});

// ─── 7. Bespoke overlay ratchet ──────────────────────────────────

describe('Bespoke modal ratchet — prevent new `fixed inset-0 bg-black/…` overlays', () => {
    // Two bespoke overlays remain in the app today (PracticesClient's
    // justification modal + a detail-page use). The Epic 54 CRUD migration
    // that follows this prompt will collapse them onto <Modal>. Until then
    // we ratchet so the count can only go down.
    const BASELINE = 2;

    it('does not grow past the baseline count', () => {
        const appDir = path.join(ROOT, 'src/app/t');
        const files: string[] = [];
        function walk(dir: string) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry.name)) files.push(full);
            }
        }
        walk(appDir);

        const re = /className="[^"]*\bfixed inset-0 bg-black\b/g;
        let total = 0;
        for (const f of files) {
            const matches = fs.readFileSync(f, 'utf-8').match(re);
            if (matches) total += matches.length;
        }
        expect(total).toBeLessThanOrEqual(BASELINE);
    });
});

/**
 * Epic 54 — canonical Sheet + Popover primitives.
 *
 * Sits alongside `responsive-modal-sheet.test.ts` (foundation) and
 * `modal-primitive.test.ts` (CRUD Modal). This suite pins the two
 * lightweight surfaces that complete the overlay trio:
 *
 *   - Sheet: size variants, responsive direction (right on desktop,
 *     bottom on mobile), a11y title fallback, structured slots incl.
 *     Sheet.Actions matching Modal.Actions parity.
 *   - Popover: Menu / Item / Separator slots for action-menu consistency,
 *     destructive + selected variants, keyboard-focusable surface, plus
 *     the existing root contract the filter stack depends on.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const SHEET_SRC = read('src/components/ui/sheet.tsx');
const POPOVER_SRC = read('src/components/ui/popover.tsx');

// ─── Sheet — size variants ───────────────────────────────────────

describe('Sheet — CVA size variants', () => {
    it('imports class-variance-authority for the width vocabulary', () => {
        expect(SHEET_SRC).toMatch(/from ["']class-variance-authority["']/);
        expect(SHEET_SRC).toMatch(/sheetWidthVariants/);
    });

    it('exposes the documented sizes (sm / md / lg / xl) with Tailwind arbitrary properties', () => {
        for (const [size, width] of [
            ['sm', '420px'],
            ['md', '540px'],
            ['lg', '720px'],
            ['xl', '960px'],
        ] as const) {
            expect(SHEET_SRC).toMatch(new RegExp(`${size}:\\s*"\\[--sheet-width:${width}\\]"`));
        }
    });

    it('default size is md', () => {
        expect(SHEET_SRC).toMatch(/defaultVariants:\s*\{\s*size:\s*["']md["']/);
    });
});

// ─── Sheet — responsive direction ────────────────────────────────

describe('Sheet — responsive direction', () => {
    it('branches direction on viewport via useMediaQuery', () => {
        expect(SHEET_SRC).toMatch(/useMediaQuery/);
        expect(SHEET_SRC).toMatch(/isMobile\s*\?\s*["']bottom["']\s*:\s*["']right["']/);
    });

    it('accepts an explicit right/bottom override', () => {
        expect(SHEET_SRC).toMatch(/direction\?\:\s*["']responsive["']\s*\|\s*["']right["']\s*\|\s*["']bottom["']/);
    });

    it('exposes the resolved direction via a data attribute for E2E / theming', () => {
        expect(SHEET_SRC).toMatch(/data-sheet-direction/);
    });

    it('bottom-drawer variant surfaces the drag handle affordance', () => {
        expect(SHEET_SRC).toMatch(/DrawerHandle/);
        expect(SHEET_SRC).toMatch(/rounded-full bg-border-emphasis/);
    });

    it('bottom direction uses inset-x positioning + max-height cap', () => {
        expect(SHEET_SRC).toMatch(/inset-x-2/);
        expect(SHEET_SRC).toMatch(/--sheet-height:85svh/);
    });

    it('right direction pins top/bottom/right with the width cap', () => {
        expect(SHEET_SRC).toMatch(/bottom-2 right-2 top-2/);
        expect(SHEET_SRC).toMatch(/--sheet-margin:8px/);
    });
});

// ─── Sheet — a11y ────────────────────────────────────────────────

describe('Sheet — accessibility', () => {
    it('always renders a Drawer.Title (visually-hidden fallback keeps SR anchored)', () => {
        expect(SHEET_SRC).toMatch(/from ["']@radix-ui\/react-visually-hidden["']/);
        expect(SHEET_SRC).toMatch(/<Drawer\.Title\b/);
        // Fallback title is i18n-routed (ui.sheet.sheetFallback = "Sheet").
        expect(SHEET_SRC).toMatch(/\?\?\s*t\(["']sheetFallback["']\)/);
    });

    it('wires the optional description through Drawer.Description', () => {
        expect(SHEET_SRC).toMatch(/<Drawer\.Description\b/);
        expect(SHEET_SRC).toMatch(/description\?\:\s*string/);
    });

    it('Header renders a dedicated close button with aria-label="Close" + focus ring', () => {
        // Close label is i18n-routed (common.close = "Close").
        expect(SHEET_SRC).toMatch(/aria-label=\{tc\(["']close["']\)\}/);
        expect(SHEET_SRC).toMatch(/focus-visible:ring-ring/);
    });

    it('Header accepts showCloseButton:false for custom header layouts', () => {
        expect(SHEET_SRC).toMatch(/showCloseButton = true/);
        expect(SHEET_SRC).toMatch(/showCloseButton \? \(/);
    });
});

// ─── Sheet — structured slots ────────────────────────────────────

describe('Sheet — structured slots', () => {
    it('exports Title / Description / Header / Body / Footer / Actions / Close', () => {
        const composite = SHEET_SRC.split(/export const Sheet\s*=/)[1] ?? '';
        for (const slot of ['Title', 'Description', 'Header', 'Body', 'Footer', 'Actions', 'Close']) {
            expect(composite).toContain(slot);
        }
    });

    it('Header + Footer are shrink-0 so body scroll owns overflow', () => {
        const headerBlock = SHEET_SRC.split(/function Header/)[1]?.split(/function Body/)[0] ?? '';
        expect(headerBlock).toMatch(/shrink-0/);
        const footerBlock = SHEET_SRC.split(/function Footer/)[1]?.split(/function Actions/)[0] ?? '';
        expect(footerBlock).toMatch(/shrink-0/);
    });

    it('Body flex-1 + overflow-y-auto so long detail content scrolls in-place', () => {
        const bodyBlock = SHEET_SRC.split(/function Body/)[1]?.split(/function Footer/)[0] ?? '';
        expect(bodyBlock).toMatch(/flex-1/);
        expect(bodyBlock).toMatch(/overflow-y-auto/);
    });

    it('Actions supports left / right / between alignment (Modal.Actions parity)', () => {
        expect(SHEET_SRC).toMatch(/align\?\:\s*["']left["']\s*\|\s*["']right["']\s*\|\s*["']between["']/);
        expect(SHEET_SRC).toMatch(/justify-start/);
        expect(SHEET_SRC).toMatch(/justify-between/);
    });
});

// ─── Sheet — token drift sentinel ────────────────────────────────

describe('Sheet — token drift sentinel', () => {
    it('uses semantic tokens only', () => {
        for (const pattern of [
            /\bbg-white\b/,
            /\btext-black\b/,
            /\bbg-neutral-\d/,
            /\btext-neutral-\d/,
            /\bborder-neutral-\d/,
            /\bbg-black\/\d/,
        ]) {
            expect(SHEET_SRC).not.toMatch(pattern);
        }
        // B3 (2026-06-07): the sheet CONTENT surface now uses the
        // token-based `.surface-popup-texture` class (brand-tinted focal
        // glow) instead of a literal `bg-bg-default` — still semantic, the
        // tokens resolve inside the class. The overlay + header/footer keep
        // their literal tokens.
        for (const token of ['surface-popup-texture', 'bg-bg-overlay', 'border-border-subtle', 'text-content-emphasis']) {
            expect(SHEET_SRC).toContain(token);
        }
    });
});

// ─── Popover — core root still works ─────────────────────────────

describe('Popover — root contract unchanged', () => {
    it('keeps the existing controlled PopoverProps surface', () => {
        for (const prop of ['openPopover', 'setOpenPopover', 'align', 'side', 'onEscapeKeyDown']) {
            expect(POPOVER_SRC).toContain(prop);
        }
    });

    it('still branches Radix Popover / Vaul Drawer via useMediaQuery', () => {
        expect(POPOVER_SRC).toMatch(/from ["']vaul["']/);
        expect(POPOVER_SRC).toMatch(/from ["']@radix-ui\/react-popover["']/);
        expect(POPOVER_SRC).toMatch(/useMediaQuery/);
    });

    it('exports Popover as the composite (root + Menu + Item + Separator)', () => {
        expect(POPOVER_SRC).toMatch(/Object\.assign\(PopoverRoot,\s*\{[\s\S]*Menu[\s\S]*Item[\s\S]*Separator/);
    });
});

// ─── Popover — Menu / Item / Separator slots ─────────────────────

describe('Popover.Menu / Popover.Item / Popover.Separator', () => {
    it('Menu applies role="menu" + data-popover-menu for automation', () => {
        expect(POPOVER_SRC).toMatch(/role="menu"/);
        expect(POPOVER_SRC).toMatch(/data-popover-menu/);
    });

    it('Item is keyboard-focusable with the shared ring token', () => {
        expect(POPOVER_SRC).toMatch(/role="menuitem"/);
        expect(POPOVER_SRC).toMatch(/focus-visible:ring-ring/);
    });

    it('Item uses forwardRef so upstream menus can manage focus', () => {
        expect(POPOVER_SRC).toMatch(/forwardRef<HTMLButtonElement/);
    });

    it('Item supports destructive styling wired to semantic error tokens', () => {
        expect(POPOVER_SRC).toMatch(/destructive\?\:\s*boolean/);
        expect(POPOVER_SRC).toMatch(/text-content-error/);
        expect(POPOVER_SRC).toMatch(/bg-bg-error/);
    });

    it('Item surfaces selected/destructive via data-* for CSS hooks + E2E', () => {
        expect(POPOVER_SRC).toMatch(/data-destructive=\{/);
        expect(POPOVER_SRC).toMatch(/data-selected=\{/);
    });

    it('Item renders icon / label / right-slot for consistent menu rows', () => {
        // Props defined on PopoverItemProps; the Item body destructures
        // them. Check the interface + the rendered markup separately so
        // both drift vectors are caught.
        expect(POPOVER_SRC).toMatch(/icon\?\:\s*ReactNode/);
        expect(POPOVER_SRC).toMatch(/right\?\:\s*ReactNode/);
        const itemBlock = POPOVER_SRC.split(/const Item = forwardRef/)[1] ?? '';
        expect(itemBlock).toMatch(/\{icon\s*\?/);
        expect(itemBlock).toMatch(/\{right\s*\?/);
    });

    it('Separator uses border-border-subtle (token-driven)', () => {
        expect(POPOVER_SRC).toMatch(/role="separator"/);
        expect(POPOVER_SRC).toMatch(/bg-border-subtle/);
    });

    it('no raw Dub palette colors anywhere in the Popover source', () => {
        for (const pattern of [
            /\bbg-white\b/,
            /\btext-black\b/,
            /\bbg-neutral-\d/,
            /\btext-neutral-\d/,
            /\bborder-neutral-\d/,
        ]) {
            expect(POPOVER_SRC).not.toMatch(pattern);
        }
    });
});

// ─── Back-compat: existing Popover consumers still work ──────────

describe('Popover — existing consumer surface intact', () => {
    it('FilterSelect still imports Popover from the shared module', () => {
        const filterSelect = read('src/components/ui/filter/filter-select.tsx');
        expect(filterSelect).toMatch(/from ["']\.\.\/popover["']/);
        expect(filterSelect).toMatch(/<Popover\b/);
    });

    it('FilterList still composes Popover', () => {
        const filterList = read('src/components/ui/filter/filter-list.tsx');
        expect(filterList).toMatch(/from ["']\.\.\/popover["']/);
    });

    it('the gear (via the shared ChecklistGearButton) still composes Popover', () => {
        // R-filter-gear (2026-06-07): ColumnsDropdown is now a thin wrapper;
        // the Popover composition moved into the shared primitive.
        const gear = read('src/components/ui/checklist-gear-button.tsx');
        expect(gear).toMatch(/from ["']\.\/popover["']/);
    });
});

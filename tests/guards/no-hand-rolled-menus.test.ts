/**
 * Guardrail — Popover is the ONLY row-action / dropdown menu primitive.
 *
 * The canonical menu surface is `<Popover>` + `<Popover.Menu>` +
 * `<Popover.Item>` from `src/components/ui/popover.tsx` (Radix on
 * desktop — portalled, so immune to DataTable overflow clipping and the
 * z-30 BottomTabBar — Vaul bottom-sheet on mobile). Hand-rolled floating
 * menus are banned OUTSIDE `src/components/ui/` because they:
 *   - clip inside `overflow-hidden` table/card containers,
 *   - sit under the mobile BottomTabBar (wrong z-index),
 *   - re-implement click-away / Escape / focus semantics inconsistently.
 *
 * Two anti-patterns are detected:
 *
 *   A) FLOATING MENU + CLICK-AWAY — an `absolute top-full …` menu div
 *      paired with a sibling `fixed inset-0` click-away overlay. This is
 *      the exact shape `<Popover>` replaces.
 *
 *   B) `openMenuId`-STYLE STATE — a `useState`-driven "which row's menu is
 *      open" id that toggles an absolutely-positioned menu div. Popover
 *      owns its own open state per-trigger; a page-level open-id is the
 *      tell of a hand-rolled menu.
 *
 * Scope: `src/app/**` + `src/components/**`, EXCLUDING
 * `src/components/ui/**` (the primitive layer, where Popover itself and
 * other legitimate absolutely-positioned surfaces live).
 *
 * Baseline: empty. Every menu in the product is a `<Popover>`. If a
 * legitimate existing site must be grandfathered, add it to
 * `BASELINE_HAND_ROLLED` with a written reason — and delete the entry in
 * the same PR that migrates it.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../src');
const SCAN_ROOTS = [path.join(SRC_ROOT, 'app'), path.join(SRC_ROOT, 'components')];
// The primitive layer is exempt — Popover itself + other legitimate
// absolutely-positioned surfaces (tooltips, comboboxes) live here.
const EXCLUDED_DIR = path.join(SRC_ROOT, 'components', 'ui') + path.sep;

// Legitimate grandfathered sites, each with a written reason. Should be
// empty — a non-empty entry is a migration TODO, not a resting state.
const BASELINE_HAND_ROLLED: Record<string, string> = {};

function walk(dir: string, out: string[]): string[] {
    if (!fs.existsSync(dir)) {
        // Deliberately a THROW, not `return out`. The early return was a
        // defensive line that made this guard unable to fail: a renamed root
        // yielded zero files, zero files yielded zero violations, and the
        // assertion passed over nothing. An empty selection is a PASS.
        throw new Error(
            `scan root does not exist: ${dir}. If a directory was renamed, update SCAN_ROOTS — ` +
                `do not let this guard scan nothing and report success.`,
        );
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/**
 * Strip line + block comments so a `// <div className="absolute top-full">`
 * doc example never counts as a real offender.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ── Detectors (pure — exported shape for the self-test) ─────────────

/** A) `absolute … top-full` menu div paired with a `fixed inset-0` click-away. */
function hasFloatingMenuWithClickAway(src: string): boolean {
    const s = stripComments(src);
    const floatingMenu =
        /className\s*=\s*[{"'`][^"'`}]*\babsolute\b[^"'`}]*\btop-full\b/.test(s) ||
        /className\s*=\s*[{"'`][^"'`}]*\btop-full\b[^"'`}]*\babsolute\b/.test(s);
    const clickAway = /className\s*=\s*[{"'`][^"'`}]*\bfixed\b[^"'`}]*\binset-0\b/.test(s);
    return floatingMenu && clickAway;
}

/** B) `openMenuId`-style open-id state driving an absolutely-positioned div. */
function hasOpenMenuIdState(src: string): boolean {
    const s = stripComments(src);
    // A "which menu is open" id: openMenuId / setOpenMenuId / openDropdownId …
    const openIdState =
        /\b(?:set)?[Oo]pen[A-Za-z]*(?:Menu|Dropdown)[A-Za-z]*Id\b/.test(s);
    const absoluteDiv = /className\s*=\s*[{"'`][^"'`}]*\babsolute\b/.test(s);
    return openIdState && absoluteDiv;
}

function isOffender(src: string): boolean {
    return hasFloatingMenuWithClickAway(src) || hasOpenMenuIdState(src);
}

const SOURCES = SCAN_ROOTS.flatMap((root) => walk(root, []))
    .filter((p) => !p.startsWith(EXCLUDED_DIR))
    .map((p) => ({ file: path.relative(SRC_ROOT, p), src: fs.readFileSync(p, 'utf-8') }));

describe('no hand-rolled menus — Popover is the only menu primitive', () => {
    it('no floating-menu / openMenuId-style dropdown outside src/components/ui', () => {
        const offenders = SOURCES.filter(
            ({ file, src }) => isOffender(src) && !(file in BASELINE_HAND_ROLLED),
        ).map(({ file }) => file);

        if (offenders.length > 0) {
            throw new Error(
                `Hand-rolled dropdown menu(s) found outside src/components/ui. Use ` +
                    `<Popover> + <Popover.Menu> + <Popover.Item> from ` +
                    `@/components/ui/popover instead (portalled on desktop, ` +
                    `bottom-sheet on mobile):\n` +
                    offenders.map((f) => `  ${f}`).join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('every BASELINE_HAND_ROLLED entry still exists and still offends (no stale entries)', () => {
        for (const rel of Object.keys(BASELINE_HAND_ROLLED)) {
            const entry = SOURCES.find((s) => s.file === rel);
            // baseline entry must still exist — remove it if the file moved
            expect(entry).toBeTruthy();
            // baseline entry must still offend — remove it once migrated
            expect(Boolean(entry && isOffender(entry.src))).toBe(true);
        }
    });
});

// ── Self-test — prove the detector actually catches an offender ─────

describe('no-hand-rolled-menus detector self-test', () => {
    const FLOATING_MENU_OFFENDER = `
        export function Row() {
            const [open, setOpen] = useState(false);
            return (
                <div className="relative">
                    <button onClick={() => setOpen(true)}>⋮</button>
                    {open && (
                        <div className="absolute right-0 top-full mt-1 rounded-lg border shadow-lg">
                            <button>Edit</button>
                        </div>
                    )}
                    {open && <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />}
                </div>
            );
        }
    `;

    const OPEN_MENU_ID_OFFENDER = `
        export function List() {
            const [openMenuId, setOpenMenuId] = useState<string | null>(null);
            return rows.map((r) => (
                <div className="relative" key={r.id}>
                    <button onClick={() => setOpenMenuId(r.id)}>⋮</button>
                    {openMenuId === r.id && (
                        <div className="absolute right-0 rounded-lg border shadow-lg">menu</div>
                    )}
                </div>
            ));
        }
    `;

    const CLEAN_POPOVER = `
        export function Row() {
            const [open, setOpen] = useState(false);
            return (
                <Popover openPopover={open} setOpenPopover={setOpen} content={<Popover.Menu><Popover.Item>Edit</Popover.Item></Popover.Menu>}>
                    <button>⋮</button>
                </Popover>
            );
        }
    `;

    // A full-screen command palette / mobile sidebar uses `fixed inset-0`
    // but is NOT a hand-rolled dropdown — the detector must not flag it.
    const CLEAN_FULLSCREEN_OVERLAY = `
        export function Palette({ open, onClose }) {
            if (!open) return null;
            return <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}><input /></div>;
        }
    `;

    it('catches the floating-menu + click-away pattern', () => {
        expect(hasFloatingMenuWithClickAway(FLOATING_MENU_OFFENDER)).toBe(true);
        expect(isOffender(FLOATING_MENU_OFFENDER)).toBe(true);
    });

    it('catches the openMenuId-style state pattern', () => {
        expect(hasOpenMenuIdState(OPEN_MENU_ID_OFFENDER)).toBe(true);
        expect(isOffender(OPEN_MENU_ID_OFFENDER)).toBe(true);
    });

    it('does NOT flag a canonical <Popover> usage', () => {
        expect(isOffender(CLEAN_POPOVER)).toBe(false);
    });

    it('does NOT flag a full-screen overlay (command palette / sidebar)', () => {
        expect(isOffender(CLEAN_FULLSCREEN_OVERLAY)).toBe(false);
    });
});

/**
 * Roadmap-5 PR-4 — shadow discipline.
 *
 * The Card primitive's docstring is explicit: "Premium products
 * (Linear, Stripe, Vercel) express depth through background-tone
 * changes on dark surfaces, not via box-shadow. Shadows on glass
 * / blurred surfaces look uncertain; tone-based elevation reads
 * as deliberate and quiet."
 *
 * The codebase agreed in spirit. In practice, 16 shadow-* uses
 * shipped across the product. Most were legitimate (floating
 * overlays + moving elements + notifications), but two static
 * page-level surfaces had absorbed shadows by accident:
 *
 *   • `<FileUpload variant="default">` carried `shadow-sm` on
 *     the dropzone card itself — depth on a static surface.
 *   • `<FileUpload>`'s sr-only file input wrapper had a
 *     `shadow-sm` it could never render (sr-only hides it).
 *
 * Both stripped in this PR.
 *
 * What this ratchet locks
 *
 *   `shadow-{sm|md|lg|xl|2xl}` and `drop-shadow-{sm|md|lg|xl|2xl}`
 *   may only appear in the documented allowlist below. Each entry
 *   has a written reason matching the surface's role:
 *
 *   This read `drop-shadow-*`, which overstates the regex: the
 *   SIZE list binds both prefixes, so an arbitrary-value
 *   `drop-shadow-[...]` is out of scope. One use exists —
 *   `icons/dub-crafted-shield.tsx`'s `drop-shadow-[0_1px_1px_#0004]`
 *   — and it is inside icon artwork rather than on a page surface,
 *   so the scope is right and the sentence was wrong. Nine
 *   `shadow-[...]` uses are likewise out of scope; they are hairline
 *   inset rings, not elevation.
 *
 *     - Floating overlay primitives (Modal, Sheet, Popover,
 *       Tooltip, Command palette, Undo toast).
 *     - Chart / graph tooltips that float above the canvas.
 *     - Hand-rolled overlay menus or toasts (admin/members
 *       overflow menu, practices/[practiceId] success toast).
 *     - Moving primitives whose depth communicates state
 *       (Switch thumb).
 *
 * Static page surfaces (cards, banners, form chrome, dropzones)
 * MUST express depth through bg-tone tokens, never `shadow-*`.
 * The Card primitive's `elevation` axis provides the canonical
 * surface-tone ladder (`flat / inset / raised / floating`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { assertAllowlistIsLive } from '../helpers/assert-allowlist-is-live';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface AllowlistEntry {
    file: string;
    reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
    {
        file: 'src/components/ui/fab.tsx',
        reason: 'mobile-forms PR-3 — the FAB is a floating action button (Material elevation); shadow-lg communicates its lift above the page + bottom-tab bar.',
    },
    {
        file: 'src/components/ui/map/MapCanvas.tsx',
        reason: 'feat/mobile-map — floating on-map practices (zoom/locate/track) + the geolocation "blue dot" marker float over arbitrary basemap imagery; shadow-md gives the lift that keeps them legible against a busy map (same floating-practice class as the FAB/popover/tooltip entries).',
    },
    {
        file: 'src/components/ui/popover.tsx',
        reason: 'Popover is a floating overlay — drop-shadow + shadow paint the lift.',
    },
    {
        file: 'src/components/ui/tooltip.tsx',
        reason: 'Tooltip is a floating overlay; shadow communicates lift.',
    },
    {
        file: 'src/components/command-palette/command-palette.tsx',
        reason: 'Command palette is a floating modal-like overlay; shadow-2xl communicates the topmost lift.',
    },
    {
        file: 'src/components/processes/CanvasCommandPalette.tsx',
        reason: 'R31 Bundle 8 — canvas-local command palette inherits the same shadow-2xl lift as the app-wide palette. Floating dialog over the canvas plane needs the same topmost emphasis.',
    },
    {
        file: 'src/components/ui/switch.tsx',
        reason: 'Switch thumb shadow communicates depth on the moving element — sliding without depth reads as flat.',
    },
    {
        file: 'src/components/ui/charts/interaction.tsx',
        reason: 'Chart tooltip floats above the chart canvas; shadow communicates lift.',
    },
    {
        file: 'src/components/ui/hooks/use-pull-to-refresh.tsx',
        reason: 'mobile-native-feel — the pull-to-refresh spinner disc floats over the page content during the drag gesture; shadow-md gives it the lift of a native refresh practice (same floating-affordance class as the FAB).',
    },
    {
        file: 'src/components/ui/scroll-to-top.tsx',
        reason: 'mobile-native-feel — floating scroll-to-top button; shadow-lg communicates lift above scrolling content (same floating-practice class as the FAB entry).',
    },
];

const ALLOWED = new Set(ALLOWLIST.map((e) => e.file));
const SHADOW_RE = /\b(?:shadow|drop-shadow)-(sm|md|lg|xl|2xl)\b/;

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Shadow discipline (Roadmap-5 PR-4)', () => {
    it('[shadow-discipline] every allowlisted file still uses a banned shadow', () => {
        // Was an EXISTENCE check only, which cannot tell an exemption that is
        // doing its job from one that excuses a file already clean (#2414).
        //
        // Five of the fifteen entries were the second kind. Each file had
        // migrated its elevation into a composed primitive exactly as this
        // ratchet wanted — `modal.tsx` and `undo-toast.tsx` now mention the
        // word only in a comment reading "the class provides bg, border, and
        // shadow" — and nobody removed the entry, so the list claimed five
        // accepted violations that no longer existed. They are deleted here;
        // this check is what stops the next five accumulating.
        const report = assertAllowlistIsLive({
            label: 'shadow-discipline ALLOWLIST',
            entries: ALLOWLIST.map((e) => e.file),
            // The SAME transform the scan below applies, line by line.
            blankOptions: {},
            violates: (code) => code.split('\n').some((line) => SHADOW_RE.test(line)),
        });
        console.log(
            `[shadow-discipline] ${report.live.length} of ${ALLOWLIST.length} allowlisted file(s) `
                + 'still use a banned shadow utility',
        );
        expect(report.live.length).toBe(ALLOWLIST.length);
    });

    it('no .tsx file under src/ uses shadow-* outside the allowlist', () => {
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                if (ALLOWED.has(rel)) continue;
                const raw = fs.readFileSync(full, 'utf-8');
                const stripped = blankNonCode(raw);
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    if (SHADOW_RE.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            snippet: line.trim().slice(0, 200),
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Shadow-* used on a static page surface. Premium products express depth through background tone, not box-shadow. Use the Card primitive's elevation axis (flat / inset / raised / floating) instead. If the surface is a legitimate floating overlay, add the file to ALLOWLIST with a written reason:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

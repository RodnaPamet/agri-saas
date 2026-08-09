/**
 * Roadmap-5 PR-3 — radius scale lockdown.
 *
 * Sixteen radius values fought inside the codebase:
 *   rounded-lg (×131), rounded-full (×90), rounded-md (×86),
 *   rounded-xl (×21), rounded-t (×16), rounded-sm (×13),
 *   rounded-2xl (×3), plus 14 rounded-l/r/b partials.
 *
 * The intent was always three:
 *   - lg   for surfaces (cards, modals, tables, popovers)
 *   - md   for practices (buttons, inputs, chips, menu items)
 *   - full for pills (status badges, avatars, ring indicators)
 *
 * Anything off-scale was drift.
 *
 * What lands
 *
 *   • 12 surface-level callsites migrated from rounded-xl /
 *     rounded-2xl → rounded-lg:
 *
 *       login icon, dashboard size-14 icon container,
 *       security/mfa QR card, SoA banner card,
 *       OnboardingWizard skeletons + framework picker buttons,
 *       toggle-group container, deprecated form chrome,
 *       empty-state icon container, card-list-card frame,
 *       table outer borders (×2), virtual-table-body (×2),
 *       ForbiddenPage error icons (×2).
 *
 *   • Modal (`sm:rounded-2xl`) and Sheet (`rounded-xl`) stay on
 *     their current radii in this PR. Roadmap-5 PR-8 collapses
 *     them to `rounded-lg` to unify the lifted-surface curvature
 *     across Modal / Sheet / Card.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may use `rounded-xl` or
 *   `rounded-2xl` outside the documented allowlist below. The
 *   small-accent class `rounded-sm` and the partial-corner
 *   classes (`rounded-t-*` / `rounded-b-*` / `rounded-l-*` /
 *   `rounded-r-*`) remain permitted — those are legitimate uses
 *   for legend swatches, focus rings, drawer top edges, and
 *   bar-chart caps.
 *
 *   Allowlist:
 *
 *     - `src/components/ui/modal.tsx` — Modal `sm:rounded-2xl`
 *       (pending PR-8 collapse to `rounded-lg`).
 *     - `src/components/ui/sheet.tsx` — Sheet `rounded-xl`
 *       (pending PR-8 collapse).
 *     - `src/components/ui/popover.tsx` — bottom drawer carries
 *       `rounded-t-[10px]` (drawer-anchor partial radius).
 *     - `src/components/command-palette/command-palette.tsx` —
 *       palette frame `rounded-xl` (floating overlay).
 *     - `src/components/ui/date-picker/date-picker.tsx` and
 *       `date-range-picker.tsx` — popover content `rounded-xl`
 *       (floating overlay; matches command-palette).
 *
 *   New off-scale uses MUST be added to the allowlist with a
 *   written reason inline.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface AllowlistEntry {
    file: string;
    reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
    {
        file: 'src/components/command-palette/command-palette.tsx',
        reason:
            'Command palette is a floating overlay; the slightly larger `rounded-xl` differentiates it from page-level surfaces.',
    },
    {
        file: 'src/components/processes/CanvasCommandPalette.tsx',
        reason:
            'R31 Bundle 8 — canvas-local command palette mirrors the app palette\'s `rounded-xl` for the same reason: a floating dialog needs a slightly larger radius than page surfaces. Same primitive shape, different command set.',
    },
    {
        file: 'src/components/ui/date-picker/date-picker.tsx',
        reason:
            'Date picker popover content uses `rounded-xl` to match other floating overlays.',
    },
    {
        file: 'src/components/ui/date-picker/date-range-picker.tsx',
        reason:
            'Date range picker popover content uses `rounded-xl` to match other floating overlays.',
    },
];

const ALLOWED = new Set(ALLOWLIST.map((e) => e.file));
const OFF_SCALE_RE = /\brounded-(xl|2xl|3xl)\b/;

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Radius scale discipline (Roadmap-5 PR-3)', () => {
    it('every allowlisted file still exists (stale-entry check)', () => {
        const stale: string[] = [];
        for (const e of ALLOWLIST) {
            if (!fs.existsSync(path.join(ROOT, e.file))) {
                stale.push(e.file);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `Allowlist entries no longer reference real files — drop them:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });

    it('no .tsx file under src/ uses rounded-xl / rounded-2xl outside the allowlist', () => {
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
                const stripped = raw
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    if (OFF_SCALE_RE.test(line)) {
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
                `Off-scale radius use detected. The product converges on rounded-lg (surfaces) / rounded-md (practices) / rounded-full (pills). Add the file to ALLOWLIST in this ratchet with a written reason if a special case is genuinely needed:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

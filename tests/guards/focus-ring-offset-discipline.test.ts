/**
 * Roadmap-6 PR-3 — focus-ring offset discipline.
 *
 * Tab through the product. Watch the focus ring change shape:
 * `ring-offset-1` here, `ring-offset-2` there. The keyboard user
 * registers the difference between 1px and 2px offset; for a
 * great product, that difference must be intentional.
 *
 * The audit found 6 `ring-offset-1` sites. Three were drift
 * (TreeViewItem rows, selection-toolbar buttons, table click
 * targets — all "normal-sized" elements where the canonical 2px
 * offset reads cleaner). Three were deliberately small-element
 * focus rings (TextLink within a text run, RiskMatrix cell focus
 * + selected state — the cell is tiny, 1px offset prevents the
 * ring from engulfing the cell).
 *
 * What lands
 *
 *   • TreeViewItem, selection-toolbar, table → migrate to
 *     `ring-offset-2`. Three drift sites resolved.
 *   • TextLink (typography), RiskMatrixCell focus, RiskMatrixCell
 *     selected → ALLOWLISTED with written reason.
 *   • The two ring-offset COLOR tokens (`ring-offset-background`
 *     for page-level, `ring-offset-bg-default` for card-internal)
 *     are NOT interchangeable and remain distinct. Both encode
 *     legitimate offset surfaces.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may use `ring-offset-1` (or
 *   smaller / non-canonical sizes) outside the documented small-
 *   element allowlist. The canonical offset is `ring-offset-2`.
 *
 * What this ratchet does NOT police
 *
 *   - The choice between `ring-offset-background` (page-level)
 *     and `ring-offset-bg-default` (card-internal). Both are
 *     correct in their contexts.
 *   - `focus-visible:ring-2` width (the ring itself, not its
 *     offset) — that's part of a separate state-language
 *     discipline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface AllowlistEntry {
    file: string;
    reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
    {
        file: 'src/components/ui/typography.tsx',
        reason:
            'TextLink uses `ring-offset-1` because the link is inline within a text run; a 2px offset would visually break the line height.',
    },
];

const ALLOWED = new Set(ALLOWLIST.map((e) => e.file));
const VIOLATION_RE = /\bring-offset-(?:0|1)\b/;

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Focus-ring offset discipline (Roadmap-6 PR-3)', () => {
    it('every allowlisted file still exists', () => {
        const stale: string[] = [];
        for (const e of ALLOWLIST) {
            if (!fs.existsSync(path.join(ROOT, e.file))) stale.push(e.file);
        }
        expect(stale).toEqual([]);
    });

    it('no .tsx file uses ring-offset-{0,1} outside the allowlist', () => {
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
                    if (VIOLATION_RE.test(line)) {
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
                `Tight focus-ring offset detected. The canonical offset is \`ring-offset-2\` for normal-sized interactive elements. Add the file to ALLOWLIST with a written reason if the element is small enough that 1px offset is intentional:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

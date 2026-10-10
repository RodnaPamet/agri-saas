/**
 * Roadmap-6 PR-8 — Cancel button variant discipline.
 *
 * The "Cancel" button is the user's escape hatch from a modal,
 * inline form, or inline-edit row. It carries the same visual
 * weight as the primary action — but in the "retreat" direction.
 *
 * The canonical variant for Cancel is `secondary`:
 *   • Visible as a real button (not ghost-vague).
 *   • Quieter than primary (no fill).
 *   • Same height + size + corner radius as the primary it sits
 *     beside.
 *
 * The audit found 11 "Cancel" buttons. 10 used `secondary`. One
 * (`policies/[policyId]/page.tsx:557` — inline review-edit
 * cluster) used `ghost`. A ghost Cancel reads as "this isn't a
 * real action" — the user's escape hatch should never feel
 * tentative.
 *
 * What lands
 *
 *   The one `ghost` Cancel migrated to `secondary`. While
 *   touching the cluster, also flipped the order so Cancel
 *   appears LEFT of Save (the canonical Cancel-then-primary
 *   reading direction). And the ellipsis on Save's loading
 *   state changed from `...` (three-dot) to `…` (unicode
 *   ellipsis), aligning with PR-6's typographic discipline.
 *
 * What this ratchet locks
 *
 *   No `<Button variant="..." ...>Cancel</Button>` may use a
 *   variant other than `secondary` (or a destructive variant,
 *   which is its own semantic). The Cancel button is always a
 *   real button, never ghost-vague.
 *
 * What this ratchet does NOT police
 *
 *   - `aria-label="Cancel"` on icon-only `×` buttons. Those use
 *     `secondary` icons but the button text is "×" not "Cancel".
 *   - Cancel buttons inside Modal.Footer that don't carry an
 *     explicit `variant` prop (the primitive's default is
 *     secondary).
 */
import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

// Match `<Button ... variant="VARIANT" ... >Cancel</Button>` where
// VARIANT is captured. The match also accepts variant before or
// after other props.
const CANCEL_BUTTON_RE =
    /<Button\b[^>]*variant=["']([a-z-]+)["'][^>]*>Cancel<\/Button>/;

const ALLOWED_VARIANTS = new Set([
    'secondary',
    // Destructive variants carry semantic context — they're rare on
    // Cancel buttons but legitimate (e.g. "Cancel and discard
    // changes" with a danger-tone hint). Not policed here.
    'destructive',
    'destructive-outline',
]);

describe('Cancel button variant discipline (Roadmap-6 PR-8)', () => {
    it('every "Cancel" button uses variant="secondary" (or destructive)', () => {
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
                const raw = fs.readFileSync(full, 'utf-8');
                const stripped = blankNonCode(raw);
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    const m = line.match(CANCEL_BUTTON_RE);
                    if (!m) return;
                    if (ALLOWED_VARIANTS.has(m[1])) return;
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        snippet: line.trim().slice(0, 200),
                    });
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Cancel button uses a non-canonical variant. The user's escape hatch should never feel tentative — use \`variant="secondary"\`:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

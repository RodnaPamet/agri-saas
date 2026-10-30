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
import { collectSourceFiles } from '../helpers/collect-files';
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

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * Was an inline recursive `walk` inside the `it()` below, so `selector-teeth`
 * found nothing at module scope to mutate. The assertion is
 * `expect(offenders).toEqual([])`, which an emptied walk satisfies for free.
 * `collectSourceFiles` REFUSES an empty result, so the population cannot be
 * empty rather than being emptied and caught (#865).
 *
 * Parity measured BEFORE the change: 872 files both ways, zero difference.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    floor: 600,
});

describe('Cancel button variant discipline (Roadmap-6 PR-8)', () => {
    it('every "Cancel" button uses variant="secondary" (or destructive)', () => {
        const offenders: Offence[] = [];
        for (const full of SCANNED) {
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

/**
 * Roadmap-6 PR-2 — disabled-state language unification.
 *
 * Disabled is the most subliminal state in a UI. The user
 * perceives "I can't click that" without consciously looking. The
 * product told them this in four greys:
 *
 *   disabled:opacity-50 × 7  (canonical — the dominant tone)
 *   disabled:opacity-40 × 4  (TreeExpandCollapseToggle ×2,
 *                             selection-toolbar, RichTextEditor)
 *   disabled:opacity-60 × 2  (copy-text, date-picker calendar)
 *   peer-disabled:opacity-70 × 1 (label — Radix integration)
 *
 * Plus inconsistent pairing of `disabled:cursor-not-allowed`
 * (sometimes present, sometimes not).
 *
 * What lands
 *
 *   All 7 off-canonical sites migrated to `opacity-50`. The
 *   product now expresses "disabled" in exactly one grey.
 *
 *   Surviving canonical recipe:
 *     disabled:opacity-50
 *     disabled:cursor-not-allowed   (when applicable)
 *     disabled:pointer-events-none  (when applicable)
 *
 *   Tone shifts (`disabled:bg-bg-muted`, `disabled:text-content-
 *   subtle`) live ONLY in primitives that have a documented
 *   disabled-state design (Button, Input, Switch). Those are
 *   variant-internal and not subject to this ratchet.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may use `disabled:opacity-{30,
 *   40,60,70,80,90}` or `peer-disabled:opacity-{30,40,60,70,80,
 *   90}`. The canonical tone is `opacity-50`.
 *
 * What this ratchet does NOT police
 *
 *   - `disabled:opacity-50` itself (canonical).
 *   - Tone shifts that live as primitives' own variant outputs
 *     (those are documented-design choices, not drift).
 *   - Plain `opacity-N` on non-disabled context (those are
 *     governed by other ratchets — see e.g. tab-count
 *     discipline using opacity-60).
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

const VIOLATION_RE =
    /\b(?:peer-)?disabled:opacity-(?:30|40|60|70|80|90)\b/;

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

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

describe('Disabled-state discipline (Roadmap-6 PR-2)', () => {
    it('only opacity-50 is used for disabled state across src/', () => {
        const offenders: Offence[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
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
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Disabled-state opacity drift detected. The product expresses "disabled" in EXACTLY one grey: \`opacity-50\`. Migrate the off-canonical opacities:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

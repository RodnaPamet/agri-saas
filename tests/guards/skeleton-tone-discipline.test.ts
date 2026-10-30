/**
 * Roadmap-5 PR-6 — skeleton tone unification.
 *
 * Loading skeletons drifted across five tones:
 *   bg-bg-elevated/50 × 17 (admin/sso, admin/roles, admin/api-keys)
 *   bg-bg-elevated/60 × 7  (EntityDetailLayout — canonical)
 *   plus one-off /80, /20, /95.
 *
 * The first 200ms a user spends with a page is the loading
 * state. Five different tones is five different products.
 *
 * What lands
 *
 *   • All skeleton-context `bg-bg-elevated/N` migrated to `/60`
 *     (the canonical tone in EntityDetailLayout's
 *     DetailLoadingSkeleton).
 *   • 8 lines moved across admin/sso, admin/roles,
 *     admin/api-keys.
 *
 * What this ratchet locks
 *
 *   When `animate-pulse` and `bg-bg-elevated/N` co-occur on the
 *   same JSX element (the canonical skeleton shape), N must
 *   equal 60. Other opacities of `bg-bg-elevated` are fine
 *   outside the skeleton context (chip backgrounds, floating
 *   overlay banners, etc.).
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

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * This was an inline recursive `walk` inside the `it()` below, so
 * `selector-teeth` reported the file as having no module-level selector: there
 * was nothing at module scope to mutate. The assertion is
 * `expect(offenders).toEqual([])`, which an emptied walk satisfies for free.
 *
 * Migrated rather than hoisted. #2483's remedy is extraction so the auditor can
 * gut the walk; `collectSourceFiles` is stronger because it REFUSES an empty
 * result — the population cannot be empty rather than being emptied and caught.
 * #865: "the guarantee moves from 'we mutated its collector and it noticed' to
 * 'its collector cannot return empty'", and it expects the harness to then
 * report the file NOT AUDITED, which is correct here.
 *
 * Population parity measured BEFORE the change: 872 files by the
 * hand-rolled walk and by this call, zero difference either way.
 * `DEFAULT_SKIP_DIRS` already covers the `node_modules` / `.next` skips.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    floor: 600,
});

describe('Skeleton tone discipline (Roadmap-5 PR-6)', () => {
    it('every animate-pulse + bg-bg-elevated/N pair uses /60', () => {
        const offenders: Offence[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
            const raw = fs.readFileSync(full, 'utf-8');
            const stripped = blankNonCode(raw);
            const lines = stripped.split('\n');
            lines.forEach((line, i) => {
                if (
                    /\banimate-pulse\b/.test(line) &&
                    /\bbg-bg-elevated\/(\d+)\b/.test(line)
                ) {
                    const m = /\bbg-bg-elevated\/(\d+)\b/.exec(line);
                    const opacity = m ? parseInt(m[1], 10) : 0;
                    if (opacity !== 60) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            snippet: line.trim().slice(0, 200),
                        });
                    }
                }
            });
        }
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Off-tone skeleton (animate-pulse + bg-bg-elevated/N where N != 60). The product loads at one tone:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

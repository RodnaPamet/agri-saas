/**
 * Roadmap-6 PR-5 — empty-state copy uniformity.
 *
 * Empty-state titles drifted across four phrasings:
 *   "No X yet"           — canonical no-records (entity absent)
 *   "No X match …"       — canonical no-results (filtered)
 *   "No X available yet" — drift (verbose, redundant with "yet")
 *   "No X found"         — drift (passive voice)
 *
 * Plus a small set of LEGITIMATE state-specific titles that
 * shouldn't fit the binary template:
 *   "No critical risks"     — state-specific (everything's fine)
 *   "No overdue evidence"   — state-specific
 *   "No active sessions"    — state-specific
 *   "No tenants linked"     — relationship-specific
 *
 * What lands
 *
 *   • Two drift sites migrated:
 *       policies/templates "No templates available yet" →
 *           "No templates yet"
 *       admin/members "No members found" → "No members yet"
 *
 *   • Documented copy rules in CLAUDE.md (separate PR or a
 *     README in the EmptyState primitive).
 *
 * What this ratchet locks
 *
 *   No `<EmptyState title="No X found">` (passive-voice drift).
 *   No `<EmptyState title="No X available yet">` (verbose
 *   redundant-with-"yet" drift).
 *
 * Both phrasings explicitly fail. Future contributors must
 * reach for "No X yet" (no-records) or "No X match" (no-results)
 * or use a state-specific phrasing the ratchet doesn't recognise
 * (those pass through).
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface Offence {
    file: string;
    line: number;
    title: string;
}

const FORBIDDEN_RE_LIST = [
    {
        re: /title=["']No\s+\w+\s+found["']/,
        rationale: 'Use "No X yet" (no-records) or "No X match …" (no-results) instead of passive-voice "found".',
    },
    {
        re: /title=["']No\s+\w+\s+available\s+yet["']/,
        rationale: '"available yet" is redundant — drop "available" and keep "No X yet".',
    },
];

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * Was an inline recursive `walk` inside the `it()` below, so `selector-teeth`
 * found nothing at module scope to mutate, while the assertion
 * `expect(offenders).toEqual([])` is satisfied for free by an emptied walk.
 * `collectSourceFiles` REFUSES an empty result, so the population cannot be
 * empty rather than being emptied and caught (#865).
 *
 * Parity measured BEFORE the change: 872 files both ways, zero difference,
 * with no exclusions applied identically.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    floor: 600,
});

describe('Empty-state copy vocabulary (Roadmap-6 PR-5)', () => {
    it('no EmptyState title uses "No X found" or "No X available yet"', () => {
        const offenders: Offence[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
            const raw = fs.readFileSync(full, 'utf-8');
            const stripped = blankNonCode(raw);
            const lines = stripped.split('\n');
            lines.forEach((line, i) => {
                for (const { re } of FORBIDDEN_RE_LIST) {
                    if (re.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            title: line.trim().slice(0, 200),
                        });
                        break;
                    }
                }
            });
        }
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.title}`)
                .join('\n');
            const reasons = FORBIDDEN_RE_LIST
                .map((r) => `  • ${r.rationale}`)
                .join('\n');
            throw new Error(
                `Empty-state title drift detected. Use "No X yet" (no-records) or "No X match …" (no-results), or a state-specific phrase like "No critical risks":\n${reasons}\n\nOffenders:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

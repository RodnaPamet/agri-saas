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

describe('Empty-state copy vocabulary (Roadmap-6 PR-5)', () => {
    it('no EmptyState title uses "No X found" or "No X available yet"', () => {
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
        };
        walk(path.join(ROOT, 'src'));
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

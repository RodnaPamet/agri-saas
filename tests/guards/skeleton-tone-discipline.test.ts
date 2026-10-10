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
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Skeleton tone discipline (Roadmap-5 PR-6)', () => {
    it('every animate-pulse + bg-bg-elevated/N pair uses /60', () => {
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
        };
        walk(path.join(ROOT, 'src'));
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

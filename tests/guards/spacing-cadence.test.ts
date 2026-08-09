/**
 * Roadmap-3 PR-9 — spacing-cadence discipline.
 *
 * The product's semantic spacing tokens were established by v2-PR-2:
 *
 *   tight     8 px — in-row icon+text, small button gaps
 *   compact  12 px — dense form rows, list items
 *   default  16 px — default block separation, card padding
 *   section  24 px — between sections of a page
 *   page     40 px — between major page regions
 *
 * Pages SHOULD reach for these tokens. Until this PR a handful of
 * pages still used Tailwind's raw numeric `space-y-5` / `gap-5`
 * (20 px — between default and section, off-token) and similar.
 * Those drifted the rhythm by 4 px in arbitrary directions; the
 * eye reads the cadence as "almost right, but moving". This PR
 * locks the discipline.
 *
 * What this ratchet bans
 *   In `src/app/**` (the pages — primitives are exempt because
 *   they sometimes need precise raw values inside their CSS):
 *
 *     • `space-y-5`, `space-y-7`, `space-y-8`, `space-y-9`
 *     • `gap-5`, `gap-7`, `gap-8`, `gap-9`
 *     • `space-x-5`, `space-x-7`, `space-x-8`, `space-x-9`
 *     • `gap-x-5`, `gap-x-7`, `gap-x-8`, `gap-x-9`
 *     • `gap-y-5`, `gap-y-7`, `gap-y-8`, `gap-y-9`
 *
 * What this ratchet does NOT ban
 *   • `space-y-1`, `space-y-2`, `space-y-3`, `space-y-4`,
 *     `space-y-6` and the `gap-` equivalents — Tailwind's micro
 *     scale is sanctioned for primitive-level fine spacing per
 *     `tailwind.config.js`. The semantic tokens are
 *     `tight | compact | default | section | page` and they
 *     replace the MID-scale (5/7/8/9), not the micro (1/2/3/4)
 *     or the section-equivalent (6).
 *   • Spacing inside `src/components/` — primitives sometimes
 *     need precise practice for visual fidelity.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');

const BANNED_RE =
    /\b(?:space-[xy]|gap(?:-[xy])?)-(?:5|7|8|9)\b/;

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('Spacing cadence discipline (Roadmap-3 PR-9)', () => {
    it('app pages do not use mid-scale raw spacing (space-y-5/7/8/9, gap-5/7/8/9)', () => {
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                const trimmed = line.trim();
                if (
                    trimmed.startsWith('//') ||
                    trimmed.startsWith('*') ||
                    trimmed.startsWith('/*')
                )
                    return;
                if (BANNED_RE.test(line)) {
                    offenders.push({
                        file: path.relative(ROOT, file),
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} mid-scale raw-numeric spacing in app pages.\n\nUse the semantic tokens instead:\n  space-y-5 / gap-5  → space-y-default / gap-default (16 px)\n  space-y-7 / gap-7  → space-y-section / gap-section (24 px)\n  space-y-8 / gap-8  → space-y-section / gap-section (24 px)\n  space-y-9 / gap-9  → space-y-page / gap-page (40 px)\n\nMicro-scale (1/2/3/4/6) is sanctioned for fine spacing — that's not policed.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

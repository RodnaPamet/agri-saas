/**
 * Roadmap-3 PR-2 — icon-size discipline.
 *
 * Repo audit found five competing "small icon" sizes in the
 * codebase:
 *
 *   w-3 h-3     (29 sites — 12 px — OFF TOKEN)
 *   w-3.5 h-3.5 (59 sites — 14 px — canonical "sm")
 *   w-4 h-4     (48 sites — 16 px — canonical "md")
 *   w-5 h-5     (21 sites — 20 px — canonical "lg")
 *   w-6 h-6     (17 sites — 24 px — page-title hero icons)
 *
 * Three competing scales (12 / 14 / 16 px) doing the "small inline
 * icon" job. The user reads inconsistency without knowing why.
 *
 * Canonical icon-size vocabulary (locked by this PR)
 *
 *   • sm   → w-3.5 h-3.5 (14 px) — inline-with-text contexts
 *            (tags, status badges, button glyph prefixes,
 *            table-row affordances).
 *   • md   → w-4 h-4 (16 px) — buttons, list-row affordances,
 *            card-header titles.
 *   • lg   → w-5 h-5 (20 px) — empty-state hero icons,
 *            top-of-section indicators.
 *   • title→ w-6 h-6 (24 px) — page-title icons (next to
 *            <Heading level={1}>). Sanctioned, scoped to that
 *            single context, not policed by this ratchet.
 *
 * What this ratchet bans in app pages
 *   • `w-3 h-3` — 12 px is below sm; round up to 14 (sm).
 *
 * What this ratchet does NOT police
 *   • `w-6 h-6` — page-title hero icons; sanctioned, scoped.
 *   • `src/components/` primitives — primitives sometimes need
 *     pixel-precise practice (e.g. shimmer dots, decorative
 *     accents).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');

// Roadmap-7 PR-10 (subtraction sweep) — extend to also catch the
// modern Tailwind `size-N` shorthand. Zero offenders today;
// forward enforcement guarantees the shorthand never drifts to
// the off-token 12px rung. Lookahead `(?!\.)` excludes
// `size-3.5` which IS the canonical sm rung.
const OFF_TOKEN_RE = /\bw-3\s+h-3\b|\bsize-3(?!\.)\b/;

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

describe('Icon-size discipline (Roadmap-3 PR-2)', () => {
    it('app pages do not use w-3 h-3 (12 px — below sm token)', () => {
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
                if (OFF_TOKEN_RE.test(line)) {
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
                `Found ${offenders.length} off-token icon size in app pages.\n\nThe canonical icon scale is sm=14 (w-3.5 h-3.5) / md=16 (w-4 h-4) / lg=20 (w-5 h-5). 12 px (w-3 h-3) is below sm and reads as a different scale; round up to w-3.5 h-3.5 (sm).\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

/**
 * Polish PR-9 — Motion language ratchet.
 *
 * The product's motion language is documented as "one transition,
 * 150ms ease-out, colour-only on hover". Until this PR the rule
 * lived only in design-system.md. The ratchet locks it in:
 *
 * What this ratchet bans
 *
 *   1. `animate-bounce` and `animate-ping` anywhere outside
 *      explicitly-allowlisted decorative primitives. These two
 *      animations are showy; the product's tempo is quiet, so
 *      decorative bouncing/pinging is a smell.
 *
 *   2. `transition-all` on the same line as a `hover:` state.
 *      Hover state changes must enumerate exactly which property
 *      transitions (typically `transition-colors`). Hover +
 *      transition-all = unbounded property transitions, which
 *      includes layout / size / shadow churn.
 *
 *      Non-hover `transition-all` is allowed (progress bars and
 *      donut charts genuinely transition multiple properties on
 *      data changes).
 *
 * What this ratchet does NOT ban
 *   - `animate-spin` (canonical Loader2 spinner — too widely used
 *     and too clearly correct).
 *   - `animate-pulse` (canonical loading skeleton — same).
 *   - Standalone `transition-all` (used legitimately in progress /
 *     dropzone / chart primitives).
 *
 * Allowlist
 *   Specific files where the banned `hover: + transition-all`
 *   shape is intentional decorative motion. Each entry needs a
 *   written reason. Cap at 4.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

const EXEMPT_DIR_NAMES = new Set<string>([
    'node_modules',
    '__tests__',
    '__mocks__',
]);

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

const ALLOWLIST: Array<{ file: string; reason: string }> = [
    {
        file: 'src/components/ui/icons/expanding-arrow.tsx',
        reason:
            'Decorative chevron primitive composes group-hover translate + opacity into one transition-all; the motion is intentional.',
    },
];

const SHOWY_ANIMATION_RE = /\banimate-(bounce|ping)\b/;
// The second alternation's `(?:^|\s)` previously contained an
// unmatchable `^` — `\btransition-all\b.*` always consumes input,
// so by the time the matcher reaches the alternation the cursor
// is past position 0. Require explicit whitespace before `hover:`
// in the second branch; the first branch keeps `(?:^|\s)` because
// the cursor is genuinely at start-of-string there.
const HOVER_TRANSITION_ALL_RE =
    /(?:^|\s)(group-)?hover:[^\s]+.*\btransition-all\b|\btransition-all\b.*\s(group-)?hover:/;

interface Hit {
    file: string;
    line: number;
    text: string;
    kind: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        const segments = rel.split(path.sep);
        if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Motion language ratchet (Polish PR-9)', () => {
    it('zero animate-bounce / animate-ping in app/components', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*') ||
                        trimmed.startsWith('/*')
                    )
                        return;
                    if (SHOWY_ANIMATION_RE.test(line)) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            line: i + 1,
                            text: trimmed.slice(0, 200),
                            kind: 'showy',
                        });
                    }
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} animate-bounce / animate-ping site(s).\n\nThe product's motion is quiet — decorative bouncing or pinging breaks the tempo. Replace with a static affordance or a status colour.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('zero hover-state lines with transition-all (outside allowlist)', () => {
        const offenders: Hit[] = [];
        const allowedFiles = new Set(ALLOWLIST.map((a) => a.file));
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const rel = path.relative(ROOT, file);
                if (allowedFiles.has(rel)) continue;
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*') ||
                        trimmed.startsWith('/*')
                    )
                        return;
                    if (HOVER_TRANSITION_ALL_RE.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            text: trimmed.slice(0, 200),
                            kind: 'hover-transition-all',
                        });
                    }
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} hover-state line(s) with transition-all.\n\nHover transitions must enumerate the transitioned property (typically transition-colors duration-150 ease-out). transition-all on a hover surface causes layout / size / shadow churn.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('allowlist is bounded and every entry exists', () => {
        for (const a of ALLOWLIST) {
            const abs = path.resolve(ROOT, a.file);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(ALLOWLIST.length).toBeLessThanOrEqual(4);
    });
});

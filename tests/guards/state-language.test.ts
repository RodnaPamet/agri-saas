/**
 * Polish PR-8 — state-language ratchet (hover/focus/selected
 * unification).
 *
 * Premium products move with one tempo. The compounding effect of
 * every interactive surface responding the same way is enormous and
 * almost impossible to articulate when you experience it — but
 * instantly noticeable when it's missing.
 *
 * The rule
 *   Hover transitions are COLOUR-ONLY. Background tone shifts on
 *   hover; cursor changes; focus-visible adds a ring; selected
 *   states use a persistent accent. Translate / scale / elevation
 *   shadow on hover create five different tempos and break the
 *   "considered" feel.
 *
 * What this ratchet bans
 *   - `hover:scale-…`        (elements changing size on hover)
 *   - `hover:translate-…`    (elements shifting on hover)
 *   - `group-hover:scale-…`
 *   - `group-hover:translate-…`
 *   - `hover:shadow-(sm|md|lg|xl|2xl|inner)` (named-token elevation
 *     shadow on hover — uses the elevation system instead of the
 *     state language)
 *
 * What this ratchet does NOT ban
 *   - `hover:shadow-[inset_…]` — arbitrary-value shadow used as a
 *     structural indicator (e.g. table.tsx renders a brand-coloured
 *     left border on hover via inset shadow so content doesn't
 *     shift sideways). Functionally a border, not an elevation cue.
 *   - `hover:bg-…` / `hover:text-…` / `hover:border-…` — these are
 *     the colour-only treatments the state language is built on.
 *
 * Allowlist
 *   Specific files where the banned patterns are intentional
 *   decorative motion (drag-affordance icon, expanding-arrow chevron
 *   primitive). Each entry needs a written reason and the cap
 *   (≤ 4) is deliberate so the list doesn't quietly grow.
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
            'Decorative arrow primitive with a hover-translate animation; deliberate motion contained in a single component used as a CTA-arrow accent.',
    },
];

const HOVER_BAN_RE =
    /(?:^|\s)(group-)?hover:(scale-[a-z0-9_/.\-]+|translate-[a-z0-9_/.\-]+|-translate-[a-z0-9_/.\-]+|shadow-(sm|md|lg|xl|2xl|inner)\b)/;

interface Hit {
    file: string;
    line: number;
    text: string;
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

describe('State language (Polish PR-8)', () => {
    /**
     * The walked population, hoisted so the denominator can be asserted.
     *
     * `selector-teeth` reported `walk()` DEAD: `offenders` derives from it and
     * the assertion is `expect(offenders).toHaveLength(0)`, which an EMPTY walk
     * satisfies for free. Gutting the collector to `return []` left the guard
     * green over zero files (#2414, #2377).
     *
     * The `existsSync` throw at the top of `walk` covers a renamed ROOT (#875);
     * it says nothing about whether the walk FOUND anything, which is the other
     * vacuity path through the same function.
     */
    const WALKED = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
    const WALK_FLOOR = 900;

    it('[state-language] ranges over a real population — the denominator', () => {
        console.log(`[state-language] ${WALKED.length} file(s) walked across ${SCAN_DIRS.join(' + ')}`);
        expect(WALKED.length).toBeGreaterThanOrEqual(WALK_FLOOR);
        // ...and every scan root contributes, so a collapse to one directory
        // cannot clear the floor on the strength of the other.
        for (const dir of SCAN_DIRS) {
            expect({ dir, found: walk(path.join(ROOT, dir)).length > 0 })
                .toEqual({ dir, found: true });
        }
    });

    it('zero hover/group-hover scale/translate/elevation-shadow outside the allowlist', () => {
        const offenders: Hit[] = [];
        const allowedFiles = new Set(ALLOWLIST.map((a) => a.file));
        {
            for (const file of WALKED) {
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
                    if (HOVER_BAN_RE.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            text: trimmed.slice(0, 200),
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
                `Found ${offenders.length} hover-state language violation(s).\n\nHover transitions are COLOUR-ONLY across the product. Replace translate/scale/elevation-shadow with bg-/text-/border- treatments. If the motion is genuinely a decorative single-component primitive (chevron, drag icon), add to ALLOWLIST with a written reason.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('allowlist is bounded and every entry exists', () => {
        for (const a of ALLOWLIST) {
            const abs = path.resolve(ROOT, a.file);
            expect(fs.existsSync(abs)).toBe(true);
        }
        // 2 today, cap 4. `file-upload.tsx` was removed 2026-10-30: its reason
        // said "drag-affordance icon scales on hover/active", and the file no
        // longer contains a single `hover:scale-*` / `hover:translate-*` /
        // `hover:shadow-*` — 0 matching lines against HOVER_BAN_RE, versus 2 in
        // `expanding-arrow.tsx`. The exemption excused nothing (#2414).
        expect(ALLOWLIST.length).toBeLessThanOrEqual(4);
    });
});

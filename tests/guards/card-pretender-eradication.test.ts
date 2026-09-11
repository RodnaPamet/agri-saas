/**
 * Polish PR-3 — Card-pretender eradication ratchet.
 *
 * The Card primitive at `src/components/ui/card.tsx` defines a real
 * elevation model (flat / inset / raised / floating) and density
 * (comfortable / compact / none). Until this PR five components
 * hand-rolled `<div className="rounded-lg border border-border-
 * default bg-bg-subtle p-4">` — they're cards in everything but
 * type. Every drift is a small lie about design-system
 * completeness.
 *
 * What this ratchet detects
 *   The literal substring
 *     `rounded-lg border border-border-default bg-bg-subtle`
 *   anywhere in the codebase OUTSIDE `src/components/ui/card.tsx`
 *   (the primitive that owns this recipe) and the design-system
 *   docs file.
 *
 * Why this exact substring
 *   That's the recipe the primitive uses for `elevation="inset"`.
 *   Hand-rolling the same className proves a consumer should be
 *   reaching for `<Card elevation="inset">` instead.
 *
 * What this ratchet does NOT police
 *   - `rounded-md` / `rounded` (different radius — chips, banners).
 *   - `bg-bg-default` / `bg-bg-error/10` / `bg-bg-muted/20`
 *     (different surfaces — alerts, banners, filter chips).
 *   - Any combination missing the full `rounded-lg + border-default
 *     + bg-bg-subtle` triple. Surface treatments outside the inset
 *     plane are intentionally not card-pretenders.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];

const EXEMPT_FILES = new Set<string>([
    // The primitive owns this recipe.
    'src/components/ui/card.tsx',
    // Roadmap-5 hotfix — the cva definition lives in a server-safe
    // sibling so non-`"use client"` callers (server components) can
    // import + call it. The recipe text moved from card.tsx to here.
    'src/components/ui/card-variants.ts',
]);

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

const PATTERN_RE =
    /rounded-lg\s+border\s+border-border-default\s+bg-bg-subtle/;

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
        if (EXEMPT_FILES.has(rel)) continue;
        if (entry.name === 'node_modules') continue;
        if (entry.name.startsWith('__')) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Card-pretender eradication (Polish PR-3)', () => {
    it('zero hand-rolled `rounded-lg border border-border-default bg-bg-subtle` outside the Card primitive', () => {
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*')
                    )
                        return;
                    if (PATTERN_RE.test(line)) {
                        offenders.push({
                            file: path.relative(ROOT, file),
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
                `Found ${offenders.length} card-pretender(s).\n\nThe pattern \`rounded-lg border border-border-default bg-bg-subtle\` is owned by \`<Card elevation="inset">\`. Replace the hand-rolled <div> with the primitive.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('exempt list is bounded and every entry exists', () => {
        for (const rel of EXEMPT_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
        expect(EXEMPT_FILES.size).toBeLessThanOrEqual(2);
    });
});

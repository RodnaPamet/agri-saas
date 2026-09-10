/**
 * Roadmap-11 PR-5 — Animation language lock.
 *
 * After R3–R10's discipline phase the chrome is consistent but the
 * animation values are at risk: any contributor can drop a
 * `duration-[420ms]` or `ease-[cubic-bezier(...)]` into a className
 * and quietly break the single-language goal.
 *
 * R11-PR5 locks two invariants:
 *
 *   1. **Duration set.** Every `duration-X` class in src/ must use
 *      one of the canonical values. Today's locked set captures the
 *      empirical usage post-R10 — 75 / 100 / 150 / 200 / 250 / 300 /
 *      500 / 700 / 1000. Direction of travel: the set shrinks over
 *      time as future PRs consolidate.
 *
 *   2. **Arbitrary durations + easings banned.** `duration-[Xms]` and
 *      `ease-[...]` brackets are forbidden because they bypass the
 *      Tailwind config and silently grow the surface area.
 *
 * The lock is a forward-enforcement ratchet — it doesn't force a
 * migration today, just prevents drift. Future tightening: remove
 * 100, 200, 700 from ALLOWED_DURATIONS as those callers migrate.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/** Locked set of duration values (in ms). Direction of travel: shrinks. */
const ALLOWED_DURATIONS = new Set<string>([
    '75',
    '100',
    '150',
    '200',
    '250',
    '300',
    '500',
    '700',
    '1000',
]);

/** Locked set of easing keywords. */
const ALLOWED_EASINGS = new Set<string>([
    'ease-out',
    'ease-in-out',
    'ease-in',
    'ease-linear',
]);

const SCAN_DIRS = ['src/components', 'src/app'];

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            walk(full, results);
        } else if (
            (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
            !entry.name.endsWith('.test.ts') &&
            !entry.name.endsWith('.test.tsx') &&
            !entry.name.endsWith('.spec.ts') &&
            !entry.name.endsWith('.spec.tsx')
        ) {
            results.push(full);
        }
    }
    return results;
}

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

describe('Animation language lock (R11-PR5)', () => {
    test('every duration-X class uses a value from the locked set', () => {
        const offenders: { file: string; value: string }[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.resolve(ROOT, dir))) {
                const src = stripComments(fs.readFileSync(file, 'utf-8'));
                const matches = src.matchAll(/\bduration-(\d+)\b/g);
                for (const m of matches) {
                    if (!ALLOWED_DURATIONS.has(m[1])) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            value: m[1],
                        });
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}  →  duration-${o.value}`)
                .join('\n');
            throw new Error(
                `${offenders.length} duration-X class(es) outside the locked set:\n${sample}\n\nLocked set: ${Array.from(ALLOWED_DURATIONS).join(', ')} ms.\n` +
                    'Fix: pick one of the locked values, or — if a new duration is genuinely needed — extend ALLOWED_DURATIONS in this test with a written reason.',
            );
        }
    });

    test('arbitrary duration brackets are banned', () => {
        const offenders: string[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.resolve(ROOT, dir))) {
                const src = stripComments(fs.readFileSync(file, 'utf-8'));
                if (/\bduration-\[[^\]]+\]/.test(src)) {
                    offenders.push(path.relative(ROOT, file));
                }
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} file(s) use arbitrary duration brackets (\`duration-[Xms]\`):\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: reach for one of the locked tailwind values (75/100/150/200/250/300/500/700/1000ms). Arbitrary brackets bypass the lock.',
            );
        }
    });

    test('every ease-X class uses a value from the locked set', () => {
        const offenders: { file: string; value: string }[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.resolve(ROOT, dir))) {
                const src = stripComments(fs.readFileSync(file, 'utf-8'));
                // Capture `ease-WORD` where WORD is the easing keyword.
                // Skip raw-numeric (`ease-100`) just in case Tailwind
                // exposes one — it doesn't today.
                const matches = src.matchAll(/\bease-([a-z][a-z-]*)\b/g);
                for (const m of matches) {
                    const value = `ease-${m[1]}`;
                    if (!ALLOWED_EASINGS.has(value)) {
                        offenders.push({
                            file: path.relative(ROOT, file),
                            value,
                        });
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}  →  ${o.value}`)
                .join('\n');
            throw new Error(
                `${offenders.length} ease-X class(es) outside the locked set:\n${sample}\n\nLocked: ${Array.from(ALLOWED_EASINGS).join(', ')}.\n`,
            );
        }
    });

    test('arbitrary ease brackets are banned', () => {
        const offenders: string[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.resolve(ROOT, dir))) {
                const src = stripComments(fs.readFileSync(file, 'utf-8'));
                if (/\bease-\[[^\]]+\]/.test(src)) {
                    offenders.push(path.relative(ROOT, file));
                }
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} file(s) use arbitrary ease brackets (\`ease-[cubic-bezier(...)]\`):\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: reach for one of the locked tailwind keywords (ease-out / ease-in-out / ease-in / ease-linear). Arbitrary brackets bypass the lock.',
            );
        }
    });
});

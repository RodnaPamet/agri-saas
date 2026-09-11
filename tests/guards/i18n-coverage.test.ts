/**
 * i18n coverage ratchet — every app `.tsx` that renders user-facing text
 * must route it through `next-intl` (so the Bulgarian — and any future —
 * locale actually translates it).
 *
 * Why this exists: the product is being made fully translatable. A file
 * that hardcodes a user-facing string (`<p>Change password</p>`,
 * `placeholder="Search…"`) silently ships English-only text that no locale
 * can override. The aggregate has no other structural guard, so a new
 * hardcoded-string component slips in unnoticed.
 *
 * How it works: a heuristic detector scans `src/app` + `src/components`
 * `.tsx` files for PROSE string literals in user-facing positions (JSX text
 * nodes and a small set of user-facing attributes) and flags any file that
 * has one but does NOT use `useTranslations` / `getTranslations` /
 * `next-intl`. The set of currently-unmigrated files is frozen in
 * `i18n-coverage-baseline.json`.
 *
 *   - A NEW offender (not in the baseline) fails the build — new UI must be
 *     translatable from day one.
 *   - Migrating a file (wiring it to next-intl) removes it from the
 *     detector's offender set, so its baseline entry becomes STALE and the
 *     ratchet requires deleting that line in the same PR.
 *
 * The baseline can therefore only SHRINK. The migration tasks drive it to
 * zero; when it's empty, delete the JSON and this file's baseline plumbing.
 *
 * The detector is deliberately conservative (prose-only, ASCII-word shaped)
 * to avoid flagging code, enum tokens, or `{expr}` interpolations — it
 * catches "obvious hardcoded sentence/label," not every conceivable string.
 * Set `I18N_DUMP=1` to regenerate the baseline from the current tree.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];
const BASELINE_PATH = path.join(__dirname, 'i18n-coverage-baseline.json');

const USES_I18N = /useTranslations|getTranslations|from ['"]next-intl/;
const JSX_TEXT = />([^<>{}]+)</g;
const USERFACING_ATTR =
    /\b(placeholder|aria-label|alt|emptyTitle|emptyDescription|emptyMessage|confirmLabel|cancelLabel|helperText|tooltip)\s*=\s*"([^"]{2,})"/g;
const PROSE = /^[A-Za-z][A-Za-z .,'’&%/…!?-]*$/;
const LETTERS = /[A-Za-z]/g;

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A user-facing prose string: a sentence/label, not code or an enum token. */
function isProse(raw: string): boolean {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 140) return false;
    if (!PROSE.test(t)) return false;
    if ((t.match(LETTERS) ?? []).length < 3) return false;
    // Multi-word prose, or a single Capitalised word (e.g. "Overdue").
    return t.includes(' ') || /^[A-Z][a-z]{2,}$/.test(t);
}

/** Does this source render at least one hardcoded user-facing string? */
export function hasHardcodedUserText(source: string): boolean {
    const s = stripComments(source);
    for (const m of s.matchAll(JSX_TEXT)) {
        const t = m[1];
        if (!t.includes('=') && isProse(t)) return true;
    }
    for (const m of s.matchAll(USERFACING_ATTR)) {
        const v = m[2];
        if (!v.startsWith('{') && isProse(v)) return true;
    }
    return false;
}

function walkTsx(dir: string): string[] {
    const out: string[] = [];
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) {
        throw new Error(`scan root does not exist: ${abs} — a renamed root would scan zero files and pass (#875)`);
    }
    const stack = [abs];
    while (stack.length) {
        const cur = stack.pop()!;
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
            const full = path.join(cur, e.name);
            if (e.isDirectory()) {
                if (e.name === '__tests__') continue;
                stack.push(full);
            } else if (
                e.name.endsWith('.tsx') &&
                !e.name.endsWith('.test.tsx') &&
                !e.name.endsWith('.stories.tsx')
            ) {
                out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
            }
        }
    }
    return out;
}

function computeOffenders(): string[] {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
        for (const rel of walkTsx(dir)) {
            const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
            if (USES_I18N.test(src)) continue;
            if (hasHardcodedUserText(src)) offenders.push(rel);
        }
    }
    return offenders.sort();
}

describe('i18n coverage ratchet', () => {
    const offenders = computeOffenders();

    if (process.env.I18N_DUMP) {
        fs.writeFileSync(BASELINE_PATH, JSON.stringify(offenders, null, 2) + '\n');
    }

    const baseline: string[] = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
    const baselineSet = new Set(baseline);
    const offenderSet = new Set(offenders);

    test('detector finds a non-trivial number of .tsx files to scan', () => {
        // Guards against a broken walker silently passing everything.
        const total = SCAN_DIRS.reduce((n, d) => n + walkTsx(d).length, 0);
        expect(total).toBeGreaterThan(500);
    });

    test('no NEW hardcoded-string file (every offender is in the baseline)', () => {
        const added = offenders.filter((f) => !baselineSet.has(f));
        if (added.length > 0) {
            throw new Error(
                `New file(s) render hardcoded user-facing text without next-intl:\n` +
                    added.map((f) => `  - ${f}`).join('\n') +
                    `\n\nWire the strings through useTranslations()/getTranslations() and\n` +
                    `messages/en.json (+ messages/bg.json). New UI must be translatable.`,
            );
        }
    });

    test('baseline has no STALE entries (migrated files were removed from it)', () => {
        const stale = baseline.filter((f) => !offenderSet.has(f));
        if (stale.length > 0) {
            throw new Error(
                `These files are no longer offenders — remove them from\n` +
                    `tests/guards/i18n-coverage-baseline.json in the same PR that migrated them:\n` +
                    stale.map((f) => `  - ${f}`).join('\n'),
            );
        }
    });

    test('baseline only shrinks — count never exceeds the recorded ceiling', () => {
        // The ceiling is lowered as migration PRs land. It must never grow.
        const CEILING = 300;
        expect(baseline.length).toBeLessThanOrEqual(CEILING);
    });

    test('every baseline entry points to a real file (no stale paths after refactors)', () => {
        const missing = baseline.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
        expect(missing).toEqual([]);
    });

    // Detector self-proof — catches a future edit that neuters the scan.
    test('detector flags hardcoded prose but not i18n or code', () => {
        expect(hasHardcodedUserText('export const A = () => <p>Change your password</p>;')).toBe(true);
        expect(hasHardcodedUserText('<input placeholder="Search locations" />')).toBe(true);
        // Uses i18n → not a hardcoded literal (the detector only sees the literal;
        // the file-level USES_I18N check exempts it in computeOffenders).
        expect(hasHardcodedUserText('<p>{t("changePassword")}</p>')).toBe(false);
        // Code / generics / expressions must not trip it.
        expect(hasHardcodedUserText('const x: Promise<Foo> = bar; a > b < c;')).toBe(false);
        expect(hasHardcodedUserText('<Icon name={kind} />')).toBe(false);
    });
});

/**
 * Polish PR-4 — Auth/error/fallback surface token discipline.
 *
 * The pages a user sees FIRST — login, error, no-tenant,
 * not-found — were bypassing the design system entirely. Login's
 * OAuth buttons used `bg-slate-800/50 text-slate-200`; error.tsx
 * and no-tenant used raw `px-4 py-2 rounded-md` instead of
 * <Button>; not-found mixed `text-gray-500` with semantic tokens.
 *
 * The product had a polished interior but a generic exterior.
 * Every other PR's quality was partially undone by this single
 * gap. This ratchet locks the migration in: zero raw slate / gray
 * utility classes on entry-surface pages.
 *
 * What this ratchet detects
 *   For files in SCAN_FILES (auth/error/fallback entry surfaces):
 *     - any `bg-slate-…` / `text-slate-…` / `border-slate-…`
 *     - any `bg-gray-…` / `text-gray-…` / `border-gray-…`
 *
 *   These tokens don't re-theme through the dark↔light system. The
 *   semantic tokens (`bg-bg-default`, `text-content-default`, …)
 *   are the canonical replacements.
 *
 * What this ratchet does NOT police
 *   `dark:` modifiers on legacy classes are still flagged — the
 *   semantic tokens already handle dark/light parity.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const SCAN_FILES: string[] = [
    'src/app/login/page.tsx',
    'src/app/error.tsx',
    'src/app/no-tenant/page.tsx',
    'src/app/not-found.tsx',
    // Elevation PR-6 — OnboardingWizard is the second surface a new
    // user sees. Migrated from per-step gradients + slate tones to
    // semantic tokens; ratchet covers it now to prevent drift back.
    'src/components/onboarding/OnboardingWizard.tsx',
    // Elevation PR-9 — print views are how customers SHARE the
    // product with auditors. They were a different design system
    // (bg-slate-100, text-gray-900). Migrated to semantic tokens;
    // ratchet covers print files now to prevent drift back.
];

const SLATE_RE = /\b(bg|text|border|ring|shadow)-slate-/;
const GRAY_RE = /\b(bg|text|border|ring|shadow)-gray-/;

interface Hit {
    file: string;
    line: number;
    text: string;
    kind: string;
}

describe('Auth/error/fallback surface token discipline (Polish PR-4)', () => {
    it('zero raw slate/gray utility classes on entry-surface pages', () => {
        const offenders: Hit[] = [];
        for (const rel of SCAN_FILES) {
            const abs = path.resolve(ROOT, rel);
            if (!fs.existsSync(abs)) continue;
            const content = fs.readFileSync(abs, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                const trimmed = line.trim();
                if (
                    trimmed.startsWith('//') ||
                    trimmed.startsWith('*') ||
                    trimmed.startsWith('/*')
                )
                    return;
                if (SLATE_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                        kind: 'slate',
                    });
                }
                if (GRAY_RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                        kind: 'gray',
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line} [${o.kind}]\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} raw slate/gray utility class(es) on entry-surface pages.\n\nThe first surface a user sees must be drawn by the same hand as the in-app surfaces. Replace with semantic tokens (bg-bg-default, text-content-default, border-border-subtle, …) so the dark↔light theme flip applies uniformly.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('every scanned file exists', () => {
        for (const rel of SCAN_FILES) {
            const abs = path.resolve(ROOT, rel);
            expect(fs.existsSync(abs)).toBe(true);
        }
    });
});

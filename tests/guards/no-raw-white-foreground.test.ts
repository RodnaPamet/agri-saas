/**
 * No raw `text-white` / `text-black` foreground in shared components.
 *
 * Bug class (recurring): a foreground colour hard-coded to one theme's
 * value is invisible/wrong in the OTHER theme. `text-white` looks fine
 * on the dark default theme but disappears on the light theme. It bit
 * `LinkedTasksPanel` (#771), then the practice → Traceability /
 * TestPlans panels + ForbiddenPage. The fix is always a semantic token
 * (`text-content-emphasis` / `-default` / `-muted`) which flips with
 * the theme.
 *
 * This ratchet bans `text-white` / `text-black` as a foreground class
 * anywhere under `src/components/**` EXCEPT the handful of files where
 * the text genuinely sits on a brand/dark/colour-filled background of
 * its own (so white is the correct, theme-independent choice). Each
 * exemption carries a written reason; a new offender outside the list
 * trips CI with a pointer to the semantic tokens.
 *
 * Scope is `src/components/**` — the shared/primitive layer that must
 * be theme-correct everywhere it's mounted. (Standalone public pages
 * under `src/app/audit/shared` + `src/app/vendor-assessment` carry
 * their own self-consistent palette and are out of scope.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const COMPONENTS = path.join(ROOT, 'src/components');

// Files where `text-white` sits on a colour-filled background of its
// own — white is the correct, theme-independent foreground there.
const ALLOWED = new Set<string>([
    // Brand-filled button surfaces (bg = var(--brand-*) / bg-black/25).
    'src/components/ui/button.tsx',
    'src/components/ui/button-variants.ts',
    // Checkbox on the brand-emphasis fill when checked.
    'src/components/ui/table/columns-dropdown.tsx',
    // Heat-map cell label sits on the computed heat-scale fill.
    'src/components/ui/RiskHeatmap.tsx',
    // Sparkles icon inside the brand-gradient onboarding circle.
    'src/components/onboarding/OnboardingBanner.tsx',
]);

const RE = /\btext-(?:white|black)\b/;

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Icon SVGs legitimately carry their own palette.
            if (entry.name === 'icons') continue;
            out.push(...walk(full));
        } else if (/\.(tsx|ts)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('No raw text-white / text-black foreground in components', () => {
    it('only the allow-listed brand/dark/chart surfaces use it', () => {
        const offenders: { file: string; line: number; text: string }[] = [];
        for (const abs of walk(COMPONENTS)) {
            const rel = path.relative(ROOT, abs);
            if (ALLOWED.has(rel)) continue;
            const stripped = fs
                .readFileSync(abs, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            stripped.split('\n').forEach((line, i) => {
                if (RE.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: line.trim().slice(0, 140),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} raw text-white/text-black foreground use(s) in components. These are invisible on the opposite theme — use a semantic token (text-content-emphasis / -default / -muted). If the text genuinely sits on a brand/dark/colour-filled background, add the file to ALLOWED with a reason.\n\n${sample}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

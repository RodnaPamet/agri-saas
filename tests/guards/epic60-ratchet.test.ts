/**
 * Epic 60 — rollout ratchet.
 *
 * Caps the count of known legacy interaction patterns in app-layer
 * code (`src/app/**` + select spots in `src/components/**`) at the
 * post-rollout floor, so they can only go DOWN over time. Adding a
 * new raw `<input type="number">`, inline `onKeyDown={(e) => e.key ===
 * 'Enter' && ...}`, or raw `localStorage.*Item` call in app code
 * fails CI and points at the shared primitive that replaces it.
 *
 * Why ratchet rather than "ban outright":
 *   - The MFA OTP page's Enter handler has a precondition
 *     (`code.length === 6`) that's cleaner as an inline check than as
 *     an `onSubmit` callback with a guard — kept as-is until someone
 *     has a good reason to migrate.
 *   - Two admin/vendor forms still use `<input type="number">` for
 *     large unbounded numeric fields where NumberStepper's +/- UX
 *     would hurt more than help. Ratchet, don't delete.
 *   - Deep-cleanup is a follow-up; the ratchet keeps the surface
 *     from regressing while we live with the known exceptions.
 *
 * Every count increment message includes a pointer at
 * `docs/epic-60-shared-hooks-and-polish.md` so a new contributor
 * reading the failure knows what to reach for.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_DIR = path.resolve(__dirname, '../../src/app');
const COMPONENTS_DIR = path.resolve(__dirname, '../../src/components');

function walk(dir: string, match: RegExp): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip node_modules-like subtrees just in case.
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            out.push(...walk(full, match));
        } else if (match.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function countMatches(files: string[], pattern: RegExp): { file: string; matches: number }[] {
    const results: { file: string; matches: number }[] = [];
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf-8');
        const matches = (src.match(pattern) ?? []).length;
        if (matches > 0) results.push({ file, matches });
    }
    return results;
}

const TSX_PATTERN = /\.tsx?$/;

describe('Epic 60 — legacy pattern ratchet', () => {
    const appFiles = walk(APP_DIR, TSX_PATTERN);
    const componentFiles = walk(COMPONENTS_DIR, TSX_PATTERN);

    // ── Raw <input type="number"> ─────────────────────────────────────

    it('caps raw `<input type="number">` in src/app/**', () => {
        const hits = countMatches(appFiles, /type=["']number["']/g);
        const total = hits.reduce((s, h) => s + h.matches, 0);
        // Post-rollout floor. Known legit exceptions:
        //   - src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/assessment/[assessmentId]/page.tsx
        //     (assessment-score field, variable range by question type)
        //   - src/app/t/[tenantSlug]/(app)/admin/security/page.tsx
        //     (sessionMaxAgeMinutes — unbounded max, large range)
        //   - src/app/t/[tenantSlug]/(app)/rent/RentClient.tsx
        //     (lease rent amount — an unbounded decimal price in лв/дка;
        //     NumberStepper's +/- step UX is meaningless for a free-entry
        //     price, same rationale as the two fields above. Mirrors the
        //     sibling ParcelLeasePanel's rent input.)
        const CAP = 3;
        if (total > CAP) {
            throw new Error(
                `Raw \`<input type="number">\` count in src/app/** rose to ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use <NumberStepper> from @/components/ui/number-stepper. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Inline onKeyDown Enter handlers ────────────────────────────────

    it('caps inline `e.key === "Enter"` handlers in src/app/**', () => {
        const hits = countMatches(appFiles, /e\.key === ['"]Enter['"]/g);
        const total = hits.reduce((s, h) => s + h.matches, 0);
        // Post-rollout floor: 1 (MFA OTP page, precondition-guarded).
        const CAP = 1;
        if (total > CAP) {
            throw new Error(
                `Inline \`e.key === "Enter"\` handler count in src/app/** rose to ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use useEnterSubmit from @/components/ui/hooks. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Raw localStorage calls in src/app/** ───────────────────────────

    it('bans raw localStorage.getItem / setItem in src/app/**', () => {
        const hits = countMatches(appFiles, /localStorage\.(getItem|setItem)/g);
        const total = hits.reduce((s, h) => s + h.matches, 0);
        // Post-rollout floor: 0. The approved direct-localStorage
        // modules (theme provider, filter presets, column-visibility
        // utils) all live in src/components or src/lib, not src/app.
        const CAP = 0;
        if (total > CAP) {
            throw new Error(
                `Raw localStorage.*Item call count in src/app/** is ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use useLocalStorage from @/components/ui/hooks. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Hand-rolled tab bars (heuristic) ───────────────────────────────

    it('caps hand-rolled tab bars (heuristic) in src/app/**', () => {
        // Heuristic: `<button onClick={() => setTab(…)} className={\`btn …\`}>`
        // appears in the two pre-Epic-60 tab-bar patterns we migrated
        // plus the practice-detail page (7 tabs, deliberately deferred).
        // The match pattern is deliberately narrow — we grep for
        // `className={\`btn ${…}\`}` on a setTab/setFilter onClick,
        // which was the legacy pattern. Post-rollout floor: 0 (the
        // practice-detail page uses a different structure that doesn't
        // match this pattern).
        const hits = countMatches(
            appFiles,
            /onClick=\{\(\) => setTab\([^)]+\)\}\s+className=\{`btn[\s\S]{0,60}btn-(primary|secondary|ghost)/g,
        );
        const total = hits.reduce((s, h) => s + h.matches, 0);
        const CAP = 0;
        if (total > CAP) {
            throw new Error(
                `Hand-rolled setTab tab bar pattern count in src/app/** is ${total} (cap ${CAP}). ` +
                    `New occurrences:\n${hits
                        .map((h) => `  ${path.relative(process.cwd(), h.file)}: ${h.matches}`)
                        .join('\n')}\n` +
                    `→ Use <TabSelect> (section nav) or <ToggleGroup> (filter/mode) from @/components/ui. ` +
                    `See docs/epic-60-shared-hooks-and-polish.md.`,
            );
        }
        expect(total).toBeLessThanOrEqual(CAP);
    });

    // ── Barrel completeness smoke ──────────────────────────────────────

    it('ui/hooks barrel re-exports every hook file', () => {
        // Epic 60 hook discoverability depends on consumers importing
        // from @/components/ui/hooks. A missing barrel entry silently
        // allows deep-path imports to proliferate — this smoke catches
        // the miss at the ratchet layer so the failure shows up in a
        // CI run that's scoped to Epic 60.
        const hooksDir = path.resolve(__dirname, '../../src/components/ui/hooks');
        const barrel = fs.readFileSync(path.join(hooksDir, 'index.ts'), 'utf-8');
        const files = fs
            .readdirSync(hooksDir)
            .filter((f) => /^use-.+\.tsx?$/.test(f));
        for (const f of files) {
            const stem = f.replace(/\.tsx?$/, '');
            expect(barrel).toContain(`./${stem}`);
        }
        // And prove the barrel was used by at least one primitive rollout.
        const testsClient = componentFiles.find((f) =>
            f.endsWith('src/components/onboarding/OnboardingWizard.tsx'),
        );
        if (testsClient) {
            const src = fs.readFileSync(testsClient, 'utf-8');
            expect(src).toMatch(/from ['"]@\/components\/ui\/hooks['"]/);
        }
    });
});

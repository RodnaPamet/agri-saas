/**
 * Roadmap-14 PR-9 — `<EnvironmentBadge>` discipline.
 *
 * Non-prod environment chip. Renders ONLY outside production —
 * STAGING (amber) and DEV (red-tinted). The single visual that
 * prevents "I edited prod by mistake."
 *
 * Five load-bearing invariants:
 *
 *   1. Returns `null` when env === 'prod'. The badge MUST NOT
 *      render in the production chrome — visual clutter +
 *      potential information leak (users seeing "PROD" in the
 *      bar might mistake it for a status they need to check).
 *
 *   2. Tones come from status colours, NOT brand. R10's
 *      StatusBadge brand-ban applies — using `--brand-default`
 *      here would make the chip look like an action affordance,
 *      not a status signal.
 *
 *   3. Detection is client-side via hostname matching. No env var
 *      required — the heuristic catches localhost + the canonical
 *      `staging.` / `*.staging.*` / `*-staging.` / `dev.` /
 *      `-dev.` patterns.
 *
 *   4. SSR default is `'prod'` so the badge isn't part of the
 *      SSR markup. The badge appears AFTER client-side detection;
 *      this avoids a hydration flash for non-prod users.
 *
 *   5. Carries `role="status"` + an env-specific `aria-label`
 *      so assistive tech announces the environment context.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const BADGE_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/environment-badge.tsx'),
    'utf8',
);
const TOP_CHROME_SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/TopChrome.tsx'),
    'utf8',
);

describe('Roadmap-14 PR-9 — EnvironmentBadge discipline', () => {
    describe('component', () => {
        it('exports `EnvironmentBadge` as a named export', () => {
            expect(BADGE_SRC).toMatch(
                /export\s+function\s+EnvironmentBadge\b/,
            );
        });

        it('returns null when env === "prod"', () => {
            // The badge MUST NOT render in production. Hardcoded
            // null return on the prod branch is the safety guarantee.
            expect(BADGE_SRC).toMatch(
                /if\s*\(\s*env\s*===\s*['"]prod['"]\s*\)\s*return\s+null/,
            );
        });

        it('renders distinct elements for staging vs dev', () => {
            // Two visible states; each gets its own element so the
            // tone classes don't conflate (one shared element with
            // a ternary on tone would still work but loses the
            // structural anchor for the ratchet).
            expect(BADGE_SRC).toMatch(/data-env="staging"/);
            expect(BADGE_SRC).toMatch(/data-env="dev"/);
        });
    });

    describe('tones — status colour vocabulary (NOT brand)', () => {
        it('STAGING uses `bg-warning-emphasis` (amber)', () => {
            // Amber = "watch out, rehearsal stage". The
            // canonical warning surface.
            expect(BADGE_SRC).toMatch(
                /BADGE_STAGING_CLASS[\s\S]+?bg-bg-warning-emphasis/,
            );
        });

        it('DEV uses `bg-error-emphasis` (red)', () => {
            // Red = "this is the scratchpad; nothing here is
            // load-bearing". Matches the destructive primary tone.
            expect(BADGE_SRC).toMatch(
                /BADGE_DEV_CLASS[\s\S]+?bg-bg-error-emphasis/,
            );
        });

        it('does NOT use any brand-colour token', () => {
            // R10 StatusBadge brand-ban applies. The badge is a
            // status signal, not a brand affordance — brand tones
            // would make it look like an action button.
            //
            // Strip comments so doc-comments mentioning brand
            // don't trip the structural detector.
            const stripped = blankNonCode(BADGE_SRC);
            expect(stripped).not.toMatch(
                /bg-\[var\(--brand-(default|emphasis|muted)\)\]/,
            );
            expect(stripped).not.toMatch(
                /bg-bg-info-emphasis|bg-bg-success-emphasis/,
            );
        });
    });

    describe('detection', () => {
        it('reads `window.location.hostname` (client-side only)', () => {
            // No env var dependency — the heuristic is portable
            // across deploy targets.
            expect(BADGE_SRC).toMatch(
                /window\.location\.hostname/,
            );
        });

        it('SSR default is "prod" (badge hidden in SSR markup)', () => {
            // The badge appears AFTER client-side detection. SSR
            // rendering the badge would cause a hydration flash
            // for non-prod users.
            expect(BADGE_SRC).toMatch(
                /useState<AppEnv>\(\s*['"]prod['"]\s*\)/,
            );
        });

        it('catches localhost / 127.0.0.1 / *.local as DEV', () => {
            expect(BADGE_SRC).toMatch(/host\s*===\s*['"]localhost['"]/);
            expect(BADGE_SRC).toMatch(/host\s*===\s*['"]127\.0\.0\.1['"]/);
            expect(BADGE_SRC).toMatch(
                /host\.endsWith\(\s*['"]\.local['"]\s*\)/,
            );
        });

        it('catches staging hosts via three canonical patterns', () => {
            // `staging.` prefix + `.staging.` infix + `-staging.`
            // suffix. Covers the most common deploy patterns:
            //   staging.inflect.io
            //   us.staging.inflect.io
            //   inflect-staging.vercel.app
            expect(BADGE_SRC).toMatch(
                /host\.startsWith\(\s*['"]staging\.['"]\s*\)/,
            );
            expect(BADGE_SRC).toMatch(
                /host\.includes\(\s*['"]\.staging\.['"]\s*\)/,
            );
            expect(BADGE_SRC).toMatch(
                /host\.includes\(\s*['"]-staging\.['"]\s*\)/,
            );
        });

        it('catches dev hosts via `dev.` and `-dev.` patterns', () => {
            expect(BADGE_SRC).toMatch(
                /host\.includes\(\s*['"]dev\.['"]\s*\)/,
            );
            expect(BADGE_SRC).toMatch(
                /host\.includes\(\s*['"]-dev\.['"]\s*\)/,
            );
        });
    });

    describe('accessibility', () => {
        it('carries `role="status"` on both rendered forms', () => {
            // The badge IS a status announcement. Screen readers
            // pick it up on render so the user knows the
            // environment context.
            const statusMatches =
                BADGE_SRC.match(/role="status"/g) ?? [];
            expect(statusMatches.length).toBeGreaterThanOrEqual(2);
        });

        it('carries an env-specific `aria-label`', () => {
            // i18n (T04): aria-labels route through next-intl; the copy
            // ("Staging environment" / "Development environment") lives in
            // messages/en.json under environmentBadge.stagingAria/devAria.
            expect(BADGE_SRC).toMatch(
                /aria-label=\{t\(['"]stagingAria['"]\)\}/,
            );
            expect(BADGE_SRC).toMatch(
                /aria-label=\{t\(['"]devAria['"]\)\}/,
            );
        });
    });

    describe('TopChrome wiring', () => {
        it('imports EnvironmentBadge from `./environment-badge`', () => {
            expect(TOP_CHROME_SRC).toMatch(
                /import\s+\{\s*EnvironmentBadge\s*\}\s+from\s+['"]\.\/environment-badge['"]/,
            );
        });

        it('mounts EnvironmentBadge in the left slot AFTER the brand mark', () => {
            // Slot order: brand mark first, env badge second,
            // breadcrumbs after. The env badge "stamps" the brand
            // mark with its context.
            const brandIdx = TOP_CHROME_SRC.indexOf('<NavBarBrand ');
            const envIdx = TOP_CHROME_SRC.indexOf('<EnvironmentBadge ');
            const breadcrumbsIdx = TOP_CHROME_SRC.indexOf('<Breadcrumbs');
            expect(brandIdx).toBeGreaterThan(-1);
            expect(envIdx).toBeGreaterThan(brandIdx);
            // Breadcrumbs comes after env badge.
            expect(breadcrumbsIdx).toBeGreaterThan(envIdx);
        });
    });
});

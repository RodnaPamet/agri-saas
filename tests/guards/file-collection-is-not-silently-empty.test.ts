/**
 * A guard that collects files must not be able to collect NOTHING (#865).
 *
 * ## The measurement
 *
 * A mutation sweep of the 94 guards most at risk of the empty-selection defect
 * found 47 with a dead selector — 81% of the 58 the harness could audit — and
 * 37 of the 47 were the same hand-rolled `walk`, gutable to `return []` with
 * every assertion built on it still green.
 *
 * #875/#876/#894 already made 87 guards throw on a MISSING scan root. That was
 * not enough, and the number says so plainly: 35 of these 47 carry
 * that throw and are still dead. A root that resolves says nothing about whether
 * the walk found anything — the filter can match zero files, an exclude
 * predicate can eat the population, and a gutted collector returns `[]` from a
 * directory that exists. The rule has to be asserted on the RESULT.
 *
 * ## What this guard does, and what it deliberately does not
 *
 * It does NOT try to detect "has a non-empty assertion somewhere". That is a
 * text search over arbitrary code, and a check that cannot tell a real assertion
 * from a mention is the same class of defect one level up.
 *
 * Instead it holds a LIST. Every guard that collects files today is recorded
 * below; the list may only SHRINK, and a file that collects files without being
 * on it fails. So the class cannot grow while the batches migrate.
 *
 * ## Why the list is 223 and not 47
 *
 * The 47 are the confirmed-dead subset of a 94-file at-risk sample. Widening the
 * query to "collects files at all" gives 223 — meaning 176 collectors have
 * never been audited by anything. They are not known-bad; they are unknown,
 * which is a different fact, and is why they are recorded rather than asserted
 * about.
 *
 * ## Migrating a file off the list
 *
 * Replace its hand-rolled collection with `collectSourceFiles` /
 * `collectTrackedFiles` from `tests/helpers/collect-files.ts`, which throw on an
 * empty result, then delete its line here in the same PR.
 *
 * Expect the mutation harness to report a migrated file as `NOT AUDITED`
 * afterwards: it no longer has a module-level collector to gut. The guarantee
 * moves from "we mutated its collector and it noticed" to "its collector cannot
 * return empty", proved by executing tests in `tests/unit/collect-files.test.ts`
 * rather than inferred from a mutation.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const GUARD_DIRS = ['tests/guards', 'tests/guardrails'];

/** Hand-rolled collection: a filesystem walk, a git index read, or a glob. */
const COLLECTS = /readdirSync|ls-files|glob\(/;

/** The shared helper. A file importing this is migrated. */
const HELPER = /helpers\/collect-files/;

/**
 * Files that still collect their own. MAY ONLY SHRINK — delete a line in the
 * same PR that migrates its file. Recorded 223, the complete population
 * at the time this guard landed; 216 after BATCH 1 (the security/architecture
 * group) moved onto the shared collector.
 */
const HAND_ROLLED_COLLECTORS: readonly string[] = [
    'tests/guards/action-label-vocabulary.test.ts',
    'tests/guards/admin-cell-text-size.test.ts',
    'tests/guards/admin-datatable-no-double-card.test.ts',
    'tests/guards/animation-language-lock.test.ts',
    'tests/guards/animation-vocabulary.test.ts',
    'tests/guards/app-router-module-exports.test.ts',
    'tests/guards/async-params-route-typing.test.ts',
    'tests/guards/audit-gate-no-ci-overrides.test.ts',
    'tests/guards/audit-structured-events.test.ts',
    'tests/guards/automation-catalog-emitter-coverage.test.ts',
    'tests/guards/automation-event-catalog-coherence.test.ts',
    'tests/guards/badge-density.test.ts',
    'tests/guards/bg-projection-single-source.test.ts',
    'tests/guards/border-tone-budget.test.ts',
    'tests/guards/button-label-centering.test.ts',
    'tests/guards/button-variant-cull.test.ts',
    'tests/guards/cancel-button-size-parity.test.ts',
    'tests/guards/cancel-button-variant-discipline.test.ts',
    'tests/guards/card-density-discipline.test.ts',
    'tests/guards/card-elevation-discipline.test.ts',
    'tests/guards/card-padding-lockdown.test.ts',
    'tests/guards/card-pretender-eradication.test.ts',
    'tests/guards/card-primitive-only.test.ts',
    'tests/guards/cardvariants-server-import.test.ts',
    'tests/guards/ci-failure-watchlist.test.ts',
    'tests/guards/columns-dropdown-coverage.test.ts',
    'tests/guards/content-tone-opacity-discipline.test.ts',
    'tests/guards/create-button-uniformity.test.ts',
    'tests/guards/csp-nonce-component-scripts-patch.test.ts',
    'tests/guards/csp-script-guardrails.test.ts',
    'tests/guards/dashboard-anatomy.test.ts',
    'tests/guards/datatable-fillbody-coverage.test.ts',
    'tests/guards/datatable-mobile-fallback.test.ts',
    'tests/guards/datatable-selection-default-on.test.ts',
    'tests/guards/deferral-comments-name-an-issue.test.ts',
    'tests/guards/dependency-risk-review.test.ts',
    'tests/guards/destructive-migration-has-inverse.test.ts',
    'tests/guards/destructive-vocabulary.test.ts',
    'tests/guards/detail-page-back-prop-ban.test.ts',
    'tests/guards/detail-page-breadcrumbs.test.ts',
    'tests/guards/detail-page-metastrip-adoption.test.ts',
    'tests/guards/detail-page-tabs-slot.test.ts',
    'tests/guards/deterministic-install.test.ts',
    'tests/guards/disabled-state-discipline.test.ts',
    'tests/guards/download-route-gate-reachability.test.ts',
    'tests/guards/e2e-isolation.test.ts',
    'tests/guards/e2e-teardown-tables.test.ts',
    'tests/guards/empty-loading-primitive-only.test.ts',
    'tests/guards/empty-state-coverage.test.ts',
    'tests/guards/empty-state-vocabulary.test.ts',
    'tests/guards/entity-detail-shell-coverage.test.ts',
    'tests/guards/epic51-theme-token-guard.test.ts',
    'tests/guards/epic52-datatable-ratchet.test.ts',
    'tests/guards/epic55-native-select-ratchet.test.ts',
    'tests/guards/epic60-ratchet.test.ts',
    'tests/guards/error-state-adoption.test.ts',
    'tests/guards/eyebrow-discipline.test.ts',
    'tests/guards/file-security-guards.test.ts',
    'tests/guards/filter-toolbar-coverage.test.ts',
    'tests/guards/focus-ring-discipline.test.ts',
    'tests/guards/focus-ring-offset-discipline.test.ts',
    'tests/guards/form-drift.test.ts',
    'tests/guards/format-date-no-aliases.test.ts',
    'tests/guards/formfield-coverage.test.ts',
    'tests/guards/generated-columns.test.ts',
    'tests/guards/heading-primitive-discipline.test.ts',
    'tests/guards/heromemtric-canonical-home.test.ts',
    'tests/guards/hover-recipe-discipline.test.ts',
    'tests/guards/hover-state-language.test.ts',
    'tests/guards/i18n-coverage.test.ts',
    'tests/guards/i18n-key-exists.test.ts',
    'tests/guards/i18n-use-client-directive.test.ts',
    'tests/guards/icon-only-action-discipline.test.ts',
    'tests/guards/icon-size-discipline.test.ts',
    'tests/guards/infra-directories-are-referenced.test.ts',
    'tests/guards/inline-form-action-order.test.ts',
    'tests/guards/inline-notice-discipline.test.ts',
    'tests/guards/inline-subtitle-budget.test.ts',
    'tests/guards/invite-email-locale-wiring.test.ts',
    'tests/guards/ios-input-autozoom.test.ts',
    'tests/guards/k6-threshold-binding.test.ts',
    'tests/guards/legacy-badge-eradication.test.ts',
    'tests/guards/link-styling-discipline.test.ts',
    'tests/guards/list-page-shell-coverage.test.ts',
    'tests/guards/load-script-routes-exist.test.ts',
    'tests/guards/loading-text-discipline.test.ts',
    'tests/guards/metadatabar-detail-coverage.test.ts',
    'tests/guards/metric-typography.test.ts',
    'tests/guards/modal-action-order.test.ts',
    'tests/guards/modal-overlay-guard.test.ts',
    'tests/guards/modal-width-tokens.test.ts',
    'tests/guards/motion-language-discipline.test.ts',
    'tests/guards/motion-language.test.ts',
    'tests/guards/multi-select-facet-route-parity.test.ts',
    'tests/guards/nav-routes-exist.test.ts',
    'tests/guards/no-ad-hoc-tooltip-title.test.ts',
    'tests/guards/no-decorative-emoji-in-messages.test.ts',
    'tests/guards/no-explicit-any-ratchet.test.ts',
    'tests/guards/no-hand-rolled-menus.test.ts',
    'tests/guards/no-hardcoded-ui-strings.test.ts',
    'tests/guards/no-horizontal-drift-patterns.test.ts',
    'tests/guards/no-inline-clipboard.test.ts',
    'tests/guards/no-inline-pills.test.ts',
    'tests/guards/no-inline-tab-strip.test.ts',
    'tests/guards/no-legacy-brand.test.ts',
    'tests/guards/no-legacy-peer-deps.test.ts',
    'tests/guards/no-lucide.test.ts',
    'tests/guards/no-nested-cards.test.ts',
    'tests/guards/no-plus-prefix-labels.test.ts',
    'tests/guards/no-raw-palette-greys.test.ts',
    'tests/guards/no-raw-skeleton-pulse.test.ts',
    'tests/guards/no-raw-tables-in-app-pages.test.ts',
    'tests/guards/no-raw-white-foreground.test.ts',
    'tests/guards/no-renegade-bg-tokens.test.ts',
    'tests/guards/no-unsafe-any.test.ts',
    'tests/guards/no-untyped-api-response.test.ts',
    'tests/guards/no-usestate-any.test.ts',
    'tests/guards/offline-spec-chunk-warmup.test.ts',
    'tests/guards/overlay-viewport-units.test.ts',
    'tests/guards/p5a-snapshots-table-sidebar.test.ts',
    'tests/guards/page-actions-discipline.test.ts',
    'tests/guards/page-breadcrumbs-coverage.test.ts',
    'tests/guards/payload-url-scheme.test.ts',
    'tests/guards/primary-action-budget.test.ts',
    'tests/guards/primary-secondary-ratio.test.ts',
    'tests/guards/prisma-include-fields-exist.test.ts',
    'tests/guards/promotions-drift.test.ts',
    'tests/guards/public-routes-self-authenticate.test.ts',
    'tests/guards/r14-nav-bar-import-discipline.test.ts',
    'tests/guards/r14-no-page-searchbars.test.ts',
    'tests/guards/r20-pra-foundation.test.ts',
    'tests/guards/r21-prf-bar3d-capstone.test.ts',
    'tests/guards/r22-prf-capstone.test.ts',
    'tests/guards/r30-group-nodes.test.ts',
    'tests/guards/radius-scale-discipline.test.ts',
    'tests/guards/raw-color-eradication.test.ts',
    'tests/guards/regression-scanner.test.ts',
    'tests/guards/rendered-coverage-floor.test.ts',
    'tests/guards/required-marker-discipline.test.ts',
    'tests/guards/reverse-tabnabbing-guard.test.ts',
    'tests/guards/scan-roots-resolve.test.ts',
    'tests/guards/scim-routes-self-authenticate.test.ts',
    'tests/guards/search-placeholder-vocabulary.test.ts',
    'tests/guards/selector-teeth-no-stray-mutations.test.ts',
    'tests/guards/shadow-discipline.test.ts',
    'tests/guards/shell-checks-that-cannot-fail.test.ts',
    'tests/guards/sign-out-purges.test.ts',
    'tests/guards/single-app-shell.test.ts',
    'tests/guards/single-h1-per-page.test.ts',
    'tests/guards/single-tab-pattern.test.ts',
    'tests/guards/skeleton-shimmer-adoption.test.ts',
    'tests/guards/skeleton-tone-discipline.test.ts',
    'tests/guards/spacing-cadence.test.ts',
    'tests/guards/spacing-scale-discipline.test.ts',
    'tests/guards/state-coverage.test.ts',
    'tests/guards/state-language.test.ts',
    'tests/guards/state-primitives-discipline.test.ts',
    'tests/guards/status-badge-discipline.test.ts',
    'tests/guards/status-badge-no-brand.test.ts',
    'tests/guards/swr-error-branch.test.ts',
    'tests/guards/tab-count-discipline.test.ts',
    'tests/guards/toast-vocabulary.test.ts',
    'tests/guards/tooltip-touch-uniformity.test.ts',
    'tests/guards/truncation-max-width-tokens.test.ts',
    'tests/guards/typography-eradication.test.ts',
    'tests/guards/ui-hooks-barrel.test.ts',
    'tests/guards/upload-route-scan-reachability.test.ts',
    'tests/guards/upload-scan-explicitness.test.ts',
    'tests/guards/ux-foundation-ratchets.test.ts',
    'tests/guards/vr1-vr2-automation-canvas.test.ts',
    'tests/guards/web-platform-identifiers.test.ts',
    'tests/guards/workflow-rls-role-bootstrap.test.ts',
    'tests/guardrails/admin-layout-guard.test.ts',
    'tests/guardrails/admin-route-coverage.test.ts',
    'tests/guardrails/ag-audit-event-coverage.test.ts',
    'tests/guardrails/ag-ledger-migration-safety.test.ts',
    'tests/guardrails/api-error-wrapper-coverage.test.ts',
    'tests/guardrails/api-permission-coverage.test.ts',
    'tests/guardrails/b8-followup-evidence-folders.test.ts',
    'tests/guardrails/button-consistency.test.ts',
    'tests/guardrails/ci-retry-loop-timeout.test.ts',
    'tests/guardrails/dashboard-chart-bypass.test.ts',
    'tests/guardrails/date-display-consistency.test.ts',
    'tests/guardrails/date-input-rollout.test.ts',
    'tests/guardrails/design-system-drift.test.ts',
    'tests/guardrails/enterprise-identity-epic.test.ts',
    'tests/guardrails/geo-raw-sql-containment.test.ts',
    'tests/guardrails/hibp-coverage.test.ts',
    'tests/guardrails/html-template-escaping.test.ts',
    'tests/guardrails/i18n-completeness.test.ts',
    'tests/guardrails/icon-a11y.test.ts',
    'tests/guardrails/keyboard-shortcut-conventions.test.ts',
    'tests/guardrails/license-hygiene.test.ts',
    'tests/guardrails/lifecycle-sweep-coverage.test.ts',
    'tests/guardrails/loading-states.test.ts',
    'tests/guardrails/logging-import-hygiene.test.ts',
    'tests/guardrails/membership-identity.test.ts',
    'tests/guardrails/no-auto-join.test.ts',
    'tests/guardrails/no-compact-filter-bar.test.ts',
    'tests/guardrails/no-direct-stock-writes.test.ts',
    'tests/guardrails/no-emoji-icons.test.ts',
    'tests/guardrails/no-explicit-any-ratchet.test.ts',
    'tests/guardrails/no-secrets.test.ts',
    'tests/guardrails/offline-pwa-coverage.test.ts',
    'tests/guardrails/org-audit-coverage.test.ts',
    'tests/guardrails/parcel-authoring-coverage.test.ts',
    'tests/guardrails/pii-hash-not-null.test.ts',
    'tests/guardrails/pr-asset-practice-codes.test.ts',
    'tests/guardrails/prisma-schema-folder-coverage.test.ts',
    'tests/guardrails/query-shape-guardrails.test.ts',
    'tests/guardrails/raw-color-ratchet.test.ts',
    'tests/guardrails/responsive-tokens.test.ts',
    'tests/guardrails/rls-coverage.test.ts',
    'tests/guardrails/schema-index-coverage.test.ts',
    'tests/guardrails/table-platform-drift.test.ts',
    'tests/guardrails/usecase-test-coverage.test.ts',
];

function collectorsOnDisk(): string[] {
    const found: string[] = [];
    for (const dir of GUARD_DIRS) {
        const abs = path.join(ROOT, dir);
        // This guard's own selector, held to the rule it enforces.
        if (!fs.existsSync(abs)) throw new Error(`guard directory missing: ${dir}`);
        for (const name of fs.readdirSync(abs).sort()) {
            if (!name.endsWith('.test.ts')) continue;
            const rel = `${dir}/${name}`;
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            if (COLLECTS.test(src) && !HELPER.test(src)) found.push(rel);
        }
    }
    return found;
}

describe('the guard that enforces this is not itself empty', () => {
    it('finds guard files at all', () => {
        // Every assertion below is over a selection, so the selection has to be
        // shown non-empty first. That is the entire subject of this file.
        const total = GUARD_DIRS.flatMap((d) =>
            fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.test.ts')),
        );
        expect(total.length).toBeGreaterThan(400);
    });

    it('finds collectors on disk, so the comparisons below mean something', () => {
        expect(collectorsOnDisk().length).toBeGreaterThan(0);
    });

    it('the recorded list is not empty', () => {
        expect(HAND_ROLLED_COLLECTORS.length).toBeGreaterThan(0);
    });
});

describe('no NEW guard collects files by hand', () => {
    it('every collector is either migrated or recorded', () => {
        const unrecorded = collectorsOnDisk().filter((f) => !HAND_ROLLED_COLLECTORS.includes(f));
        if (unrecorded.length > 0) {
            throw new Error(
                [
                    'These guards collect files by hand and are not recorded:',
                    ...unrecorded.map((f) => `  ${f}`),
                    '',
                    'A hand-rolled collector can be gutted to return [] with every',
                    'assertion built on it still green — measured at 81 percent of the',
                    'guards an automated sweep could audit.',
                    '',
                    'Use collectSourceFiles / collectTrackedFiles from',
                    'tests/helpers/collect-files.ts, which refuse an empty result.',
                ].join('\n'),
            );
        }
        expect(unrecorded).toEqual([]);
    });

    it('the list only shrinks — a migrated file must lose its line', () => {
        const onDisk = new Set(collectorsOnDisk());
        const stale = HAND_ROLLED_COLLECTORS.filter((f) => !onDisk.has(f));
        if (stale.length > 0) {
            throw new Error(
                [
                    'These no longer collect by hand — delete their lines:',
                    ...stale.map((f) => `  ${f}`),
                    '',
                    'Leaving them listed lets the record rot into a permanent allowlist,',
                    'which is what a shrink-only list exists to prevent.',
                ].join('\n'),
            );
        }
        expect(stale).toEqual([]);
    });
});

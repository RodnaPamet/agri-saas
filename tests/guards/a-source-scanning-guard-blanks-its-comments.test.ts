/**
 * The arrival rail for #1774: a NEW guard may not grep source text for a code
 * pattern without routing it through `blankNonCode`.
 *
 * ## Why a rail before the conversions
 *
 * #1774 asks for a sweep — convert every source-text guard, re-measure every
 * count-based cap, lower each to its live figure. That is several PRs. This
 * one is first because without it the sweep is a treadmill: guards are added
 * to this repo faster than a multi-PR conversion lands, and each new one
 * arrives with the same defect.
 *
 * So the list below is a DEBT REGISTER, not an exemption list. It is asserted
 * EXACTLY, which makes it shrink-only in both directions that matter:
 *
 *   • a new unblanked scanner fails on arrival — it is not in the list;
 *   • a converted guard ALSO fails until its entry is deleted, so the register
 *     cannot silently keep names that no longer belong to it.
 *
 * A count-based cap would allow a swap — convert one, add one, total
 * unchanged — which is the `a-gate-narrow-enough-to-always-pass` failure in
 * its subtlest form. The exact set refuses that.
 *
 * ## What the entries mean
 *
 * Each is a guard whose verdict DEPENDS on prose: it matches a code-shaped
 * literal against file content it never blanked. That is not a claim the
 * guard is wrong today — most are probably right — it is the property #1774
 * asks to remove, because the failure is silent in both directions:
 *
 *   • prose inflates a count (`no-explicit-any-ratchet`, 131 -> 132, #1773);
 *   • prose fakes a presence, and the guard then SKIPS the file it should
 *     have demanded an exemption for (`api-error-wrapper-coverage`, #1770).
 *
 * The second is why this is worth a sweep rather than a lint rule: a guard
 * that stops covering a route reports success for ever.
 *
 * ## Deliberately out of scope
 *
 * Patterns matched against a PATH (`p.includes('.tsx')`) are not listed and
 * never will be — blanking a comment cannot change a filename. Restricting to
 * content receivers is what takes this from 452 files of noise to 44 a person
 * can work through. See `tests/helpers/source-text-scanners.ts` for the three
 * conditions and why each is required.
 */
import { blankNonCode } from '../helpers/blank-non-code';
import { findSourceTextScanners } from '../helpers/source-text-scanners';

/**
 * Guards that still read source text without blanking it (#1774).
 *
 * SHRINK ONLY. Converting a guard means deleting its line here in the same
 * diff — the assertion below fails either way round, which is the point.
 * Do not add to this list: a new guard should blank from the start.
 */
const AWAITING_CONVERSION: readonly string[] = [
    'tests/guardrails/admin-route-coverage.test.ts',
    'tests/guardrails/api-read-rate-limit.test.ts',
    'tests/guardrails/cva-primitives.test.ts',
    'tests/guardrails/deploy-env-parity.test.ts',
    'tests/guardrails/form-primitive-adoption.test.ts',
    'tests/guardrails/keyboard-shortcut-conventions.test.ts',
    'tests/guardrails/no-client-side-filtering.test.ts',
    'tests/guardrails/no-compact-filter-bar.test.ts',
    'tests/guardrails/pr-1-tenant-tables-org-parity.test.ts',
    'tests/guardrails/redis-prod-required.test.ts',
    'tests/guardrails/table-platform-drift.test.ts',
    'tests/guards/api-key-auth-enabled.test.ts',
    'tests/guards/audit-structured-events.test.ts',
    'tests/guards/automation-event-catalog-coherence.test.ts',
    'tests/guards/cardvariants-server-import.test.ts',
    'tests/guards/donut-chart-centering.test.ts',
    'tests/guards/download-route-gate-reachability.test.ts',
    'tests/guards/epic-67-rollout-coverage.test.ts',
    'tests/guards/invite-email-locale-wiring.test.ts',
    'tests/guards/modal-payload-schema-parity.test.ts',
    'tests/guards/notif-task-due-emit-coverage.test.ts',
    'tests/guards/offline-spec-chunk-warmup.test.ts',
    'tests/guards/oi-3-backup-restore.test.ts',
    'tests/guards/optimistic-status-rollback.test.ts',
    'tests/guards/p-polish-a.test.ts',
    'tests/guards/p-polish-c.test.ts',
    'tests/guards/p5a-snapshots-table-sidebar.test.ts',
    'tests/guards/postgis-image-single-source.test.ts',
    'tests/guards/r31-left-palette.test.ts',
    'tests/guards/rls-coverage-skip-visibility.test.ts',
    'tests/guards/sign-out-purges.test.ts',
    'tests/guards/slow-mode-escape-is-not-throttled.test.ts',
    'tests/guards/sw-revision-stamp.test.ts',
    'tests/unit/audit-guardrails.test.ts',
    'tests/unit/data-table.test.ts',
    'tests/unit/filter-standardization.test.ts',
    'tests/unit/job-scope-audit.test.ts',
    'tests/unit/job-tenant-isolation-regression.test.ts',
    'tests/unit/middleware-org-route-structural.test.ts',
    'tests/unit/no-direct-prisma.test.ts',
    'tests/unit/notification-eligibility-guardrail.test.ts',
    'tests/unit/observability-guards.test.ts',
    'tests/unit/rsc-regression.test.ts',
    'tests/unit/tenant-isolation-structural.test.ts',
];

describe('a source-scanning guard blanks its comments (#1774)', () => {
    const found = findSourceTextScanners();

    it('ranges over every guard root — the denominator', () => {
        console.log(
            `[source-text-scanners] ${found.length} guard(s) match a code-shaped literal `
                + `against unblanked file content; ${AWAITING_CONVERSION.length} on the register`,
        );
        // A detector that found nothing would pass the exact-match assertion
        // only when the register is empty, and would then sit green for ever
        // while the repo refilled with unblanked guards. Until the sweep is
        // finished the real figure is well above zero; when it reaches zero
        // this guard should assert emptiness and this floor should go.
        expect(found.length).toBeGreaterThan(0);
    });

    it('detects an unblanked scanner, and stops detecting once it blanks — the control', () => {
        // Both directions in one test. Without the second half a detector that
        // flagged EVERYTHING would pass the first half, and the register would
        // be unclearable — work that can never be finished reads the same as
        // work nobody did.
        const unblanked = `
            import { readFileSync } from 'node:fs';
            const content = readFileSync(abs, 'utf8');
            if (content.includes('withApiErrorHandling')) pass();
        `;
        const blanked = unblanked.replace(
            "const content = readFileSync(abs, 'utf8');",
            "const content = blankNonCode(readFileSync(abs, 'utf8'));",
        );
        const looksAtRisk = (src: string) =>
            !src.includes('blankNonCode')
            && /(\w+)\s*\.\s*includes\(\s*'[^']{4,70}'/.test(blankNonCode(src));
        expect(looksAtRisk(unblanked)).toBe(true);
        expect(looksAtRisk(blanked)).toBe(false);
    });

    it('a pattern quoted only in a comment is not collected — the dogfooding check', () => {
        // This guard reads other guards, so it is exposed to exactly the bug it
        // polices. `findSourceTextScanners` blanks each guard before reading
        // its patterns; without that, the docblock three lines above — which
        // quotes `.includes('withApiErrorHandling')` — would register as a live
        // pattern and this file would list itself.
        expect(found.map((s) => s.file)).not.toContain(
            'tests/guards/a-source-scanning-guard-blanks-its-comments.test.ts',
        );
    });

    it('the register names exactly the guards still reading prose', () => {
        // Sorted joins rather than set equality: when this fails the message
        // should show WHICH line moved, not that two arrays differ.
        expect(found.map((s) => s.file).join('\n')).toBe([...AWAITING_CONVERSION].sort().join('\n'));
    });
});

/**
 * Guardrail — Ag observability (feat/observability): audit-event +
 * trace-span coverage for the critical field workflows.
 *
 * The ag domain reuses the freeform-string `logEvent({ action })` audit
 * writer (no Prisma enum, no migration), so — unlike `OrgAuditAction` —
 * there's no schema enum to enumerate. Instead this guardrail holds a
 * CURATED list of the ag audit actions the observability epic wired, and
 * asserts each is still emitted somewhere in `src/app-layer`. A future
 * refactor that renames or drops one of these actions (silently breaking
 * the Grafana dashboard / audit-stream consumers that key on them) fails
 * CI in the same diff.
 *
 * It also holds the companion invariant for traces: each critical ag
 * usecase must stay wrapped in a trace span whose operation name matches
 * the one the Prometheus recording rules + SLO alerts query
 * (`ag_operation_duration_milliseconds` is keyed by that exact string).
 *
 * Detection is a static source scan, so it catches a silent rename even
 * if no test exercises the path. The mutation regression proofs at the
 * bottom confirm both detectors are real (not vacuous passes).
 */

import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles } from '../helpers/collect-files';

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_LAYER_DIR = path.join(REPO_ROOT, 'src/app-layer');

/**
 * The ag audit actions the observability epic introduced / renamed.
 * Each MUST appear as a quoted string literal in `src/app-layer`
 * (emitted via `logEvent({ action: '<X>' | … ? '<X>' : … })`).
 *
 * When you add a new ag audit event, add it here with the usecase that
 * emits it. When you intentionally retire one, remove it here in the
 * same diff (and update the dashboard / runbooks that reference it).
 */
const EXPECTED_AG_ACTIONS: ReadonlyArray<{ action: string; emittedBy: string }> = [
    { action: 'PARCEL_CREATED', emittedBy: 'usecases/parcel.ts (createParcel)' },
    { action: 'GEOMETRY_UPDATED', emittedBy: 'usecases/parcel.ts (updateParcel, reshape branch)' },
    { action: 'SPRAY_JOB_STARTED', emittedBy: 'usecases/field-operation.ts (createFieldOperation)' },
    { action: 'OPERATION_PARCEL_MARKED', emittedBy: 'usecases/field-operation.ts (markOperationParcel)' },
    { action: 'HARVEST_YIELD_RECORDED', emittedBy: 'usecases/yield-record.ts (createYieldRecord)' },
    { action: 'LEDGER_RECONCILIATION_RUN', emittedBy: 'usecases/inventory.ts (reconcileStockLedger)' },
];

/**
 * The critical ag usecases that must carry a trace span. The operation
 * name is load-bearing: the Prometheus recording rules + SLO alerts
 * (`infra/observability/prometheus/rules/*.yml`) query
 * `ag_operation_*{ag_operation="<op>"}` / `usecase.<op>` spans by this
 * exact string. Renaming the operation silently orphans those rules.
 */
const EXPECTED_AG_SPANS: ReadonlyArray<{ operation: string; file: string }> = [
    { operation: 'field-operation.markOperationParcel', file: 'usecases/field-operation.ts' },
    { operation: 'yield-record.createYieldRecord', file: 'usecases/yield-record.ts' },
    { operation: 'inventory.recordInputApplication', file: 'usecases/inventory.ts' },
    { operation: 'inventory.reconcileStockLedger', file: 'usecases/inventory.ts' },
    { operation: 'journal.createLogEntry', file: 'usecases/journal.ts' },
    { operation: 'crop-planning.generatePlantings', file: 'usecases/crop-planning.ts' },
];

/**
 * Measured 2026-10-30. A hand-rolled walk here can be gutted to `return []`
 * and every assertion built on it still passes, because they all look for a
 * MISSING entry — so an empty population reports full coverage having read
 * nothing. #865 measured that shape at 81% of the guards a sweep could audit.
 * `collectSourceFiles` refuses an empty result, which makes the guarantee
 * structural rather than inferred from a mutation (#2377).
 */
const APP_LAYER_TS_FLOOR = 300;

function listTsFiles(dir: string): string[] {
    return collectSourceFiles({
        roots: [dir],
        extensions: ['.ts'],
        exclude: (rel) => rel.endsWith('.d.ts'),
        floor: APP_LAYER_TS_FLOOR,
    });
}

function readAllAppLayerSources(): string {
    return listTsFiles(APP_LAYER_DIR)
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');
}

/** Match a quoted (single OR double) string literal for `value`. */
function quotedLiteralRe(value: string): RegExp {
    return new RegExp(`['"]${value}['"]`);
}

/** Match a trace-span wrapper opened on `operation`. */
function traceWrapperRe(operation: string): RegExp {
    // traceAgUsecase('<op>', …) | traceUsecase('<op>', …)
    return new RegExp(`trace(?:Ag)?Usecase\\(\\s*['"]${operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
}

describe('Ag observability — audit-event coverage guardrail', () => {
    const allSrc = readAllAppLayerSources();

    it('discovers a non-trivial app-layer source corpus (sanity)', () => {
        expect(allSrc.length).toBeGreaterThan(10_000);
    });

    test.each(EXPECTED_AG_ACTIONS.map((e) => [e.action, e.emittedBy] as const))(
        'ag audit action %s is emitted in src/app-layer',
        (action, emittedBy) => {
            if (!quotedLiteralRe(action).test(allSrc)) {
                throw new Error(
                    [
                        `Ag audit action no longer emitted: ${action}`,
                        ``,
                        `  Expected emitter: ${emittedBy}`,
                        ``,
                        `Why:`,
                        `  The feat/observability Grafana dashboard, Prometheus`,
                        `  rules, and per-tenant audit-stream consumers key on this`,
                        `  exact action string. A silent rename / removal orphans`,
                        `  all of them.`,
                        ``,
                        `Fix:`,
                        `  Either restore the emission (logEvent({ action: '${action}' })),`,
                        `  OR — if intentionally retired — remove it from`,
                        `  EXPECTED_AG_ACTIONS here AND update the dashboard +`,
                        `  runbooks that reference it, in the same PR.`,
                    ].join('\n'),
                );
            }
        },
    );
});

describe('Ag observability — trace-span coverage guardrail', () => {
    test.each(EXPECTED_AG_SPANS.map((e) => [e.operation, e.file] as const))(
        'critical ag usecase is traced under operation %s',
        (operation, file) => {
            const src = fs.readFileSync(path.join(APP_LAYER_DIR, file), 'utf8');
            if (!traceWrapperRe(operation).test(src)) {
                throw new Error(
                    [
                        `Critical ag usecase lost its trace span: ${operation}`,
                        ``,
                        `  Expected in: src/app-layer/${file}`,
                        ``,
                        `Why:`,
                        `  The Prometheus recording rules + SLO alerts query`,
                        `  ag_operation_*{ag_operation="${operation}"} (and the trace`,
                        `  view filters usecase.${operation}). Renaming or dropping`,
                        `  the wrapper orphans the dashboard panel + the alert.`,
                        ``,
                        `Fix:`,
                        `  Keep the usecase wrapped: traceAgUsecase('${operation}', ctx, …)`,
                        `  (or traceUsecase for the reconcile path). If the operation`,
                        `  is intentionally renamed, update EXPECTED_AG_SPANS here AND`,
                        `  the matching rules in`,
                        `  infra/observability/prometheus/rules/*.yml, same PR.`,
                    ].join('\n'),
                );
            }
        },
    );
});

// ─── Mutation regression proofs ───────────────────────────────────
//
// Confirm both detectors actually catch a silent break by mutating the
// source string in-memory and re-running the matcher against the broken
// variant. If a detector still passes on the broken variant, the
// guardrail is vacuous and these fail loud.

describe('Ag observability — mutation regression proofs', () => {
    it('renaming an ag audit action trips the audit detector', () => {
        const parcelSrc = fs.readFileSync(path.join(APP_LAYER_DIR, 'usecases/parcel.ts'), 'utf8');
        expect(quotedLiteralRe('PARCEL_CREATED').test(parcelSrc)).toBe(true);

        const broken = parcelSrc.replace(/'PARCEL_CREATED'/g, "'PARCEL_DRAWN'");
        expect(quotedLiteralRe('PARCEL_CREATED').test(broken)).toBe(false);
    });

    it('removing a trace wrapper trips the span detector', () => {
        const foSrc = fs.readFileSync(path.join(APP_LAYER_DIR, 'usecases/field-operation.ts'), 'utf8');
        expect(traceWrapperRe('field-operation.markOperationParcel').test(foSrc)).toBe(true);

        const broken = foSrc.replace(/traceAgUsecase\(/g, 'noopWrap(');
        expect(traceWrapperRe('field-operation.markOperationParcel').test(broken)).toBe(false);
    });
});

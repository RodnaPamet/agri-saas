/**
 * RLS-coverage skip visibility.
 *
 * `tests/guardrails/rls-coverage.test.ts` is the ratchet that makes it
 * impossible to add a tenant-scoped table without shipping RLS. It is
 * DB-backed by necessity — there is nothing to compare `pg_policies`
 * against without a live, migrated Postgres — and it therefore has to
 * be allowed to sit out a run that has no database.
 *
 * THE FAILURE MODE THAT MATTERS: a suite that sits out a run is
 * indistinguishable from a suite that passed it. Observed live — the
 * guardrail failed six assertions against a reachable-but-stale
 * database, then went completely silent when that database became
 * unreachable. The sweep got GREENER by running less. A skipped check
 * nobody is told about is a missing assertion, not a paused one.
 *
 * This guard is the structural half of the fix (the runtime half is
 * the always-running execution-status suite inside the guardrail
 * itself). It asserts the INVERSE of the defect, the same way
 * `tests/guards/tooltip-kill-switch-consistency.test.ts` does for the
 * tooltip kill-switch:
 *
 *   - The skip must stay DERIVED from the imported `DB_AVAILABLE`
 *     probe. A hard `describe.skip(` would never re-arm.
 *   - An UNGATED status suite must exist and must say, in words a
 *     reader will see, that RLS was not verified.
 *   - The escalation hatch (`RLS_GUARDRAIL_REQUIRE_DB=1`) must stay
 *     wired, so an environment that guarantees a database can make
 *     non-execution a red build.
 *   - The DB-backed assertions must all still be there. "Make the
 *     skip loud" must not become "delete what was being skipped".
 *
 * Pure text scan, like every other file in `tests/guards/` — it proves
 * the wiring is present in source, not that it behaves. The behaviour
 * is exercised by running the guardrail itself.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const RLS_SPEC = path.join(ROOT, 'tests/guardrails/rls-coverage.test.ts');

/** The gate, as it must appear in source. */
const DERIVED_GATE_RE =
    /const\s+describeFn\s*=\s*DB_AVAILABLE\s*\?\s*describe\s*:\s*describe\.skip\s*;/;

/**
 * A skip written at statement position — `describe.skip(...)`,
 * `it.skip(...)`, `test.skip(...)`. These do not re-arm: nothing ties
 * them to the availability probe, so they stay dead after the
 * condition that motivated them is gone. The ternary above is fine
 * precisely because it is not at statement position.
 */
const HARD_SKIP_RE = /^\s*(?:describe|test|it)\.skip\s*\(/m;

/** `.only` would silently mute every sibling assertion in the file. */
const FOCUSED_RE = /^\s*(?:describe|test|it)\.only\s*\(/m;

/**
 * Every assertion that only runs with a live database. Deleting one is
 * a real reduction in RLS coverage and must be a deliberate, reviewed
 * edit to this list — not a side effect of tidying the guardrail.
 */
const REQUIRED_DB_BACKED_ASSERTIONS: readonly string[] = [
    'every tenant-scoped model has a tenant_isolation policy',
    'every tenant-scoped model has a superuser_bypass policy',
    'every tenant-scoped model has FORCE ROW LEVEL SECURITY enabled',
    'tenant-scoped tables with direct tenantId also carry tenant_isolation_insert',
    'no tenant-scoped table carries the deprecated allow_all policy',
    'every org-scoped model has its named isolation policy',
    'every cross-tenant model has its named isolation policy + bypass + FORCE',
    'cross-tenant isolation is symmetric — USING and WITH CHECK both strict',
    'every org-scoped model has a superuser_bypass policy',
    'every org-scoped model has FORCE ROW LEVEL SECURITY enabled',
    'every org-scoped policy materialised by migration is reproducible from rls-setup.sql',
    'ORG_SCOPED_MODELS sanity: every named policy actually carries a USING clause',
];

/**
 * Assertions that need NO database and must therefore never be gated.
 * They read the Prisma DMMF only; parking them inside the DB-gated
 * block (where they used to live) meant they stopped running whenever
 * Postgres was down — the same passes-by-not-running defect, one layer
 * in.
 */
const ALWAYS_RUNNING_ASSERTIONS: readonly string[] = [
    'guardrail inventory size is in the expected range',
    'org-scoped and tenant-scoped sets are disjoint',
];

describe('RLS-coverage guardrail cannot skip silently', () => {
    const src = fs.readFileSync(RLS_SPEC, 'utf-8');

    it('gates the DB-backed suite on the imported DB_AVAILABLE probe', () => {
        expect(src).toMatch(
            /import\s*\{[^}]*\bDB_AVAILABLE\b[^}]*\}\s*from\s*'\.\.\/integration\/db-helper'/,
        );
        expect(src).toMatch(DERIVED_GATE_RE);
    });

    it('contains no hard skip and no focused test', () => {
        expect(HARD_SKIP_RE.test(src)).toBe(false);
        expect(FOCUSED_RE.test(src)).toBe(false);
    });

    it('carries an UNGATED execution-status suite', () => {
        // `describe(`, not `describeFn(` — it has to run in exactly the
        // case the rest of the file cannot.
        expect(src).toMatch(
            /^describe\('Guardrail: RLS coverage — execution status'/m,
        );
    });

    it('the status suite says out loud that RLS was not verified', () => {
        // The words are the signal. A reader scanning a green sweep must
        // be able to tell that this file proved nothing in that run.
        expect(src).toContain('NOT VERIFIED');
        expect(src).toMatch(/console\.warn\(/);
        // The suite name itself carries the verdict, so --verbose and
        // JSON reporters surface it without reading console output.
        expect(src).toMatch(/DID NOT RUN/);
    });

    it('keeps the RLS_GUARDRAIL_REQUIRE_DB escalation wired', () => {
        expect(src).toContain("process.env.RLS_GUARDRAIL_REQUIRE_DB === '1'");
        // …and the flag must actually do something — a throw, not a log.
        expect(src).toMatch(/if\s*\(RLS_REQUIRE_DB\)\s*\{[\s\S]{0,400}?throw new Error\(/);
    });

    it('still declares every DB-backed RLS assertion', () => {
        const missing = REQUIRED_DB_BACKED_ASSERTIONS.filter(
            (title) => !src.includes(title),
        );
        expect(missing).toEqual([]);
    });

    it('keeps the DB-free inventory assertions out of the gated block', () => {
        for (const title of ALWAYS_RUNNING_ASSERTIONS) {
            expect(src).toContain(title);
        }
        // Both live in the ungated inventory suite.
        const inventoryIdx = src.indexOf(
            "describe('Guardrail: RLS inventory (no database required)'",
        );
        const gateIdx = src.search(DERIVED_GATE_RE);
        expect(inventoryIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeGreaterThan(-1);
        for (const title of ALWAYS_RUNNING_ASSERTIONS) {
            const at = src.indexOf(title);
            expect(at).toBeGreaterThan(inventoryIdx);
            expect(at).toBeLessThan(gateIdx);
        }
    });

    it('mutation regression — both detectors fire on a known-bad input', () => {
        // Without this, a future "simplification" of either regex could
        // quietly stop matching while every assertion above still passes
        // vacuously against a clean file.

        // (a) the gate stops being derived from the probe
        const silenced = src.replace(
            DERIVED_GATE_RE,
            'const describeFn = describe.skip;',
        );
        expect(silenced).not.toBe(src); // sanity — the source had the gate
        expect(DERIVED_GATE_RE.test(silenced)).toBe(false);

        // (b) the suite is hard-skipped — the form that never re-arms
        const hardSkipped = src.replace(
            /^describeFn\(DB_SUITE_NAME,/m,
            'describe.skip(DB_SUITE_NAME,',
        );
        expect(hardSkipped).not.toBe(src); // sanity — the call site exists
        expect(HARD_SKIP_RE.test(hardSkipped)).toBe(true);
    });
});

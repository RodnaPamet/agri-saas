/**
 * Epic A.1 guardrail — RLS coverage must stay at 100%.
 *
 * This test is the ratchet that makes it impossible to silently add
 * a new tenant-scoped table without shipping a matching RLS
 * migration. Flow:
 *
 *   1. Compute the canonical tenant-scoped model set from
 *      `TENANT_SCOPED_MODELS` in `@/lib/db/rls-middleware` — that
 *      set itself is derived from the live Prisma DMMF, so any new
 *      `tenantId` column automatically enters the inventory.
 *   2. Query `pg_policies` against the live database and pg_tables
 *      for `forcerowsecurity = true`.
 *   3. Assert set equality:
 *        - Every tenant-scoped table has BOTH a `tenant_isolation`
 *          AND a `superuser_bypass` policy.
 *        - Every tenant-scoped table has `FORCE ROW LEVEL SECURITY`
 *          enabled.
 *
 * If a new model with `tenantId` lands in schema.prisma without a
 * matching RLS migration, this test fails with the exact model name
 * in the error message.
 *
 * This test REQUIRES the live Postgres with migrations applied. In
 * CI it runs against the migrated test DB; locally it runs against
 * the dev DB.
 *
 * ─── Why the skip is loud ────────────────────────────────────────
 *
 * Being DB-backed used to mean being SILENT. The gate was a bare
 * `const describeFn = DB_AVAILABLE ? describe : describe.skip`, so an
 * unreachable database was indistinguishable from a pass: the run got
 * *greener* the moment the DB went away (the assertions below stopped
 * executing, nothing said so, and the sweep still reported all-green).
 * A check that passes by not running reads as verified forever.
 *
 * Three things close that, none of which weaken an assertion:
 *
 *   1. `Guardrail: RLS coverage — execution status` ALWAYS runs. When
 *      no database is reachable it prints a banner stating in words
 *      that RLS is UNVERIFIED in this run. Jest attaches console
 *      output to the suite, so it lands in the output a reader is
 *      already scanning.
 *   2. Both the status test's name and the DB-backed suite's name
 *      carry the verdict (VERIFIED / NOT VERIFIED), so `--verbose`,
 *      JSON reporters and CI annotations surface it with no extra
 *      tooling.
 *   3. `RLS_GUARDRAIL_REQUIRE_DB=1` upgrades the banner to a hard
 *      failure — for any environment that guarantees a database and
 *      wants "did not run" to be a red build.
 *
 * It deliberately does NOT fail by default: CI provides the database
 * (the `test` job's postgres service in `.github/workflows/ci.yml`),
 * and a developer without a local Postgres must still be able to run
 * the guardrail sweep.
 *
 * The structural half of the contract — the skip must stay derived
 * from the imported probe and can never decay into a hard
 * `describe.skip(` — lives in
 * `tests/guards/rls-coverage-skip-visibility.test.ts`, modelled on
 * `tests/guards/tooltip-kill-switch-consistency.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { DB_AVAILABLE, DB_URL } from '../integration/db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { TENANT_SCOPED_MODELS } from '@/lib/db/rls-middleware';

// Epic O-1 — hub-and-spoke organization layer.
//
// `Organization` and `OrgMembership` are user-scoped, NOT tenant-
// scoped (no `tenantId` column on either). They live on a parallel
// RLS axis keyed on `app.user_id`:
//
//   * Organization                       → `org_isolation`
//                                          USING EXISTS(membership)
//   * OrgMembership                      → `org_membership_self_isolation`
//                                          USING (userId = current user)
//
// Both also carry the canonical `superuser_bypass` and
// `FORCE ROW LEVEL SECURITY` so the `postgres`-role privileged paths
// (org CRUD API, auto-provisioning, seeds, migrations) work
// unchanged. See migration 20260426060000_add_organization_layer_rls.
//
// Each entry maps the model name → the policy name we expect to
// find on its row in pg_policies. Using a Map (not a Set) so a
// future third org-scoped table can have its own policy name
// without needing yet another structural exception.
const ORG_SCOPED_MODELS: ReadonlyMap<string, string> = new Map([
    ['Organization', 'org_isolation'],
    ['OrgMembership', 'org_membership_self_isolation'],
]);

// Promotions #12 — `PromotionLead` is CROSS-TENANT on a third axis.
//
// It holds one tenant's contact PII but keys on `inquirerTenantId`, a plain
// FK that is deliberately NOT a `tenantId` RLS column. That is precisely why
// it needed listing here: this file's inventory keys off `tenantId`, so the
// table sat outside the ratchet while being readable by any tenant's session
// — the failure mode the ratchet exists to prevent.
//
// Single policy (not the split isolation/insert pair): `inquirerTenantId` is
// NOT NULL, so there is no nullable-row case needing a permissive USING, and
// both USING and WITH CHECK are the strict own-tenant predicate.
// See migration 20260721090000_promotion_lead_consent_rls.
// `ExchangeInquiry` is the same third axis, with two parties instead of one.
//
// It holds private buyer↔seller messages and keys on `inquirerTenantId` — the
// same plain-FK-not-a-tenantId shape as PromotionLead, and the same
// consequence: `grep -c "Exchange"` on this file returned 0, so the table sat
// outside the ratchet while migration 20260323180000 granted `app_user` full
// DML on every table. One forgotten `where` in a future repository method
// would have read every tenant's private messages with no DB-side backstop.
//
// Where PromotionLead belongs to ONE tenant, an inquiry legitimately has TWO
// parties — the inquirer who wrote it and the seller whose listing it targets
// — so the predicate is a disjunction with the seller side resolved through
// the listing. Still a SINGLE policy: `inquirerTenantId` is NOT NULL, so there
// is no nullable-row case, and per-command policies would be permissive
// siblings OR'd together (the Epic D.1 lesson).
// See migration 20260728120000_exchange_inquiry_rls.
const CROSS_TENANT_SCOPED_MODELS: ReadonlyMap<string, string> = new Map([
    ['PromotionLead', 'promotion_lead_inquirer_isolation'],
    ['ExchangeInquiry', 'exchange_inquiry_party_isolation'],
]);

// Models that are GLOBAL BY DESIGN — deliberately readable across every
// tenant, so the absence of RLS is a product decision rather than a gap.
//
// This list exists so the next reader finds a DECISION, not an omission. A
// model that simply has no `tenantId` is invisible to this file's inventory;
// without an explicit entry there is no way to tell "considered and exempted"
// from "nobody looked". Adding an entry requires a written reason.
const GLOBAL_BY_DESIGN_MODELS: ReadonlyMap<string, string> = new Map([
    [
        'ExchangeListing',
        'Cross-tenant readability IS the product — a marketplace whose offers ' +
            'only their author can see is not a marketplace. Listings carry no ' +
            'private data by construction: `description` and `sellerDisplayName` ' +
            'are sanitised public plaintext, and a tenant that wants anonymity ' +
            'omits the display name. Write safety is enforced at the usecase ' +
            'layer (ctx.tenantId === listing.sellerTenantId), and the PRIVATE ' +
            'half of the marketplace — ExchangeInquiry — is RLS-protected above.',
    ],
]);

// ═══════════════════════════════════════════════════════════════════
// Execution visibility — always runs, with or without a database.
// ═══════════════════════════════════════════════════════════════════

/**
 * Opt-in escalation. Any environment that GUARANTEES a migrated
 * Postgres (CI, a release gate, a pre-deploy smoke) can set
 * `RLS_GUARDRAIL_REQUIRE_DB=1` to turn "the RLS assertions did not
 * run" into a red build instead of a warning.
 */
const RLS_REQUIRE_DB = process.env.RLS_GUARDRAIL_REQUIRE_DB === '1';

/** Strip any credentials before the URL is written to the log. */
function redactDbUrl(url: string): string {
    return url.replace(/\/\/[^@/]*@/, '//***@');
}

const NOT_VERIFIED_BANNER = [
    '',
    '═══════════════════════════════════════════════════════════════════',
    '  RLS COVERAGE GUARDRAIL: NOT VERIFIED IN THIS RUN',
    '═══════════════════════════════════════════════════════════════════',
    '  No database was reachable, so every pg_policies assertion in',
    '  tests/guardrails/rls-coverage.test.ts was SKIPPED. Row-level',
    '  security coverage is UNKNOWN — a green result for this file does',
    '  NOT mean the tenant-scoped tables are protected.',
    '',
    `  Probed: ${redactDbUrl(DB_URL)}`,
    '',
    '  To actually verify RLS:',
    '    docker-compose up -d',
    '    npx prisma migrate deploy',
    '    npx jest tests/guardrails/rls-coverage.test.ts',
    '',
    '  To make non-execution a hard failure (environments that',
    '  guarantee a database):',
    '    RLS_GUARDRAIL_REQUIRE_DB=1 npx jest tests/guardrails/rls-coverage.test.ts',
    '═══════════════════════════════════════════════════════════════════',
    '',
].join('\n');

describe('Guardrail: RLS coverage — execution status', () => {
    test(
        DB_AVAILABLE
            ? 'database reachable — the DB-backed RLS assertions EXECUTED'
            : 'database UNREACHABLE — the DB-backed RLS assertions DID NOT RUN (RLS is NOT VERIFIED)',
        () => {
            // Sanity: the probe still resolves to something this gate can
            // read. If `DB_AVAILABLE` ever stops being a boolean, the gate
            // below starts making a truthiness decision instead of an
            // availability one — and the skip can go quiet again.
            expect(typeof DB_AVAILABLE).toBe('boolean');

            if (DB_AVAILABLE) return;

            if (RLS_REQUIRE_DB) {
                throw new Error(
                    NOT_VERIFIED_BANNER +
                        '\nRLS_GUARDRAIL_REQUIRE_DB=1 is set, so a run that could ' +
                        'not verify RLS is a failure rather than a warning.',
                );
            }

            // Not a failure — the suite is DB-backed by design and CI
            // supplies the database. The banner is the signal: it makes a
            // non-executing check visible to whoever is reading the run.
            console.warn(NOT_VERIFIED_BANNER);
        },
    );
});

// ═══════════════════════════════════════════════════════════════════
// Static inventory checks — no database required.
// ═══════════════════════════════════════════════════════════════════
//
// These two assertions read only `TENANT_SCOPED_MODELS` /
// `ORG_SCOPED_MODELS`, both resolved from the Prisma DMMF at import
// time. They sat inside the DB-gated block purely by proximity, which
// meant they stopped running whenever the database was unreachable —
// two more checks that "passed" by not executing. They belong here.

describe('Guardrail: RLS inventory (no database required)', () => {
    test('guardrail inventory size is in the expected range', () => {
        // Defence against the inventory collapsing to zero (e.g. if the
        // DMMF enumeration breaks or TENANT_SCOPED_MODELS becomes empty).
        // At the time of writing, the schema has 65 direct + 7 ownership-
        // chained = 72 tenant-scoped models. Allow for growth and
        // occasional deprecations by asserting a reasonable floor.
        expect(TENANT_SCOPED_MODELS.size).toBeGreaterThanOrEqual(60);
    });

    test('org-scoped and tenant-scoped sets are disjoint', () => {
        // Two different isolation axes — a model being on both lists
        // would mean its policies are keyed on both `app.tenant_id`
        // AND `app.user_id`, which Postgres OR's together permissively
        // and weakens the guarantee of either. If a future model
        // legitimately needs both axes, that's a deliberate hybrid
        // design and should land its own policy strategy + test.
        const overlap: string[] = [];
        for (const model of ORG_SCOPED_MODELS.keys()) {
            if (TENANT_SCOPED_MODELS.has(model)) {
                overlap.push(model);
            }
        }
        if (overlap.length > 0) {
            throw new Error(
                `Isolation-axis overlap — ${overlap.length} model(s) appear in ` +
                    `BOTH ORG_SCOPED_MODELS and TENANT_SCOPED_MODELS:\n  ` +
                    overlap.join('\n  ') +
                    `\n\nThis is almost certainly an accident — the two axes are ` +
                    `keyed on different session variables (app.user_id vs ` +
                    `app.tenant_id) and combining them via Postgres's permissive ` +
                    `OR weakens both. Pick one axis per model.`,
            );
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// DB-backed assertions — gated on the availability probe.
// ═══════════════════════════════════════════════════════════════════

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const DB_SUITE_NAME = DB_AVAILABLE
    ? 'Guardrail: RLS coverage (pg_policies ↔ schema) — VERIFIED against a live database'
    : 'Guardrail: RLS coverage (pg_policies ↔ schema) — NOT VERIFIED (no database reachable)';

describeFn(DB_SUITE_NAME, () => {
    let prisma: PrismaClient;
    let policies: Array<{
        tablename: string;
        policyname: string;
        cmd: string;
        // `qual` is the USING expression; `with_check` is the
        // WITH CHECK expression. Both come back as raw SQL strings or
        // null when the clause was omitted at CREATE POLICY time. We
        // lift them out of pg_catalog so the SINGLE_POLICY_EXCEPTIONS
        // sanity check can verify the asymmetric shape is real, not
        // just that the policy name exists.
        qual: string | null;
        with_check: string | null;
    }>;
    let forcedTables: Set<string>;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();

        policies = await prisma.$queryRawUnsafe<typeof policies>(`
            SELECT tablename, policyname, cmd, qual, with_check
            FROM pg_policies
            WHERE schemaname = 'public'
        `);

        const forced = await prisma.$queryRawUnsafe<
            Array<{ tablename: string }>
        >(`
            SELECT c.relname AS tablename
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relforcerowsecurity = true
        `);
        forcedTables = new Set(forced.map((r) => r.tablename));
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    function policiesFor(table: string): string[] {
        return policies
            .filter((p) => p.tablename === table)
            .map((p) => p.policyname);
    }

    test('every tenant-scoped model has a tenant_isolation policy', () => {
        const missing: string[] = [];
        for (const model of TENANT_SCOPED_MODELS) {
            const names = policiesFor(model);
            if (!names.includes('tenant_isolation')) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `RLS coverage gap — ${missing.length} tenant-scoped model(s) lack a ` +
                    `'tenant_isolation' policy. Ship a migration that adds ` +
                    `'CREATE POLICY tenant_isolation' for each:\n  ` +
                    missing.join('\n  ') +
                    `\n\nSee prisma/migrations/20260422180000_enable_rls_coverage/migration.sql ` +
                    `for the canonical policy shape.`
            );
        }
    });

    test('every tenant-scoped model has a superuser_bypass policy', () => {
        const missing: string[] = [];
        for (const model of TENANT_SCOPED_MODELS) {
            const names = policiesFor(model);
            if (!names.includes('superuser_bypass')) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `Superuser bypass gap — ${missing.length} tenant-scoped model(s) lack a ` +
                    `'superuser_bypass' policy. Without it, migrations and seeds ` +
                    `will be blocked by FORCE ROW LEVEL SECURITY. Ship a ` +
                    `migration adding:\n  ` +
                    missing.map((m) => `'${m}'`).join(', ') +
                    `\n\nCanonical: superuser_bypass USING (current_setting('role') != 'app_user')`
            );
        }
    });

    test('every tenant-scoped model has FORCE ROW LEVEL SECURITY enabled', () => {
        const missing: string[] = [];
        for (const model of TENANT_SCOPED_MODELS) {
            if (!forcedTables.has(model)) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `FORCE RLS gap — ${missing.length} tenant-scoped model(s) are not ` +
                    `FORCING ROW LEVEL SECURITY. Without FORCE, the table owner ` +
                    `(postgres) bypasses RLS policies unconditionally — which ` +
                    `defeats the superuser_bypass role-switching design. ` +
                    `Ship a migration adding:\n  ` +
                    missing.map((m) => `ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`).join('\n  ')
            );
        }
    });

    test('tenant-scoped tables with direct tenantId also carry tenant_isolation_insert', () => {
        // Class-A direct-scoped tables have a dedicated INSERT policy.
        // Class-E ownership-chained tables use a single permissive
        // policy with USING + WITH CHECK; they legitimately lack a
        // separate _insert policy. We only require it for tables that
        // also have a Prisma-level `tenantId` scalar.
        //
        // KNOWN EXCEPTIONS — tables that intentionally use the single-
        // policy form (USING + WITH CHECK on one policy). These tables
        // have asymmetric USING vs WITH CHECK semantics where a split
        // INSERT policy would leak via permissive-OR (see
        // prisma/migrations/20260422180000_enable_rls_coverage comments).
        const SINGLE_POLICY_EXCEPTIONS = new Set<string>([
            // Nullable tenantId — USING permissive on NULL, WITH CHECK strict.
            'IntegrationWebhookEvent',
            // Epic D.1 — `UserSession` follows the same nullable-tenant
            // pattern: USING (tenantId IS NULL OR own) lets the
            // operational sign-in flow read pre-resolution rows;
            // WITH CHECK (own) keeps writes strictly own-tenant.
            // A split tenant_isolation_insert FOR INSERT WITH CHECK
            // would be a permissive sibling that re-introduces the
            // cross-tenant UPDATE leak documented in the migration.
            'UserSession',
            // Native bearer auth — `NativeRefreshToken` hangs off
            // `UserSession` and inherits its nullable tenantId (a mint
            // can precede tenant resolution). Same asymmetric single
            // policy: USING (tenantId IS NULL OR own), WITH CHECK (own).
            // A split INSERT policy would let an app_user-bound session
            // re-point a LIVE refresh token at another tenant — the
            // permissive-OR leak, on a credential table.
            'NativeRefreshToken',
            // feat/ai-rag — `KnowledgeChunk` has a NULLABLE tenantId:
            // NULL = the GLOBAL licensed catalog (KCC / FAIR-Forward QA /
            // EU/USDA organic), readable by every tenant; non-null =
            // tenant-private RAG chunks. Same asymmetric single-policy
            // form as UserSession — USING (tenantId IS NULL OR own)
            // WITH CHECK (own). A split tenant_isolation_insert policy
            // would be a permissive sibling letting app_user re-tenant a
            // NULL GLOBAL row. See migration 20260619100000_ai_rag_pgvector.
            'KnowledgeChunk',
            // W5 (final task) — `KnowledgeArticle` / `KnowledgeArticleVersion`
            // gained NULLABLE tenantId: NULL = GLOBAL, platform-authored
            // content (e.g. the satellite-imagery guide), readable by every
            // tenant; non-null = tenant-private, unchanged. Same asymmetric
            // single-policy form as KnowledgeChunk/UserSession — a split
            // tenant_isolation_insert policy would let app_user re-tenant a
            // GLOBAL row. `KnowledgeAcknowledgement` is DELIBERATELY NOT
            // listed here — it stays NOT NULL tenantId on the canonical
            // split-policy pair (see migration
            // 20260809130000_knowledge_global_articles for why an
            // acknowledgement can never attach to a GLOBAL article).
            'KnowledgeArticle',
            'KnowledgeArticleVersion',
        ]);

        const { Prisma } = require('@prisma/client');
        const directScoped = new Set<string>(
            Prisma.dmmf.datamodel.models
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .filter((m: any) => m.fields.some((f: any) => f.name === 'tenantId'))
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((m: any) => m.name)
        );

        const missing: string[] = [];
        for (const model of directScoped) {
            if (SINGLE_POLICY_EXCEPTIONS.has(model)) continue;
            const names = policiesFor(model);
            if (!names.includes('tenant_isolation_insert')) {
                missing.push(model);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `INSERT-protection gap — ${missing.length} direct-tenantId model(s) ` +
                    `have no 'tenant_isolation_insert' FOR INSERT WITH CHECK policy. ` +
                    `Without it, a tenant running under app_user could insert a row ` +
                    `carrying another tenant's id. Ship a migration adding:\n  ` +
                    missing.join('\n  ') +
                    `\n\nIf this model legitimately uses the single-policy form ` +
                    `(USING + WITH CHECK on one policy, for asymmetric semantics), ` +
                    `add it to SINGLE_POLICY_EXCEPTIONS in this test.`
            );
        }

        // Sanity check — the exceptions list must still exist as
        // tenant-scoped tables AND each one's `tenant_isolation`
        // policy must actually carry BOTH a USING (qual) and a
        // WITH CHECK clause. That is the entire reason the table is
        // exempt from the split-policy rule; if a future migration
        // "simplifies" the policy back to USING-only or WITH CHECK-
        // only, the asymmetric-semantics guarantee evaporates and the
        // exception is no longer load-bearing.
        for (const exception of SINGLE_POLICY_EXCEPTIONS) {
            expect(TENANT_SCOPED_MODELS.has(exception)).toBe(true);

            const isolation = policies.find(
                (p) =>
                    p.tablename === exception &&
                    p.policyname === 'tenant_isolation',
            );
            expect(isolation).toBeDefined();
            if (!isolation) continue;

            // Both clauses must be non-null — that's what makes the
            // single-policy form safer than a permissive split.
            if (!isolation.qual || !isolation.with_check) {
                throw new Error(
                    `Single-policy exception '${exception}' lost its asymmetric ` +
                        `USING + WITH CHECK shape — qual=${JSON.stringify(isolation.qual)} ` +
                        `with_check=${JSON.stringify(isolation.with_check)}.\n\n` +
                        `Either restore the policy to the canonical form\n` +
                        `  CREATE POLICY tenant_isolation ON "${exception}"\n` +
                        `      USING (... permissive read filter ...)\n` +
                        `      WITH CHECK (... strict write filter ...);\n` +
                        `or remove '${exception}' from SINGLE_POLICY_EXCEPTIONS in ` +
                        `tests/guardrails/rls-coverage.test.ts and add the dedicated ` +
                        `tenant_isolation_insert policy via a new migration.`,
                );
            }
        }
    });

    test('no tenant-scoped table carries the deprecated allow_all policy', () => {
        // `allow_all` was the USING(true) WITH CHECK(true) stopgap for
        // ownership-chained tables before they got EXISTS policies. It's
        // zero isolation. The coverage migration dropped them; this test
        // stops them from sneaking back via a clumsy merge.
        const violators = policies.filter((p) => p.policyname === 'allow_all');
        if (violators.length > 0) {
            throw new Error(
                `allow_all policies detected — these provide ZERO tenant ` +
                    `isolation and must be replaced with EXISTS-based policies:\n  ` +
                    violators.map((p) => `${p.tablename}.${p.policyname}`).join('\n  ')
            );
        }
    });

    // ─── Epic O-1 — organization-layer RLS ─────────────────────────

    test('every org-scoped model has its named isolation policy', () => {
        const missing: Array<{ model: string; policy: string }> = [];
        for (const [model, expectedPolicy] of ORG_SCOPED_MODELS) {
            const names = policiesFor(model);
            if (!names.includes(expectedPolicy)) {
                missing.push({ model, policy: expectedPolicy });
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Org-layer RLS gap — ${missing.length} org-scoped model(s) lack ` +
                    `their isolation policy. Ship/restore the relevant CREATE ` +
                    `POLICY in prisma/migrations/20260426060000_add_organization_layer_rls:\n  ` +
                    missing
                        .map((m) => `${m.model} → policy '${m.policy}'`)
                        .join('\n  '),
            );
        }
    });

    test('every cross-tenant model has its named isolation policy + bypass + FORCE', () => {
        // The three properties together are what make the table safe; asserting
        // only the policy name would pass a table whose RLS was never ENABLEd.
        const problems: string[] = [];
        for (const [model, expectedPolicy] of CROSS_TENANT_SCOPED_MODELS) {
            const names = policiesFor(model);
            if (!names.includes(expectedPolicy)) {
                problems.push(`${model} → missing policy '${expectedPolicy}'`);
            }
            if (!names.includes('superuser_bypass')) {
                problems.push(`${model} → missing 'superuser_bypass'`);
            }
            if (!forcedTables.has(model)) {
                problems.push(`${model} → FORCE ROW LEVEL SECURITY not enabled`);
            }
        }
        if (problems.length > 0) {
            throw new Error(
                `Cross-tenant RLS gap — a table holding one tenant's PII on a ` +
                    `non-tenantId axis is unprotected. Restore the relevant ` +
                    `statements in prisma/migrations/` +
                    `20260721090000_promotion_lead_consent_rls:\n  ` +
                    problems.join('\n  '),
            );
        }
    });

    test('global-by-design models are exempt on purpose, and still exempt', () => {
        // Two directions, both load-bearing.
        //
        // A written reason, because an entry without one is indistinguishable
        // from an omission — which is the whole failure this list exists to
        // prevent.
        //
        // And a check that the exemption is still TRUE: if someone later adds
        // RLS to one of these, the entry is stale and saying "global by
        // design" about a protected table misleads the next reader in the
        // opposite direction. Delete the entry in the same diff.
        const problems: string[] = [];
        for (const [model, reason] of GLOBAL_BY_DESIGN_MODELS) {
            if (!reason || reason.trim().length < 40) {
                problems.push(`${model} → exemption needs a written reason`);
            }
            const names = policiesFor(model).filter((n) => n !== 'superuser_bypass');
            if (names.length > 0) {
                problems.push(
                    `${model} → listed as global-by-design but now carries ` +
                        `policies [${names.join(', ')}] — the exemption is stale, remove it`,
                );
            }
            if (CROSS_TENANT_SCOPED_MODELS.has(model)) {
                problems.push(`${model} → cannot be both global-by-design and cross-tenant scoped`);
            }
        }
        if (problems.length > 0) {
            throw new Error(`Global-by-design exemption drift:\n  ${problems.join('\n  ')}`);
        }
    });

    test('cross-tenant isolation is symmetric — USING and WITH CHECK both strict', () => {
        // `inquirerTenantId` is NOT NULL, so unlike the nullable-tenantId
        // exceptions above there is no permissive-read case. A policy with a
        // USING clause but no WITH CHECK would let a session write a row
        // belonging to another tenant.
        for (const [model] of CROSS_TENANT_SCOPED_MODELS) {
            const row = policies.find(
                (p) => p.tablename === model && p.policyname !== 'superuser_bypass',
            );
            expect(row).toBeDefined();
            expect(row!.qual).toBeTruthy();
            expect(row!.with_check).toBeTruthy();
            expect(row!.qual).toContain('inquirerTenantId');
            expect(row!.with_check).toContain('inquirerTenantId');
        }
    });

    test('every org-scoped model has a superuser_bypass policy', () => {
        const missing: string[] = [];
        for (const model of ORG_SCOPED_MODELS.keys()) {
            const names = policiesFor(model);
            if (!names.includes('superuser_bypass')) {
                missing.push(model);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Org-layer superuser_bypass gap — ${missing.length} model(s) lack ` +
                    `'superuser_bypass'. Without it, the org-create API, auto-` +
                    `provisioning service, seeds, and migrations are blocked by ` +
                    `FORCE ROW LEVEL SECURITY. Add to each:\n  ` +
                    missing.map((m) => `'${m}'`).join(', ') +
                    `\n\nCanonical: superuser_bypass USING (current_setting('role') != 'app_user')`,
            );
        }
    });

    test('every org-scoped model has FORCE ROW LEVEL SECURITY enabled', () => {
        const missing: string[] = [];
        for (const model of ORG_SCOPED_MODELS.keys()) {
            if (!forcedTables.has(model)) {
                missing.push(model);
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Org-layer FORCE RLS gap — ${missing.length} org-scoped table(s) ` +
                    `aren't FORCING RLS. Without FORCE, the table owner ` +
                    `(postgres) bypasses RLS unconditionally and the bypass-by-` +
                    `role design collapses. Ship:\n  ` +
                    missing
                        .map((m) => `ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`)
                        .join('\n  '),
            );
        }
    });

    test('every org-scoped policy materialised by migration is reproducible from rls-setup.sql', () => {
        // Live-DB cross-check that complements the static-file ratchet
        // below. If pg_policies says the org policy exists but rls-
        // setup.sql doesn't define it, an operator reset (apply
        // migrations + replay rls-setup.sql) ends up in a divergent
        // state from a migration-only reset. Both paths must converge.
        const setupSqlPath = path.resolve(
            __dirname,
            '..',
            '..',
            'prisma',
            'rls-setup.sql',
        );
        const setup = fs.readFileSync(setupSqlPath, 'utf-8');

        const drifted: Array<{ model: string; policy: string }> = [];
        for (const [model, expectedPolicy] of ORG_SCOPED_MODELS) {
            const inDb = policies.some(
                (p) =>
                    p.tablename === model && p.policyname === expectedPolicy,
            );
            const re = new RegExp(
                `CREATE\\s+POLICY\\s+${expectedPolicy}\\s+ON\\s+"${model}"`,
                'i',
            );
            const inSetup = re.test(setup);
            // Drift is "DB has it but the canonical replay file doesn't"
            // — the dangerous direction. A setup-only definition that
            // never made it into a migration is caught by the prior
            // missing-policy test.
            if (inDb && !inSetup) {
                drifted.push({ model, policy: expectedPolicy });
            }
        }
        if (drifted.length > 0) {
            throw new Error(
                `Canonical replay drift — ${drifted.length} org-layer ` +
                    `policy(ies) exist in pg_policies but are NOT defined in ` +
                    `prisma/rls-setup.sql:\n  ` +
                    drifted
                        .map(
                            (d) =>
                                `${d.model}.${d.policy} → add CREATE POLICY ${d.policy} ON "${d.model}" to section 4b of prisma/rls-setup.sql`,
                        )
                        .join('\n  ') +
                    `\n\nWhy this matters: an operator who runs ` +
                    `prisma/rls-setup.sql against a fresh schema (or against ` +
                    `a partially-reset DB during repair) ends up without ` +
                    `these policies. The migration applies them on ` +
                    `'migrate reset', but rls-setup.sql is also a canonical ` +
                    `replay tool — both paths must produce the same end state.`,
            );
        }
    });

    test('ORG_SCOPED_MODELS sanity: every named policy actually carries a USING clause', () => {
        // Defence-in-depth — if a "simplification" PR drops the USING
        // clause from an org-isolation policy and replaces it with
        // USING(true), the named-policy presence assertion above still
        // passes but the isolation property is gone. Assert non-null
        // qual on every named org policy so that path is closed.
        const broken: Array<{ model: string; policy: string }> = [];
        for (const [model, expectedPolicy] of ORG_SCOPED_MODELS) {
            const row = policies.find(
                (p) => p.tablename === model && p.policyname === expectedPolicy,
            );
            if (!row) continue; // missing-policy is caught by the prior test
            if (!row.qual || row.qual.trim() === 'true') {
                broken.push({ model, policy: expectedPolicy });
            }
        }
        if (broken.length > 0) {
            throw new Error(
                `Org-layer USING-clause gap — ${broken.length} policy(ies) lost ` +
                    `their isolation predicate (USING null or true):\n  ` +
                    broken
                        .map((b) => `${b.model}.${b.policy}`)
                        .join('\n  ') +
                    `\n\nRestore the canonical EXISTS / userId predicate from ` +
                    `prisma/migrations/20260426060000_add_organization_layer_rls.`,
            );
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// Static-file ratchet — runs without a live DB.
// ═══════════════════════════════════════════════════════════════════
//
// Closes the loophole the DB-backed tests above leave open: a
// developer can run all the migrations against a long-lived dev DB,
// silently delete a CREATE POLICY from prisma/rls-setup.sql, and
// every DB-backed assertion still passes (because pg_policies still
// has the row from the earlier migration apply). The drift only
// surfaces the next time someone bootstraps a fresh environment.
//
// Two surfaces protected (both pure file scans, no Postgres required):
//   1. prisma/rls-setup.sql                  — canonical replay/repair tool
//   2. prisma/migrations/**/migration.sql    — canonical apply path used
//                                              by `prisma migrate reset`
//
// Scope intentionally narrowed to the Epic O-1 organization layer
// (the regression class this guardrail was strengthened to catch).
// Tenant-layer drift between rls-setup.sql and the per-feature
// migrations is a known, separate housekeeping item — see follow-up
// in docs/implementation-notes (rls-setup.sql is no longer wired into
// any script; the migrations are the load-bearing apply path).

interface PolicyExpectation {
    model: string;
    policy: string;
}

function readAllMigrationSql(): string {
    const root = path.resolve(__dirname, '..', '..', 'prisma', 'migrations');
    const out: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sql = path.join(root, entry.name, 'migration.sql');
        if (fs.existsSync(sql)) out.push(fs.readFileSync(sql, 'utf-8'));
    }
    return out.join('\n');
}

function hasCreatePolicy(haystack: string, expected: PolicyExpectation): boolean {
    const re = new RegExp(
        `CREATE\\s+POLICY\\s+${expected.policy}\\s+ON\\s+"${expected.model}"`,
        'i',
    );
    return re.test(haystack);
}

function hasForceRls(haystack: string, model: string): boolean {
    const re = new RegExp(
        `ALTER\\s+TABLE\\s+"${model}"\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
        'i',
    );
    return re.test(haystack);
}

describe('Guardrail: org-layer canonical RLS setup is drift-free', () => {
    const setupPath = path.resolve(
        __dirname,
        '..',
        '..',
        'prisma',
        'rls-setup.sql',
    );

    let setupSql: string;
    let migrationsSql: string;

    beforeAll(() => {
        setupSql = fs.readFileSync(setupPath, 'utf-8');
        migrationsSql = readAllMigrationSql();
    });

    test('every ORG_SCOPED_MODELS entry has a CREATE POLICY in prisma/rls-setup.sql', () => {
        const missing: PolicyExpectation[] = [];
        for (const [model, policy] of ORG_SCOPED_MODELS) {
            if (!hasCreatePolicy(setupSql, { model, policy })) {
                missing.push({ model, policy });
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Canonical setup gap — ${missing.length} org-layer policy ` +
                    `definition(s) missing from prisma/rls-setup.sql:\n  ` +
                    missing
                        .map(
                            (m) =>
                                `CREATE POLICY ${m.policy} ON "${m.model}"`,
                        )
                        .join('\n  ') +
                    `\n\nFix: add the missing CREATE POLICY block(s) to ` +
                    `prisma/rls-setup.sql section 4b ("Organization layer ` +
                    `— user-scoped"). Mirror the canonical migration ` +
                    `20260426060000_add_organization_layer_rls verbatim and ` +
                    `keep the DROP POLICY IF EXISTS guard so the script ` +
                    `stays idempotent.\n\n` +
                    `Why this matters: prisma/rls-setup.sql is the canonical ` +
                    `replay/repair tool. An operator who applies it against ` +
                    `a non-migrated DB must end up with the same RLS state ` +
                    `as 'prisma migrate reset'. Both paths must converge.`,
            );
        }
    });

    test('every ORG_SCOPED_MODELS table is set to FORCE ROW LEVEL SECURITY in prisma/rls-setup.sql', () => {
        const missing: string[] = [];
        for (const model of ORG_SCOPED_MODELS.keys()) {
            if (!hasForceRls(setupSql, model)) missing.push(model);
        }
        if (missing.length > 0) {
            throw new Error(
                `Canonical setup gap — ${missing.length} org-layer table(s) ` +
                    `not set to FORCE ROW LEVEL SECURITY in prisma/rls-setup.sql:\n  ` +
                    missing
                        .map(
                            (m) =>
                                `ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`,
                        )
                        .join('\n  ') +
                    `\n\nWithout FORCE, the postgres role bypasses RLS ` +
                    `unconditionally and the bypass-by-role design (which ` +
                    `relies on FORCE + a superuser_bypass policy keyed on ` +
                    `current_setting('role')) collapses.`,
            );
        }
    });

    test('every ORG_SCOPED_MODELS policy is also created by at least one migration', () => {
        // Reproducibility check — `prisma migrate reset` applies only
        // migrations, never rls-setup.sql. A canonical policy that
        // exists ONLY in rls-setup.sql vanishes on every fresh reset
        // until somebody runs the setup script by hand.
        const missing: PolicyExpectation[] = [];
        for (const [model, policy] of ORG_SCOPED_MODELS) {
            if (!hasCreatePolicy(migrationsSql, { model, policy })) {
                missing.push({ model, policy });
            }
        }
        if (missing.length > 0) {
            throw new Error(
                `Reset-path gap — ${missing.length} org-layer policy(ies) ` +
                    `defined in prisma/rls-setup.sql but missing from every ` +
                    `migration in prisma/migrations:\n  ` +
                    missing
                        .map(
                            (m) =>
                                `CREATE POLICY ${m.policy} ON "${m.model}"`,
                        )
                        .join('\n  ') +
                    `\n\nA canonical policy only in rls-setup.sql is invisible ` +
                    `to 'prisma migrate reset' and to any environment that ` +
                    `bootstraps from migrations alone. Ship a migration that ` +
                    `creates each missing policy.`,
            );
        }
    });

    test('mutation regression — removing org_isolation from rls-setup.sql is detected', () => {
        // Proves the static-file detector actually works on a known-bad
        // input. Without this, a future "simplification" of the regex
        // could quietly break detection while every assertion above
        // still passes vacuously against a clean repo.
        const removed = setupSql.replace(
            /CREATE\s+POLICY\s+org_isolation\s+ON\s+"Organization"[\s\S]*?\);/i,
            '-- removed for regression test',
        );
        expect(removed).not.toBe(setupSql); // sanity — the source had it
        expect(
            hasCreatePolicy(removed, {
                model: 'Organization',
                policy: 'org_isolation',
            }),
        ).toBe(false);
    });
});

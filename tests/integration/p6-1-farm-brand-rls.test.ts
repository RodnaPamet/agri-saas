/**
 * P6.1 — `FarmBrand` is isolated, and its handle namespace is NOT (#1810).
 *
 * The phase's standing rule is that every new model is classified in
 * rls-coverage and **proven** by an integration test under `app_user` with
 * negative controls. This is that proof for the one new model with RLS.
 *
 * The other two ship without policies, and their absence is argued in the
 * classification rather than here: `PublicFarmProfile` is global by design
 * (cross-tenant readability is the product, and the table has no PII columns
 * for a writer to leak into), and `PersonProfile` has no reader of any kind
 * yet, which is the `User` / `Tenant` situation. A test asserting isolation on
 * a table nothing reads would be a control that cannot express failure.
 *
 * ## The two halves, and why the second one is the interesting one
 *
 * **Rows are invisible across tenants.** Standard, and asserted with the own-
 * tenant read beside it so a zero is isolation rather than a fixture that
 * never landed.
 *
 * **The handle namespace is GLOBAL anyway.** Owner ruling 2026-10-14: a handle
 * is a separate public identifier, and `FarmBrand.handle` is `@unique` across
 * every tenant. So tenant B taking a handle tenant A already holds must fail
 * — even though B cannot SEE A's row. A unique index operates below RLS, and
 * that is load-bearing rather than incidental: without it two farms could hold
 * the same handle, each invisible to the other, and `/f/[handle]` would have
 * two answers. P6.7 prints handles onto A6 paper and into QR codes.
 *
 * It also means handle availability is observable through the constraint —
 * a taken handle fails with 23505 regardless of RLS. That is how every
 * username system behaves and is intended: the constraint answers "reserved"
 * and says nothing about `published`.
 *
 * ## A refusal is not evidence of a correct refusal
 *
 * Lifted from `farm-identity-claim-unique.test.ts`, which measured it: with
 * BOTH `tenant_isolation` and `tenant_isolation_insert` dropped, its
 * foreign-attribution case still passed — FORCE RLS was on, the only surviving
 * policy was `superuser_bypass`, false for `app_user`, so every access was
 * denied and the insert was refused for a reason unrelated to attribution.
 *
 * So every refusal case here is paired with a positive control that fails
 * under total denial. Do not delete one to save a round trip.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { withTenantDb } from '@/lib/db-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });

/**
 * `INTEGRATION_REQUIRE_DB=1` turns a skipped run RED.
 *
 * Without it a suite that sits out a run is indistinguishable from one that
 * passed it — the failure mode `tests/guards/rls-coverage-skip-visibility.test.ts`
 * exists for, recorded there as "the sweep got GREENER by running less".
 */
const REQUIRE_DB = process.env.INTEGRATION_REQUIRE_DB === '1';
if (REQUIRE_DB && !DB_AVAILABLE) {
    throw new Error(
        'INTEGRATION_REQUIRE_DB=1 but no database is reachable. This suite is the ' +
            'RLS proof for FarmBrand; skipping it silently would report a pass for a ' +
            'control that never ran.',
    );
}
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * A FRESH tenant pair per test, not a shared one.
 *
 * `FarmBrand.tenantId` is `@unique` — one brand per farm — so a shared pair
 * gives each tenant exactly ONE brand for the whole suite, and the second test
 * to seed hits `FarmBrand_tenantId_key`. Measured: my first version did, and
 * the positive control failed for that reason rather than for anything about
 * RLS. Worse, the handle-namespace case went on passing, because
 * `/Unique constraint/` matches the tenantId collision just as well as the
 * handle one — a green test proving nothing about the namespace it names.
 */
const createdTenantIds: string[] = [];
const createdBrandIds: string[] = [];

async function freshTenant(label: string): Promise<string> {
    const id = `fb-${label}-${randomUUID().slice(0, 8)}`;
    createdTenantIds.push(id);
    await globalPrisma.tenant.create({ data: { id, name: `FarmBrand ${label}`, slug: id } });
    return id;
}

/**
 * The constraint NAME, not just "some unique violation".
 *
 * `FarmBrand` has two unique indexes — `FarmBrand_handle_key` and
 * `FarmBrand_tenantId_key` — so a test asserting only `/Unique constraint/`
 * cannot say which one fired, and the two mean opposite things here.
 */
function expectUniqueViolation(err: unknown, constraint: string): void {
    const msg = String((err as Error)?.message ?? err);
    expect(msg).toMatch(/Unique constraint|23505/i);
    expect(msg).toContain(constraint);
}

/** A handle nobody else in this run will take. */
const aHandle = (): string => `farm-${randomUUID().slice(0, 12)}`;

describeFn('FarmBrand — tenant isolation, and a global handle namespace', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        // REAL Tenant rows: writes through `withTenantDb` go via the app's
        // extended client, so the audit middleware runs and `AuditLog.tenantId`
        // is a foreign key. Without a Tenant row the audit write fails with
        // 23503 and is swallowed as a logged error — the assertions would still
        // pass while reporting on a path whose audit leg never ran. Same
        // reasoning as `farm-identity-claim-unique.test.ts`.
    });

    afterAll(async () => {
        // Through the global client, which bypasses RLS — a cleanup running as
        // `app_user` would delete zero rows and report success, because under
        // RLS a DELETE removes nothing silently when SELECT hides the row.
        if (createdBrandIds.length > 0) {
            await globalPrisma.farmBrand.deleteMany({ where: { id: { in: createdBrandIds } } });
        }
        // The Tenant rows STAY, and they have to:
        //
        //   audit_log_immutable      BEFORE DELETE OR UPDATE ON "AuditLog"
        //   AuditLog_tenantId_fkey   ... ON DELETE RESTRICT
        //
        // The audit log is immutable by trigger, so the rows these cases wrote
        // through the audited client cannot be removed, and RESTRICT then
        // forbids deleting the tenant they point at. Any suite that writes
        // through `withTenantDb` is therefore unable to delete its own
        // tenants — by design. `farm-identity-claim-unique.test.ts` and
        // `ai-usage-event-rls.test.ts` leave theirs for the same reason.
        //
        // The ids are per-run UUID fragments, so nothing collides across runs.
        // Measured: my first version tried to delete them and the suite failed
        // in `afterAll` with every case passing — which is the shape worth
        // noting, because a green test list with a red suite is easy to read
        // as a flake.
        void createdTenantIds;
        await globalPrisma.$disconnect();
    });

    async function seedBrand(tenantId: string, handle: string): Promise<string> {
        const id = `fb-${randomUUID()}`;
        createdBrandIds.push(id);
        await globalPrisma.farmBrand.create({
            data: { id, tenantId, handle, displayName: 'Стопанство', published: false },
        });
        return id;
    }

    it('an outsider reads ZERO rows, and the owner reads its own', async () => {
        const TENANT_A = await freshTenant('a');
        const TENANT_B = await freshTenant('b');
        const handle = aHandle();
        await seedBrand(TENANT_A, handle);

        const seenByB = await withTenantDb(TENANT_B, (tx) =>
            tx.farmBrand.findMany({ where: { handle }, select: { id: true } }),
        );
        expect(seenByB).toHaveLength(0);

        // The positive half: without it, a fixture that never landed produces
        // the same zero above.
        const seenByA = await withTenantDb(TENANT_A, (tx) =>
            tx.farmBrand.findMany({ where: { handle }, select: { id: true } }),
        );
        expect(seenByA).toHaveLength(1);
    });

    it('app_user cannot create a brand attributed to another farm', async () => {
        const TENANT_A = await freshTenant('a');
        const TENANT_B = await freshTenant('b');
        // NO TEETH ALONE — see the docblock. The next case is the control.
        await expect(
            withTenantDb(TENANT_A, (tx) =>
                tx.farmBrand.create({
                    data: {
                        id: `fb-evil-${randomUUID()}`,
                        tenantId: TENANT_B,
                        handle: aHandle(),
                        displayName: 'Чуждо стопанство',
                    },
                }),
            ),
        ).rejects.toThrow(/42501|row-level security/i);
    });

    it('app_user CAN create its own, so the refusal is about attribution', async () => {
        const TENANT_A = await freshTenant('a');
        // The control that fails under total denial, which is what makes the
        // case above mean something.
        const id = `fb-own-${randomUUID()}`;
        createdBrandIds.push(id);

        await withTenantDb(TENANT_A, (tx) =>
            tx.farmBrand.create({
                data: { id, tenantId: TENANT_A, handle: aHandle(), displayName: 'Мое стопанство' },
            }),
        );

        const row = await globalPrisma.farmBrand.findUnique({ where: { id } });
        expect(row?.tenantId).toBe(TENANT_A);
    });

    it('the handle namespace is GLOBAL — a taken handle is refused across tenants', async () => {
        // The ruling made concrete. B cannot see A's row and must still not be
        // able to take its handle: a unique index operates below RLS. Without
        // this, two farms could hold one handle, invisible to each other, and
        // `/f/[handle]` would have two answers.
        const TENANT_A = await freshTenant('a');
        const TENANT_B = await freshTenant('b');
        const handle = aHandle();
        await seedBrand(TENANT_A, handle);

        // B has NO brand of its own yet, so a `FarmBrand_tenantId_key`
        // violation cannot be what fires here — and the constraint name is
        // asserted so the two cannot be confused.
        const err = await withTenantDb(TENANT_B, (tx) =>
            tx.farmBrand.create({
                data: {
                    id: `fb-dup-${randomUUID()}`,
                    tenantId: TENANT_B,
                    handle,
                    displayName: 'Друго стопанство',
                },
            }),
        ).catch((e: unknown) => e);
        expectUniqueViolation(err, 'FarmBrand_handle_key');

        // And B CAN take a different handle, so the refusal is about the
        // collision rather than about B being unable to write at all.
        const freeId = `fb-free-${randomUUID()}`;
        createdBrandIds.push(freeId);
        await withTenantDb(TENANT_B, (tx) =>
            tx.farmBrand.create({
                data: {
                    id: freeId,
                    tenantId: TENANT_B,
                    handle: aHandle(),
                    displayName: 'Свободно име',
                },
            }),
        );
        const free = await globalPrisma.farmBrand.findUnique({ where: { id: freeId } });
        expect(free?.tenantId).toBe(TENANT_B);
    });

    it('one brand per farm — a second insert for the same tenant is refused', async () => {
        const TENANT_B = await freshTenant('b');
        await seedBrand(TENANT_B, aHandle());

        // A FRESH handle, so the refusal can only be the tenantId constraint.
        // The name is asserted for the same reason as above: these two cases
        // are each other's confound.
        const err = await withTenantDb(TENANT_B, (tx) =>
            tx.farmBrand.create({
                data: {
                    id: `fb-second-${randomUUID()}`,
                    tenantId: TENANT_B,
                    handle: aHandle(),
                    displayName: 'Второ стопанство',
                },
            }),
        ).catch((e: unknown) => e);
        expectUniqueViolation(err, 'FarmBrand_tenantId_key');
    });
});

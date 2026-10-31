/**
 * «Документи» step 1: the tables isolate, and the CHECKs refuse (#2495).
 *
 * Executed against a real database as `app_user`, because that is the only
 * thing a policy can be proved against. A guard asserting the migration's SQL
 * text would pass on a policy that was never applied, and a Prisma-level test
 * would be filtering by `tenantId` in the ORM — proving the WHERE clause, not
 * the isolation.
 *
 * ## Every positive asserts a NON-ZERO count
 *
 * `p5-1-trust-safety-rls.test.ts` records why, and it applies here verbatim: a
 * refused SELECT is not an error, it is an empty result. "This tenant sees no
 * more than its own" passes on a view that is empty for an unrelated reason —
 * an unset session variable, a wrong database, a failed fixture — so each
 * positive has to show the row IS visible to its owner before the zero means
 * anything.
 *
 * ## Fixtures, unlike its sibling
 *
 * That suite needed none: its tables carry person columns as plain strings
 * with no FK. `FarmDocument` has three real FKs — tenant, fileRecord,
 * uploadedBy — so a row cannot be conjured, and the fixtures are part of what
 * is being tested: a document that cannot reference a FileRecord would be a
 * schema defect this test would catch.
 */
import { randomUUID } from 'crypto';

import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';

import { prismaTestClient } from '../helpers/db';
import { DB_AVAILABLE } from './db-helper';

/**
 * `prismaTestClient()`, not a bare `new PrismaClient`.
 *
 * `User.emailHash` is declared OPTIONAL at the schema and TS level — the
 * schema's own comment says so — because the PII middleware populates it from
 * `email` on every write. The DB column is NOT NULL. So a raw client cannot
 * insert a User at all: Prisma accepts the call, Postgres rejects the row, and
 * the error names a constraint rather than the missing middleware. This client
 * carries the extension, which is also what production writes through.
 */
const globalPrisma = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const run = `fd-${randomUUID().slice(0, 8)}`;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `req-${randomUUID()}`,
        tenantId,
        userId,
        role: 'ADMIN',
        permissions: [],
        appPermissions: {},
    } as unknown as RequestContext;
}

/** Rows VISIBLE to this tenant, via raw SQL so the ORM cannot do the filtering. */
async function visibleCount(tenantId: string, userId: string, table: string): Promise<number> {
    return runInTenantContext(ctxFor(tenantId, userId), async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "${table}"`,
        );
        return Number(rows[0].n);
    });
}

describeFn('FarmDocument — tenant isolation, against a live database', () => {
    let tenantA: string;
    let tenantB: string;
    let userId: string;
    let docA: string;

    beforeAll(async () => {
        const a = await globalPrisma.tenant.create({
            data: { name: `A ${run}`, slug: `a-${run}` } as never,
        });
        const b = await globalPrisma.tenant.create({
            data: { name: `B ${run}`, slug: `b-${run}` } as never,
        });
        const u = await globalPrisma.user.create({
            data: { email: `u-${run}@example.test`, name: `U ${run}` } as never,
        });
        tenantA = a.id;
        tenantB = b.id;
        userId = u.id;

        const fr = await globalPrisma.fileRecord.create({
            data: {
                tenantId: tenantA,
                pathKey: `tenants/${tenantA}/general/2026/10/${randomUUID()}.pdf`,
                originalName: 'lease.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 1024,
                sha256: randomUUID().replace(/-/g, ''),
                uploadedByUserId: userId,
            } as never,
        });

        const doc = await globalPrisma.farmDocument.create({
            data: {
                tenantId: tenantA,
                name: 'Договор аренда',
                fileRecordId: fr.id,
                uploadedByUserId: userId,
                retention: 'P1Y',
                expiresOn: '2027-10-30',
            } as never,
        });
        docA = doc.id;
    });

    afterAll(async () => {
        // Guarded: if beforeAll threw, these ids are undefined and an
        // unguarded `in: [undefined]` fails as a validation error that masks
        // the real cause — which is exactly how this suite first reported.
        if (!tenantA || !tenantB) return;
        await globalPrisma.farmDocument.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
        await globalPrisma.fileRecord.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
        await globalPrisma.tenantDocumentSettings.deleteMany({
            where: { tenantId: { in: [tenantA, tenantB] } },
        });
        await globalPrisma.tenantMembership.deleteMany({
            where: { tenantId: { in: [tenantA, tenantB] } },
        });
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
        await globalPrisma.user.deleteMany({ where: { id: userId } });
    });

    it('enters app_user — without which every assertion here is inert', async () => {
        const role = await runInTenantContext(ctxFor(tenantA, userId), async (tx) => {
            const r = await tx.$queryRawUnsafe<Array<{ r: string }>>('SELECT current_user AS r');
            return r[0].r;
        });
        expect(role).toBe('app_user');
    });

    it('the owning tenant SEES its document (the positive control)', async () => {
        expect(await visibleCount(tenantA, userId, 'FarmDocument')).toBeGreaterThan(0);
    });

    it('another tenant sees ZERO, and the row does exist', async () => {
        expect(await visibleCount(tenantB, userId, 'FarmDocument')).toBe(0);
        // The zero above means isolation only if the row is really there.
        const n = await globalPrisma.farmDocument.count({ where: { id: docA } });
        expect(n).toBe(1);
    });

    it('settings isolate the same way', async () => {
        await globalPrisma.tenantDocumentSettings.create({
            data: { tenantId: tenantA, retention: 'P2Y', driveSync: true } as never,
        });
        expect(await visibleCount(tenantA, userId, 'TenantDocumentSettings')).toBeGreaterThan(0);
        expect(await visibleCount(tenantB, userId, 'TenantDocumentSettings')).toBe(0);
    });
});

describeFn('FarmDocument — the CHECK constraints refuse, not merely exist', () => {
    let tenantId: string;
    let userId: string;
    let fileRecordId: string;

    beforeAll(async () => {
        const t = await globalPrisma.tenant.create({
            data: { name: `C ${run}`, slug: `c-${run}` } as never,
        });
        const u = await globalPrisma.user.create({
            data: { email: `c-${run}@example.test`, name: `C ${run}` } as never,
        });
        tenantId = t.id;
        userId = u.id;
        const fr = await globalPrisma.fileRecord.create({
            data: {
                tenantId,
                pathKey: `tenants/${tenantId}/general/2026/10/${randomUUID()}.pdf`,
                originalName: 'x.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 1,
                sha256: randomUUID().replace(/-/g, ''),
                uploadedByUserId: userId,
            } as never,
        });
        fileRecordId = fr.id;
    });

    afterAll(async () => {
        if (!tenantId) return;
        await globalPrisma.farmDocument.deleteMany({ where: { tenantId } });
        await globalPrisma.fileRecord.deleteMany({ where: { tenantId } });
        await globalPrisma.tenantMembership.deleteMany({ where: { tenantId } });
        await globalPrisma.tenant.deleteMany({ where: { id: tenantId } });
        await globalPrisma.user.deleteMany({ where: { id: userId } });
    });

    const base = () => ({
        tenantId,
        fileRecordId,
        uploadedByUserId: userId,
        retention: 'P1Y' as const,
    });

    it.each([
        ['14/03/2027', 'a human date'],
        ['2027-3-1', 'unpadded'],
        ['2027-10-30T00:00:00Z', 'an instant'],
        ['tomorrow', 'prose'],
    ])('refuses %s as expiresOn (%s)', async (bad) => {
        // The column is compared as a STRING, so a malformed value would not
        // error at read time — it would sort wrong, and a document would be
        // swept early or never. The database is the backstop for that.
        await expect(
            globalPrisma.farmDocument.create({ data: { ...base(), expiresOn: bad } as never }),
        ).rejects.toThrow();
    });

    it('accepts a well-formed day key, and null for «Без срок»', async () => {
        const ok = await globalPrisma.farmDocument.create({
            data: { ...base(), expiresOn: '2027-10-30' } as never,
        });
        expect(ok.expiresOn).toBe('2027-10-30');
        const none = await globalPrisma.farmDocument.create({
            data: { ...base(), retention: 'NONE', expiresOn: null } as never,
        });
        expect(none.expiresOn).toBeNull();
    });

    it('refuses an incoherent tombstone', async () => {
        // A reason with no timestamp, and a purgedBy on an EXPIRED sweep, are
        // both states the client has no way to render — so neither is
        // writable rather than merely discouraged.
        await expect(
            globalPrisma.farmDocument.create({
                data: { ...base(), purgeReason: 'DELETED' } as never,
            }),
        ).rejects.toThrow();
        await expect(
            globalPrisma.farmDocument.create({
                data: {
                    ...base(),
                    purgedAt: new Date(),
                    purgeReason: 'EXPIRED',
                    purgedByUserId: userId,
                } as never,
            }),
        ).rejects.toThrow();
    });

    it('accepts the two coherent tombstones', async () => {
        const expired = await globalPrisma.farmDocument.create({
            data: { ...base(), purgedAt: new Date(), purgeReason: 'EXPIRED' } as never,
        });
        expect(expired.purgedByUserId).toBeNull();
        const deleted = await globalPrisma.farmDocument.create({
            data: {
                ...base(),
                purgedAt: new Date(),
                purgeReason: 'DELETED',
                purgedByUserId: userId,
                name: null,
            } as never,
        });
        expect(deleted.purgedByUserId).toBe(userId);
        expect(deleted.name).toBeNull();
    });
    describe('the idempotency constraint (#2495 step 2)', () => {
        /*
         * `@@unique([tenantId, clientMutationId])` is what makes the
         * `Idempotency-Key` honest under a RACE. The usecase checks for an
         * existing row first, which handles the ordinary retry; two requests
         * arriving together both pass that check, and only the database can
         * refuse the second. So the constraint is the mechanism and the
         * pre-check is the optimisation — asserted in that order here.
         */
        it('refuses a second document with the same key in the same farm', async () => {
            const key = `idem-${randomUUID()}`;
            const first = await globalPrisma.farmDocument.create({
                data: { ...base(), clientMutationId: key } as never,
            });
            expect(first.clientMutationId).toBe(key);
            await expect(
                globalPrisma.farmDocument.create({
                    data: { ...base(), clientMutationId: key } as never,
                }),
            ).rejects.toThrow();
        });

        it('NULLS DISTINCT — many keyless uploads coexist', async () => {
            // The half that would break every ordinary upload if the index
            // were declared NULLS NOT DISTINCT. Three, because two could pass
            // on an off-by-one.
            const made = [];
            for (let i = 0; i < 3; i++) {
                made.push(
                    await globalPrisma.farmDocument.create({
                        data: { ...base(), clientMutationId: null } as never,
                    }),
                );
            }
            expect(made).toHaveLength(3);
            expect(new Set(made.map((m) => m.id)).size).toBe(3);
        });

        it('the same key in a DIFFERENT farm is allowed', async () => {
            // The pair is (tenantId, clientMutationId) and not the key alone:
            // it is a client's own id, unique within the farm that generated
            // it, so a global constraint would let one farm's retry collide
            // with another's.
            //
            // This describe owns ONE tenant, so the second farm is created and
            // removed inside the test rather than left for an afterAll that
            // does not know about it — a leaked tenant is the kind of residue
            // that makes a later suite's counts wrong for a reason nobody can
            // find.
            const key = `idem-shared-${randomUUID()}`;
            await globalPrisma.farmDocument.create({
                data: { ...base(), clientMutationId: key } as never,
            });

            const other = await globalPrisma.tenant.create({
                data: { name: `C2 ${run}`, slug: `c2-${run}` } as never,
            });
            try {
                const frB = await globalPrisma.fileRecord.create({
                    data: {
                        tenantId: other.id,
                        pathKey: `tenants/${other.id}/documents/${randomUUID()}.pdf`,
                        originalName: 'b.pdf',
                        mimeType: 'application/pdf',
                        sizeBytes: 10,
                        sha256: randomUUID().replace(/-/g, ''),
                        uploadedByUserId: userId,
                    } as never,
                });

                const inB = await globalPrisma.farmDocument.create({
                    data: {
                        tenantId: other.id,
                        name: 'B copy',
                        fileRecordId: frB.id,
                        uploadedByUserId: userId,
                        retention: 'P1Y',
                        clientMutationId: key,
                    } as never,
                });
                expect(inB.clientMutationId).toBe(key);
            } finally {
                await globalPrisma.farmDocument.deleteMany({ where: { tenantId: other.id } });
                await globalPrisma.fileRecord.deleteMany({ where: { tenantId: other.id } });
                await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: other.id } });
                await globalPrisma.tenant.deleteMany({ where: { id: other.id } });
            }
        });
    });
});

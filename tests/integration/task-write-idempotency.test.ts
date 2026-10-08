/**
 * The `(tenantId, clientMutationId)` unique indexes EXIST — DB-backed.
 *
 * Companion to `tests/unit/task-write-idempotency-forwarding.test.ts`, which
 * drives the real routes against a Prisma double. That double contains a
 * hand-written miniature of the index, so it proves the application pre-check
 * dedupes a SEQUENTIAL replay — the case an outbox actually performs — and it
 * is structurally incapable of noticing that the index is absent.
 *
 * Which matters, because the index is the CONCURRENT-race backstop and the
 * only thing standing behind it. If the migration had not applied, the app
 * pre-check would still pass every unit test while two simultaneous replays
 * both read "no existing row" and both insert. The duplicate would appear only
 * under load, in the ДНЕВНИК record, with nothing erroring.
 *
 * So this asserts the two halves the mocks cannot:
 *
 *   1. a second row with the same (tenantId, clientMutationId) trips P2002;
 *   2. several rows with a NULL key coexist freely — NULLS DISTINCT, which is
 *      what makes ordinary online writes unconstrained and is the reason no
 *      partial index is needed.
 *
 * Both models, because the migration adds the pair to both and a half-applied
 * migration is exactly the state worth catching.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `twidem-${randomUUID().slice(0, 8)}`;

let tenantId = '';
let userId = '';
let taskId = '';
let parcelId = '';

/** P2002 and nothing else — a different error would mean a different defect. */
async function expectUniqueViolation(write: () => Promise<unknown>): Promise<void> {
    let code: string | undefined;
    try {
        await write();
    } catch (err) {
        code = (err as { code?: string }).code;
    }
    expect(code).toBe('P2002');
}

describeFn('task-side write idempotency — the unique indexes are real', () => {
    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        await globalPrisma.$connect();

        const email = `${TAG}@ag.test`;
        const user = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email), name: 'TW Idem User' },
        });
        userId = user.id;

        const tenant = await globalPrisma.tenant.create({
            data: { name: `${TAG} Farm`, slug: `${TAG}-t` },
        });
        tenantId = tenant.id;

        const task = await globalPrisma.task.create({
            data: {
                tenantId,
                title: 'Close-out',
                type: 'FIELD_OPERATION',
                key: `${TAG}-1`,
                createdByUserId: userId,
            },
        });
        taskId = task.id;

        // A Parcel requires a Location — same fixture shape as
        // `field-operation-idempotency.test.ts`.
        const location = await globalPrisma.location.create({
            data: { tenantId, name: `${TAG} Масив` },
        });
        const parcel = await globalPrisma.parcel.create({
            data: { tenantId, locationId: location.id, name: `${TAG} Нива` },
        });
        parcelId = parcel.id;
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        await globalPrisma.parcelWeedObservation.deleteMany({ where: { tenantId } });
        await globalPrisma.taskComment.deleteMany({ where: { tenantId } });
        await globalPrisma.parcel.deleteMany({ where: { tenantId } });
        await globalPrisma.location.deleteMany({ where: { tenantId } });
        await globalPrisma.task.deleteMany({ where: { tenantId } });
        await globalPrisma.tenant.deleteMany({ where: { id: tenantId } });
        await globalPrisma.user.deleteMany({ where: { id: userId } });
        await globalPrisma.$disconnect();
    });

    describe('TaskComment', () => {
        it('a duplicate (tenantId, clientMutationId) trips P2002', async () => {
            const key = `cmt-${randomUUID()}`;
            await globalPrisma.taskComment.create({
                data: { tenantId, taskId, body: 'първи', createdByUserId: userId, clientMutationId: key },
            });
            await expectUniqueViolation(() =>
                globalPrisma.taskComment.create({
                    data: { tenantId, taskId, body: 'втори', createdByUserId: userId, clientMutationId: key },
                }),
            );
            const rows = await globalPrisma.taskComment.findMany({
                where: { tenantId, clientMutationId: key },
            });
            expect(rows).toHaveLength(1);
        });

        it('several NULL-key comments coexist — NULLS DISTINCT', async () => {
            // The property that makes a partial index unnecessary. If this
            // failed, every ordinary online comment after the first would be
            // rejected.
            for (const body of ['a', 'b', 'c']) {
                await globalPrisma.taskComment.create({
                    data: { tenantId, taskId, body, createdByUserId: userId },
                });
            }
            const rows = await globalPrisma.taskComment.findMany({
                where: { tenantId, clientMutationId: null },
            });
            expect(rows.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('ParcelWeedObservation', () => {
        it('a duplicate (tenantId, clientMutationId) trips P2002', async () => {
            const key = `weed-${randomUUID()}`;
            await globalPrisma.parcelWeedObservation.create({
                data: {
                    tenantId,
                    parcelId,
                    observedAt: new Date('2026-10-08T08:00:00.000Z'),
                    weedKeys: ['cirsium_arvense'],
                    createdByUserId: userId,
                    clientMutationId: key,
                },
            });
            await expectUniqueViolation(() =>
                globalPrisma.parcelWeedObservation.create({
                    data: {
                        tenantId,
                        parcelId,
                        observedAt: new Date('2026-10-08T08:00:00.000Z'),
                        weedKeys: ['cirsium_arvense'],
                        createdByUserId: userId,
                        clientMutationId: key,
                    },
                }),
            );
            const rows = await globalPrisma.parcelWeedObservation.findMany({
                where: { tenantId, clientMutationId: key },
            });
            expect(rows).toHaveLength(1);
        });

        it('several NULL-key observations coexist — NULLS DISTINCT', async () => {
            for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
                await globalPrisma.parcelWeedObservation.create({
                    data: {
                        tenantId,
                        parcelId,
                        observedAt: new Date(`${d}T08:00:00.000Z`),
                        weedKeys: ['cirsium_arvense'],
                        createdByUserId: userId,
                    },
                });
            }
            const rows = await globalPrisma.parcelWeedObservation.findMany({
                where: { tenantId, clientMutationId: null },
            });
            expect(rows.length).toBeGreaterThanOrEqual(3);
        });
    });

    it('control: the two indexes are present in the database, by name', async () => {
        // The positive control for the whole file. Every case above would also
        // pass against a schema where Prisma happened to reject the duplicate
        // for some other reason, and the NULL cases pass against a table with
        // NO index at all. This reads pg_indexes.
        const rows = await globalPrisma.$queryRaw<{ indexname: string }[]>`
            SELECT indexname FROM pg_indexes
            WHERE indexname IN (
                'TaskComment_tenantId_clientMutationId_key',
                'ParcelWeedObservation_tenantId_clientMutationId_key'
            )
        `;
        expect(rows.map((r) => r.indexname).sort()).toEqual([
            'ParcelWeedObservation_tenantId_clientMutationId_key',
            'TaskComment_tenantId_clientMutationId_key',
        ]);
    });
});

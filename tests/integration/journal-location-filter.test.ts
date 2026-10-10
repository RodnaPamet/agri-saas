/**
 * Filtering the journal by BLOCK must reach the records the farm did not link
 * by hand (DB-backed).
 *
 * The owner's «блок» is a `Location` — "a collection of parcels, the one
 * uploaded in the shape files". Two paths reach one:
 *
 *   1. `LogLocation` — an entry a person explicitly linked to the block.
 *   2. `operationParcel → parcel → locationId` — an entry attached to an
 *      operation LINE, which names a parcel, which belongs to a block.
 *
 * Only (1) was matched, and (2) is where the bulk of a ДНЕВНИК lives: the
 * INPUT_APPLICATION entry the spray flow writes passes `operationParcelId`
 * and no `locationIds`. So `?locationId=` returned the hand-linked entries
 * only — an incomplete regulatory record that reads exactly like a complete
 * one. `?crop=` already reached those same records through `operationParcel`,
 * so crop and block disagreed about which entries belong to a block.
 *
 * ## Why this is DB-backed and not only a unit test
 *
 * `tests/unit/repositories/journal-repository.test.ts` asserts the `where`
 * CLAUSE, which is the right place to pin the AND/OR structure. It cannot
 * tell whether Prisma accepts a two-hop `is` filter on a to-one relation, nor
 * whether the clause SELECTS the row — and "the query shape is right" and
 * "the farmer sees their spray record" are different claims. The negative
 * control is the half that matters: a filter that returned everything would
 * satisfy every positive assertion here.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { JournalRepository } from '@/app-layer/repositories/JournalRepository';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `jloc-${randomUUID().slice(0, 8)}`;

let userId = '';
let unitId = '';
let tenantId = '';
/** The block under test, and a second block that must never be returned. */
let locA = '';
let locB = '';
/** Entry ids, by how each one reaches (or fails to reach) a block. */
let sprayInA = ''; // operationParcel → parcel in A, NO LogLocation
let handLinkedToA = ''; // LogLocation → A, no operation line
let sprayInB = ''; // operationParcel → parcel in B
let freeHand = ''; // no link of any kind

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

const listByLocation = (locationId: string, extra: Record<string, unknown> = {}) =>
    runInTenantContext(ctx(), (db) => JournalRepository.list(db, ctx(), { locationId, ...extra }));

const idsOf = (rows: unknown[]): string[] => (rows as { id: string }[]).map((r) => r.id).sort();

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();

    const email = `${TAG}@ag.test`;
    userId = (
        await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email), name: 'Journal Loc User' },
        })
    ).id;
    unitId = (
        await globalPrisma.unit.create({
            data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
        })
    ).id;

    const tenant = await globalPrisma.tenant.create({
        data: { name: `T ${TAG}`, slug: `${TAG}-t` },
    });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });

    // TWO blocks. One block alone cannot distinguish "matched the block" from
    // "matched everything".
    locA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    locB = (await globalPrisma.location.create({ data: { tenantId, name: `Block B ${TAG}` } })).id;
    const parcelA = await globalPrisma.parcel.create({
        data: { tenantId, locationId: locA, name: `PA ${TAG}`, areaHa: 4 },
    });
    const parcelB = await globalPrisma.parcel.create({
        data: { tenantId, locationId: locB, name: `PB ${TAG}`, areaHa: 4 },
    });

    const item = await globalPrisma.item.create({
        data: { tenantId, name: `Prod ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
    });
    const task = await globalPrisma.task.create({
        data: {
            tenantId,
            title: `Spray ${TAG}`,
            type: 'FIELD_OPERATION',
            createdByUserId: userId,
            assigneeUserId: userId,
        },
    });
    const opA = await globalPrisma.operationParcel.create({
        data: {
            tenantId,
            taskId: task.id,
            parcelId: parcelA.id,
            productItemId: item.id,
            doseValue: 2,
            doseUnitId: unitId,
        },
    });
    const opB = await globalPrisma.operationParcel.create({
        data: {
            tenantId,
            taskId: task.id,
            parcelId: parcelB.id,
            productItemId: item.id,
            doseValue: 2,
            doseUnitId: unitId,
        },
    });

    const occurredAt = new Date('2026-05-01T08:00:00Z');

    // The record the defect hid: exactly the shape `inventory.ts` writes —
    // an operation line and NO locationIds.
    sprayInA = (
        await globalPrisma.logEntry.create({
            data: {
                tenantId,
                type: 'INPUT_APPLICATION',
                occurredAt,
                title: `Пръскане в блок A ${TAG}`,
                operationParcelId: opA.id,
            },
        })
    ).id;

    handLinkedToA = (
        await globalPrisma.logEntry.create({
            data: {
                tenantId,
                type: 'OBSERVATION',
                occurredAt,
                title: `Ръчна бележка ${TAG}`,
            },
        })
    ).id;
    // The join row is created separately rather than nested: `LogLocation`
    // relates on the COMPOSITE `[logEntryId, tenantId]`, so a nested create
    // that also passes `tenantId` is ambiguous to Prisma — the relation would
    // be setting the same column the payload names.
    await globalPrisma.logLocation.create({
        data: { tenantId, logEntryId: handLinkedToA, locationId: locA },
    });

    sprayInB = (
        await globalPrisma.logEntry.create({
            data: {
                tenantId,
                type: 'INPUT_APPLICATION',
                occurredAt,
                title: `Пръскане в блок B ${TAG}`,
                operationParcelId: opB.id,
            },
        })
    ).id;

    freeHand = (
        await globalPrisma.logEntry.create({
            data: { tenantId, type: 'OBSERVATION', occurredAt, title: `Свободен запис ${TAG}` },
        })
    ).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of [
            'LogLocation',
            'LogEntry',
            'OperationParcel',
            'TaskLink',
            'Task',
            'Item',
            'Parcel',
            'Location',
            'AuditLog',
            'AutomationExecution',
            'TenantMembership',
        ]) {
            await globalPrisma
                .$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId)
                .catch(() => {});
        }
        await globalPrisma
            .$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId)
            .catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch {
        /* best-effort; globalSetup resets */
    }
    await globalPrisma.$disconnect();
});

describeFn('journal ?locationId= and the manual-only rule (DB)', () => {
    // TWO regimes, and both matter.
    //
    // #1545 widened `?locationId=` to reach entries whose only link is an
    // operation line, because the spray records were missing from a block
    // filter. The owner then ruled (2026-10-10) that the journal shows what a
    // person typed — so those same entries are now hidden from it BY INTENT.
    //
    // That is a supersession, not a contradiction, and the distinction is
    // testable: the two-path clause is still intact underneath. Hiding happens
    // because the entry is excluded, not because the clause was removed. The
    // satellite briefing opts in and still gets both paths, which is the only
    // reason #1545's fix still has a consumer.

    it('control: the fixture is there, so an empty result cannot read as a pass', async () => {
        const all = await runInTenantContext(ctx(), (db) =>
            JournalRepository.list(db, ctx(), { includeTaskWritten: true }),
        );
        expect(idsOf(all)).toEqual([sprayInA, handLinkedToA, sprayInB, freeHand].sort());
    });

    describe('by default — manual entries only', () => {
        it('hides every task-written entry from an unfiltered list', async () => {
            const rows = await runInTenantContext(ctx(), (db) =>
                JournalRepository.list(db, ctx(), {}),
            );
            // The two a person typed; neither spray record.
            expect(idsOf(rows)).toEqual([handLinkedToA, freeHand].sort());
        });

        it('returns only the hand-linked entry for a block', async () => {
            // Before the ruling this returned the spray record too. It is
            // excluded now because the entry is task-written, NOT because the
            // operationParcel path was taken out — the next describe proves
            // the clause still works.
            expect(idsOf(await listByLocation(locA))).toEqual([handLinkedToA]);
        });

        it('returns NOTHING for a block whose only entry is a spray record', async () => {
            // Block B has exactly one entry and it is task-written. An empty
            // result here is the rule working, and it is the case a farmer
            // would misread as "no records" — which is why the ДНЕВНИК PDF
            // keeps reading operation lines directly.
            expect(idsOf(await listByLocation(locB))).toEqual([]);
        });

        it('still applies the free-text search, over manual entries only', async () => {
            // `Пръскане` matches only the spray titles, which are hidden.
            expect(idsOf(await listByLocation(locA, { q: 'Пръскане' }))).toEqual([]);
            // ...and the manual entry is reachable by its own text.
            expect(idsOf(await listByLocation(locA, { q: 'Ръчна' }))).toEqual([handLinkedToA]);
        });
    });

    describe('with includeTaskWritten — what the satellite briefing sees', () => {
        it('reaches the SPRAY record whose only link is an operation line', async () => {
            // #1545's fix, still live. This is the assertion that would fail
            // if someone "simplified" the two-path OR away now that the
            // journal no longer shows these entries.
            const rows = await listByLocation(locA, { includeTaskWritten: true });
            expect(idsOf(rows)).toContain(sprayInA);
        });

        it('returns BOTH paths for one block, and nothing else', async () => {
            const rows = await listByLocation(locA, { includeTaskWritten: true });
            expect(idsOf(rows)).toEqual([sprayInA, handLinkedToA].sort());
        });

        it('still discriminates by block rather than returning everything', async () => {
            // The negative control. With the rule lifted, a clause that matched
            // any entry with ANY operation line would satisfy both assertions
            // above and be useless.
            const a = await listByLocation(locA, { includeTaskWritten: true });
            expect(idsOf(a)).not.toContain(sprayInB);
            expect(idsOf(a)).not.toContain(freeHand);

            const b = await listByLocation(locB, { includeTaskWritten: true });
            expect(idsOf(b)).toEqual([sprayInB]);
        });

        it('keeps the free-text search working alongside the block filter', async () => {
            const rows = await listByLocation(locA, { q: 'Пръскане', includeTaskWritten: true });
            expect(idsOf(rows)).toEqual([sprayInA]);
        });
    });

    it('intersects with the crop filter rather than overwriting it', async () => {
        // Both reach through `operationParcel`. Parcel A has no cropType, so a
        // crop filter excludes the spray record even with the rule lifted.
        const rows = await listByLocation(locA, { crop: ['wheat'], includeTaskWritten: true });
        expect(idsOf(rows)).toEqual([]);
    });
});

/**
 * The manual-only journal rule, after the diary flag (DB-backed) — #1740.
 *
 * The owner ruling of 2026-10-10 is that the journal list shows manual entries
 * only. Its test used to be `operationParcelId IS NULL`, which stopped being
 * sufficient: the two-step treatment record is typed by a person and ALSO
 * writes operation lines, because those lines are what the BABH diary PDF
 * reads. The rule is now a negation of the thing being hidden —
 * `NOT (operationParcelId IS NOT NULL AND NOT recordedInDiary)`.
 *
 * ## Why this is DB-backed and not only a query-shape test
 *
 * `tests/unit/repositories/journal-repository.test.ts` asserts the clause the
 * repository emits, and mutation-proves it. What it cannot settle is what
 * Prisma DOES with `NOT: { a, b }` — whether that means `NOT (a AND b)`, which
 * is the rule, or `NOT a AND NOT b`, which would additionally hide every entry
 * with no operation line and blank the journal for every existing farm.
 *
 * That is the difference between a correct rule and an outage, it is not
 * knowable from the clause, and it is exactly the kind of thing a reader
 * assumes. So it is asserted against a real database with all four
 * combinations present.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { JournalRepository } from '@/app-layer/repositories/JournalRepository';
import { runInTenantContext } from '@/lib/db-context';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `diary-${randomUUID().slice(0, 8)}`;

let userId = '';
let tenantId = '';
let unitId = '';
// The four combinations of (has operation line) x (recordedInDiary).
let plainManual = '';      // no line, flag false  -> SHOWN (the ordinary case)
let diaryNoLine = '';      // no line, flag true   -> SHOWN
let taskWritten = '';      // line,    flag false  -> HIDDEN (what the rule hides)
let diaryTreatment = '';   // line,    flag true   -> SHOWN (the #1740 case)

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Diary User' },
    })).id;
    unitId = (await globalPrisma.unit.create({
        data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
    })).id;
    const tenant = await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });

    const location = await globalPrisma.location.create({ data: { tenantId, name: `Block ${TAG}` } });
    const parcel = await globalPrisma.parcel.create({
        data: { tenantId, locationId: location.id, name: `P ${TAG}`, cropType: 'Wheat' },
    });
    const item = await globalPrisma.item.create({
        data: { tenantId, name: `Prod ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
    });
    const task = await globalPrisma.task.create({
        data: { tenantId, title: `Spray ${TAG}`, type: 'FIELD_OPERATION', createdByUserId: userId },
    });
    const line = await globalPrisma.operationParcel.create({
        data: {
            tenantId, taskId: task.id, parcelId: parcel.id, productItemId: item.id,
            doseValue: 2, doseUnitId: unitId, status: 'PENDING',
        },
    });

    const mk = async (title: string, operationParcelId: string | null, recordedInDiary: boolean) =>
        (await globalPrisma.logEntry.create({
            data: {
                tenantId, type: 'INPUT_APPLICATION', title, occurredAt: new Date(),
                createdByUserId: userId, operationParcelId, recordedInDiary,
            },
        })).id;

    plainManual = await mk(`plain ${TAG}`, null, false);
    diaryNoLine = await mk(`diary-no-line ${TAG}`, null, true);
    taskWritten = await mk(`task-written ${TAG}`, line.id, false);
    diaryTreatment = await mk(`diary-treatment ${TAG}`, line.id, true);
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of ['LogEntry', 'OperationParcel', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await globalPrisma.$disconnect();
});

const idsFrom = async (filters: Parameters<typeof JournalRepository.list>[2] = {}) =>
    runInTenantContext(ctx(), async (db) => {
        const rows = await JournalRepository.list(db, ctx(), filters);
        return rows.map((r: { id: string }) => r.id);
    });

describeFn('journal manual-only rule with the diary flag (DB-backed)', () => {
    it('hides ONLY the task-written entry, which is what NOT(a AND b) means', async () => {
        const ids = await idsFrom();

        // The load-bearing assertion of this file. If Prisma read
        // `NOT: { a, b }` as `NOT a AND NOT b`, `plainManual` and
        // `diaryNoLine` would be hidden too and this farm's journal would
        // look empty — a correct-looking clause producing an outage.
        expect(ids).toContain(plainManual);
        expect(ids).toContain(diaryNoLine);
        expect(ids).toContain(diaryTreatment);
        expect(ids).not.toContain(taskWritten);
    });

    it('shows a diary-recorded treatment even though it carries an operation line', async () => {
        // The #1740 case in one line: this entry is indistinguishable from a
        // task-written one by `operationParcelId` alone, which is why the
        // column was not enough.
        const ids = await idsFrom();
        expect(ids).toContain(diaryTreatment);
        expect(ids).not.toContain(taskWritten);
    });

    it('still hides the task-written entry when a search term is given', async () => {
        // The collision case, against a real query rather than a clause. `q`
        // assigns `where.OR`, so an implementation that put this rule there
        // would have had it discarded here and returned the task-written
        // entry. Searching for the shared TAG matches all four titles, so
        // nothing is excluded by the search itself.
        const ids = await idsFrom({ q: TAG });
        expect(ids).toContain(plainManual);
        expect(ids).toContain(diaryTreatment);
        expect(ids).not.toContain(taskWritten);
    });

    it('orders by the work day and breaks ties on id, which a capped read needs', async () => {
        // `occurredAt` on a diary entry is a DAY, so entries recorded for the
        // same day TIE — and this branch is capped at 200. Without a tiebreak
        // Postgres may return a different subset of a tied group between two
        // identical requests, so an entry near the cap can be present in one
        // read and absent from the next with nothing changed. The offline
        // outbox replay reads this branch (#1771, the class of #1742).
        //
        // The four fixture entries share two timestamps at most, so this
        // asserts the MECHANISM rather than hoping for a tie: the repository
        // must ask for the tiebreak. Reproducing the wrong resolution needs
        // two random cuids to sort opposite to their physical order, which is
        // chance — the same honesty as `parcels-by-crop`'s tiebreak case.
        const src = readFileSync(
            join(__dirname, '..', '..', 'src/app-layer/repositories/JournalRepository.ts'),
            'utf8',
        );
        expect(src).toContain("orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }]");

        // And the order that IS observable: newest work first, not newest row.
        // `diaryTreatment` and `taskWritten` were created last but share the
        // others' day, so a `createdAt` order would put them first.
        const ids = await idsFrom();
        const rows = await runInTenantContext(ctx(), async (db) =>
            JournalRepository.list(db, ctx(), {}),
        );
        expect(rows.map((r: { id: string }) => r.id)).toEqual(ids);
        const days = rows.map((r: { occurredAt: Date }) => r.occurredAt.getTime());
        expect(days).toEqual([...days].sort((a, b) => b - a));
    });

    it('widens to everything when a caller opts in, rather than inverting', async () => {
        const ids = await idsFrom({ includeTaskWritten: true });
        expect(ids).toContain(taskWritten);
        expect(ids).toContain(plainManual);
        expect(ids).toContain(diaryTreatment);
    });
});

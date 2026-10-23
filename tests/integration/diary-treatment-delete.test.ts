/**
 * Abandoning a treatment that cannot be finished (#1777, DB-backed).
 *
 * A treatment write is resumable rather than atomic, and the mark is what
 * writes the ДНЕВНИК entry — so a failure during marking leaves one partly
 * recorded. Re-sending the same handle finishes it, UNLESS the cause repeats,
 * and then the farmer has a treatment that will neither complete nor go away.
 *
 * `deleteDiaryTreatment` is the other exit. Owner ruling of 2026-10-15: it
 * soft-deletes the WHOLE treatment, the already-written register entries
 * included. That is a real cost — those entries record sprays that actually
 * happened — and the protections are what make it defensible: ADMIN only,
 * soft, audited, and refused outright on a COMPLETE treatment.
 *
 * ## Why this is DB-backed
 *
 * Every property here is about row state across four tables after the call:
 * `Task.deletedAt`, `LogEntry.deletedAt`, `OperationParcel.status`, and an
 * `AuditLog` row. A mocked repository would assert the calls I wrote rather
 * than what the database holds, and the interesting half — that a DONE line
 * is left alone while its entry is withdrawn — is exactly the kind of thing a
 * double cannot disagree with me about.
 *
 * ## How the partial state is produced
 *
 * Directly, by flipping one line back to `PENDING` and removing the entry it
 * wrote. The natural cause (a mark that keeps failing) cannot be induced from
 * outside the usecase, and the documented partial state was once unreachable
 * for a different reason — the handle is stamped in the same transaction as
 * the lines, so a task with no lines has no handle. What matters is that the
 * SHAPE here is the shape the endpoint meets: some lines DONE with entries,
 * one line PENDING with none, `complete: false`.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    recordDiaryTreatment,
    getDiaryTreatment,
    deleteDiaryTreatment,
} from '@/app-layer/usecases/diary-treatment';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `dtdel-${randomUUID().slice(0, 8)}`;
const DAY = '2026-03-04';

let userId = '';
let unitId = '';
let tenantId = '';
let blockA = '';
let parcelA1 = '';
let parcelA2 = '';
let itemId = '';

const ctx = (role: Role | 'OWNER' = 'OWNER') =>
    makeRequestContext(role as 'OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (
        await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email), name: 'Delete Treat User' },
        })
    ).id;
    unitId = (
        await globalPrisma.unit.create({
            data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
        })
    ).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    blockA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    const mkParcel = async (name: string) =>
        (
            await globalPrisma.parcel.create({
                data: { tenantId, locationId: blockA, name, cropType: 'Wheat', areaHa: 10 },
            })
        ).id;
    parcelA1 = await mkParcel(`A1 ${TAG}`);
    parcelA2 = await mkParcel(`A2 ${TAG}`);
    itemId = (
        await globalPrisma.item.create({
            data: { tenantId, name: `Prod ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId },
        })
    ).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of [
            'LogQuantity', 'LogEntry', 'Notification', 'EmailOutbox', 'OperationParcel',
            'TaskLink', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'TenantMembership',
        ]) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await globalPrisma.$disconnect();
});

const input = () => ({
    kind: 'SPRAY' as const,
    occurredOn: DAY,
    parcelIds: [parcelA1, parcelA2],
    productItemId: itemId,
    doseValue: 2,
    doseUnitId: unitId,
    title: `Spray ${TAG}`,
});

/** Record a treatment, then make it INCOMPLETE the way a failed mark leaves it. */
async function recordPartial(handle: string) {
    await recordDiaryTreatment(ctx(), input(), handle);
    const tasks = await globalPrisma.task.findMany({
        where: { tenantId, treatmentGroupId: handle },
        select: { id: true },
    });
    const taskIds = tasks.map((t) => t.id);
    const lines = await globalPrisma.operationParcel.findMany({
        where: { tenantId, taskId: { in: taskIds } },
        select: { id: true },
        orderBy: { id: 'asc' },
    });
    // One line back to PENDING, and the entry it wrote removed — a PENDING
    // line has never written one.
    await globalPrisma.logEntry.deleteMany({ where: { tenantId, operationParcelId: lines[0].id } });
    await globalPrisma.operationParcel.update({
        where: { id: lines[0].id },
        data: { status: 'PENDING' },
    });
    return { taskIds, pendingLine: lines[0].id, doneLine: lines[1].id };
}

describeFn('abandoning an unfinished treatment (DB-backed)', () => {
    it('ERASES a complete treatment — rows gone, handle released', async () => {
        // This asserted the OPPOSITE until 2026-10-22: a 409 TREATMENT_COMPLETE,
        // on the reasoning that a finished treatment is a БАБХ record and that
        // dropping it here would be 'a convenience route that drops БАБХ
        // records'. The owner reversed that (#2175). The old reasoning is kept
        // verbatim in the usecase docblock, because it is still the best
        // account of what the change costs.
        const handle = `complete-${randomUUID()}`;
        await recordDiaryTreatment(ctx(), input(), handle);

        const before = await globalPrisma.task.findMany({
            where: { tenantId, treatmentGroupId: handle },
            select: { id: true, clientMutationId: true },
            orderBy: { id: 'asc' },
        });
        expect(before.length).toBeGreaterThan(0);

        const result = await deleteDiaryTreatment(ctx(), handle);
        expect(result.tasks).toBe(before.length);

        // REVERSED 2026-10-24. This used to assert the rows SURVIVED with
        // `deletedAt` set, and that the handle was KEPT so a restore could be
        // exact. «Кошче» is gone and the owner chose "erased from the
        // database", so every one of those expectations is now the opposite.
        // The arms are unchanged — the same treatment, the same reads — which
        // is what makes the reversal legible.
        const tasks = await globalPrisma.task.findMany({
            where: { tenantId, treatmentGroupId: handle },
        });
        expect(tasks).toHaveLength(0);

        // The entries are the ones a cascade would MISS.
        // `LogEntry.operationParcel` is optional and declares no `onDelete`,
        // so Prisma defaults it to SET NULL — without the explicit delete they
        // would still be here with a null `operationParcelId`. Asserting on
        // `treatmentGroupId` rather than the link is deliberate: that column
        // survives a SET NULL, so a surviving row is still findable by it.
        const entries = await globalPrisma.logEntry.findMany({
            where: { tenantId, treatmentGroupId: handle },
        });
        expect(entries).toHaveLength(0);

        // The register lines, cascaded with their tasks.
        const lines = await globalPrisma.operationParcel.findMany({
            where: { tenantId, taskId: { in: before.map((t) => t.id) } },
        });
        expect(lines).toHaveLength(0);

        // The handle is released for a COMPLETE treatment now. It used to be
        // kept so a restore could be exact; with the row gone it occupies no
        // unique key and there is no restore to be exact about.
        const reused = await globalPrisma.task.findFirst({
            where: { tenantId, clientMutationId: { in: before.map((t) => t.clientMutationId!) } },
        });
        expect(reused).toBeNull();
    });

    it('404s on a handle nobody recorded', async () => {
        await expect(deleteDiaryTreatment(ctx(), `nope-${randomUUID()}`)).rejects.toMatchObject({
            code: 'TREATMENT_NOT_FOUND',
        });
    });

    it('a role that cannot WRITE cannot delete, whoever recorded it', async () => {
        // This was called 'is ADMIN-only' and that stopped being true with
        // #2175. It also never tested what the name said: `ctx(role)` keeps the
        // SAME userId, so this MECHANISATOR *is* the creator — it is refused by
        // `assertCanWrite` (MECHANISATOR has `canWrite: false`), not by any
        // admin check, and `rejects.toBeDefined()` could not tell which gate
        // answered. Both are fixed: the name says what it tests and the code is
        // asserted.
        const handle = `authz-${randomUUID()}`;
        await recordPartial(handle);

        await expect(
            deleteDiaryTreatment(ctx('MECHANISATOR' as Role), handle),
            // A DISTINCT code from the creator refusal, which is what lets a
            // client tell "your role cannot do this" from "this is not yours".
        ).rejects.toMatchObject({ code: 'WRITE_FORBIDDEN_FOR_ROLE' });

        const tasks = await globalPrisma.task.findMany({ where: { tenantId, treatmentGroupId: handle } });
        expect(tasks.every((t) => t.deletedAt === null)).toBe(true);
    });

    it('the CREATOR may delete without being an admin — the #2175 widening', async () => {
        // The actual content of the new rule, and it was untested: every other
        // case here runs as OWNER, which is creator AND admin, so it passes
        // through the admin arm and says nothing about the creator arm. EDITOR
        // has `canWrite: true` and `canAdmin: false`, and shares the fixture's
        // userId — so it is the creator and nothing else.
        const handle = `creator-${randomUUID()}`;
        await recordDiaryTreatment(ctx(), input(), handle);

        const result = await deleteDiaryTreatment(ctx('EDITOR' as Role), handle);
        expect(result.tasks).toBeGreaterThan(0);

        const tasks = await globalPrisma.task.findMany({ where: { tenantId, treatmentGroupId: handle } });
        expect(tasks.every((t) => t.deletedAt !== null)).toBe(true);
    });

    it('a WRITER who did not record it is refused, with the code the phone renders', async () => {
        // The other side of the widening. A different user with full write
        // rights must still be refused — otherwise 'creator or admin' is just
        // 'canWrite' with extra words. No real user row is needed because the
        // refusal lands before any write.
        const handle = `stranger-${randomUUID()}`;
        await recordDiaryTreatment(ctx(), input(), handle);

        const stranger = makeRequestContext('EDITOR', {
            userId: `${userId}-someone-else`,
            tenantId,
            tenantSlug: `${TAG}-t`,
        });
        await expect(deleteDiaryTreatment(stranger, handle)).rejects.toMatchObject({
            code: 'TREATMENT_DELETE_NOT_PERMITTED',
        });

        const tasks = await globalPrisma.task.findMany({ where: { tenantId, treatmentGroupId: handle } });
        expect(tasks.every((t) => t.deletedAt === null)).toBe(true);
    });

    it('soft-deletes the tasks and the entries, and SKIPS the unfinished lines', async () => {
        const handle = `partial-${randomUUID()}`;
        const { pendingLine, doneLine } = await recordPartial(handle);

        // Precondition: genuinely incomplete, which is what the endpoint is for.
        const before = await getDiaryTreatment(ctx(), handle);
        expect(before).toMatchObject({ complete: false });

        const result = await deleteDiaryTreatment(ctx(), handle);
        expect(result).toMatchObject({ treatmentGroupId: handle, tasks: 1, lines: 1 });
        expect(result.entries).toBeGreaterThan(0);

        // Tasks: soft, not hard — the row and its audit history stay.
        const tasks = await globalPrisma.task.findMany({ where: { tenantId, treatmentGroupId: handle } });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].deletedAt).not.toBeNull();
        expect(tasks[0].deletedByUserId).toBe(userId);

        // Entries: withdrawn, and still on disk.
        const entries = await globalPrisma.logEntry.findMany({ where: { tenantId, treatmentGroupId: handle } });
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.every((e) => e.deletedAt !== null)).toBe(true);

        // The unfinished line is SKIPPED — `OperationParcel` has no
        // `deletedAt`, and SKIPPED is the state the completion pass already
        // refuses to touch, so the remainder cannot be marked later.
        const pending = await globalPrisma.operationParcel.findUnique({ where: { id: pendingLine } });
        expect(pending?.status).toBe('SKIPPED');

        // The line that DID complete keeps its own status. Its record of what
        // happened stays true even though the entry it wrote is withdrawn.
        const done = await globalPrisma.operationParcel.findUnique({ where: { id: doneLine } });
        expect(done?.status).toBe('DONE');
    });

    it('REFUSES a resend of an abandoned handle rather than recreating it', async () => {
        // This test asserted the opposite when #1777 merged — that a resend
        // "mints a NEW treatment" — and that was the hole, not the feature.
        // Found by the agrent-ios session reading the merged code: their
        // outbox resends a treatment whose 201 came back short on every
        // launch, so an admin abandons a stuck treatment, the phone wakes up,
        // and the whole thing is back with every ДНЕВНИК entry. With a task
        // in a terminal status as the dead-end cause, the fresh tasks do not
        // share it, so the resend COMPLETES and the abandon is undone with
        // nobody seeing it.
        const handle = `release-${randomUUID()}`;
        await recordPartial(handle);
        await deleteDiaryTreatment(ctx(), handle);

        // The summary stops resolving, which is what a client sees as 404.
        expect(await getDiaryTreatment(ctx(), handle)).toBeNull();

        await expect(recordDiaryTreatment(ctx(), input(), handle)).rejects.toMatchObject({
            code: 'TREATMENT_ABANDONED',
            status: 410,
        });

        // And nothing was written on the way to the refusal: no live task
        // under that handle, which a create-then-fail would have left behind.
        const live = await globalPrisma.task.findMany({
            where: { tenantId, treatmentGroupId: handle, deletedAt: null },
        });
        expect(live).toHaveLength(0);

        // The abandoned task still released its `clientMutationId`. That is
        // no longer what stops the recreation — the 410 above is — but the
        // key belongs to a dead row, and leaving it would trip any future
        // path that creates with the same derived key.
        const abandoned = await globalPrisma.task.findMany({
            where: { tenantId, treatmentGroupId: handle, deletedAt: { not: null } },
            select: { clientMutationId: true, treatmentGroupId: true },
        });
        expect(abandoned).toHaveLength(1);
        expect(abandoned[0].clientMutationId).toBeNull();
        // …while still saying which treatment it was, which is the half that
        // must survive for the audit trail to mean anything — and which is
        // also how the refusal above knows the handle was abandoned.
        expect(abandoned[0].treatmentGroupId).toBe(handle);
    });

    it('a handle nobody abandoned still records normally', async () => {
        // The other side of the refusal. Without this, a 410 on EVERY fresh
        // handle would pass the test above and break every write.
        const handle = `fresh-${randomUUID()}`;
        const result = await recordDiaryTreatment(ctx(), input(), handle);
        expect(result).toMatchObject({ treatmentGroupId: handle, replayed: false });
        expect(result.parcelCount).toBe(2);
    });

    it('writes ONE audit event naming the handle and what it removed', async () => {
        const handle = `audit-${randomUUID()}`;
        await recordPartial(handle);
        await deleteDiaryTreatment(ctx(), handle);

        const events = await globalPrisma.auditLog.findMany({
            where: { tenantId, entityId: handle, action: 'ENTITY_DELETED' },
        });
        expect(events).toHaveLength(1);
        // The counts belong in the record: "a treatment was abandoned" without
        // them cannot answer how much register data went with it, which is the
        // question this event exists to answer.
        const details = events[0].detailsJson as Record<string, unknown> | null;
        expect(String(details?.summary ?? '')).toMatch(/journal entr/i);
        expect(details?.entityName).toBe('Treatment');
        expect((details?.before as Record<string, unknown>)?.complete).toBe(false);
    });
});

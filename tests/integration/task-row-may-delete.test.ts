/**
 * `mayDelete` on a task list row (#2395).
 *
 * `DELETE /tasks/{taskId}` refuses three cases, and the list row carried none of
 * the facts for them — so a client could not offer a delete control without
 * offering it on rows the server refuses.
 *
 * ## WHAT THIS FILE CANNOT TEST, stated first because I assumed otherwise
 *
 * The task list is CACHED, and `cachedListRead`'s key carries the tenant, the
 * filters and a version — and NO caller. So a per-caller flag inside the cached
 * payload would be served to every other user of the same tenant for the TTL.
 *
 * **No test in this file can catch that.** `cachedListRead` opens with
 * `const redis = getRedis(); if (!redis) return opts.loader();` and there is no
 * Redis in the test environment, so every case here runs the UNCACHED path. I
 * wrote the two-callers case below believing it covered the hazard, mutated the
 * flag back inside the loader to check, and all eight tests passed.
 *
 * The placement is pinned instead by
 * `tests/guards/per-caller-flag-outside-the-cache.test.ts`, which the same
 * mutation DOES fail. What the two-callers case below still proves is worth
 * keeping — that the flag is derived per call from `ctx` rather than fixed per
 * row — it simply cannot prove where it is derived.
 *
 * The journal list has the same flags and no such hazard because it is not
 * cached at all, so there was no precedent to copy and copying its placement
 * would have been the bug.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { listTasks, listTasksPaginated } from '@/app-layer/usecases/task';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `tmd-${randomUUID().slice(0, 8)}`;
let ownerId = '', editorId = '', readerId = '', tenantId = '';
let mineId = '', theirsId = '', treatmentTaskId = '';

const asOwner = () => makeRequestContext('OWNER', { userId: ownerId, tenantId, tenantSlug: `${TAG}-t` });
const asEditor = () => makeRequestContext('EDITOR', { userId: editorId, tenantId, tenantSlug: `${TAG}-t` });
const asReader = () => makeRequestContext('READER', { userId: readerId, tenantId, tenantSlug: `${TAG}-t` });

interface Row { id: string; mayDelete?: boolean }
const rowsFor = async (ctx: ReturnType<typeof asOwner>): Promise<Row[]> =>
    (await listTasks(ctx, {})) as unknown as Row[];
const find = (rows: Row[], id: string) => rows.find((r) => r.id === id);

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const mk = async (label: string) => {
        const email = `${TAG}-${label}@ag.test`;
        return (await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email), name: `${label} ${TAG}` },
        })).id;
    };
    ownerId = await mk('owner');
    editorId = await mk('editor');
    readerId = await mk('reader');
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    for (const [uid, role] of [
        [ownerId, Role.OWNER],
        [editorId, Role.EDITOR],
        [readerId, Role.READER],
    ] as const) {
        await globalPrisma.tenantMembership.create({
            data: { tenantId, userId: uid, role, status: MembershipStatus.ACTIVE },
        });
    }
    // Created by the EDITOR, so the editor is its creator and the owner is an
    // admin — the two ways `canDeleteTask` says yes.
    mineId = (await globalPrisma.task.create({
        data: { tenantId, title: `Mine ${TAG}`, type: 'FARM_TASK', createdByUserId: editorId, assigneeUserId: editorId },
    })).id;
    // Created by the READER, so the editor is neither creator nor admin for it.
    theirsId = (await globalPrisma.task.create({
        data: { tenantId, title: `Theirs ${TAG}`, type: 'FARM_TASK', createdByUserId: readerId, assigneeUserId: editorId },
    })).id;
    // One block's share of a recorded treatment — created BY the editor, so the
    // only thing that can refuse it is the 409 routing rule.
    treatmentTaskId = (await globalPrisma.task.create({
        data: {
            tenantId,
            title: `Block share ${TAG}`,
            type: 'FIELD_OPERATION',
            createdByUserId: editorId,
            assigneeUserId: editorId,
            treatmentGroupId: `${TAG}-handle`,
        },
    })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const t of ['TaskLink', 'Task', 'TreatmentGroup', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        for (const u of [ownerId, editorId, readerId]) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, u);
        }
    } catch (e) {
        console.warn('[task-row-may-delete] cleanup error:', e);
    }
    await globalPrisma.$disconnect();
});

describeFn('mayDelete on a task list row (#2395)', () => {
    it('true for the row the caller created', async () => {
        expect(find(await rowsFor(asEditor()), mineId)?.mayDelete).toBe(true);
    });

    it('false for a row somebody else created', async () => {
        // The 403 arm: `TASK_DELETE_NOT_PERMITTED`.
        expect(find(await rowsFor(asEditor()), theirsId)?.mayDelete).toBe(false);
    });

    it('true for an admin on a row they did not create', async () => {
        expect(find(await rowsFor(asOwner()), theirsId)?.mayDelete).toBe(true);
    });

    it("omits a treatment's block share from the list entirely (#2696)", async () => {
        // SUPERSEDED, and in the stronger direction. This asserted
        // `mayDelete === false` on a treatment's block share — the 409 arm,
        // `TASK_BELONGS_TO_TREATMENT`, which binds administrators too. #2696
        // then stopped those rows reaching any person-facing list at all,
        // because a diary record's container tasks are bookkeeping rather than
        // the farm's work, so there is no longer a row here to carry a flag.
        //
        // Absence is a stronger claim than `mayDelete: false`, so the test
        // moves rather than being deleted — and asserting the ROW is absent
        // rather than `?.mayDelete` being undefined matters: the optional
        // chain would also be undefined for a row that was present and simply
        // missing the field, which is the opposite of what this now proves.
        //
        // What is NOT weakened: the 409 still binds a DIRECT open by id — that
        // is `assertTaskIsNotTreatmentShare` (#2220), reached from the route
        // rather than the list — and `withMayDelete`'s treatment-share arm is
        // still exercised by `tests/unit/usecases/task.test.ts` and
        // `tests/unit/parcel-tasks.test.ts`, which call it directly instead of
        // through a list that now filters. Checked before moving this, because
        // a superseded test that takes the last coverage of a rule with it is
        // how a rule stops being enforced.
        expect(find(await rowsFor(asEditor()), treatmentTaskId)).toBeUndefined();
        expect(find(await rowsFor(asOwner()), treatmentTaskId)).toBeUndefined();

        // The control: the list is not simply empty. A filter that dropped
        // every row would satisfy the two absences above perfectly.
        expect(find(await rowsFor(asEditor()), mineId)?.mayDelete).toBe(true);
    });

    it('false for every row when the caller cannot write tasks at all', async () => {
        // The gate `assertCanWriteTasks` applies first. A READER can see the
        // list; a flag that ignored the role would promise a delete to someone
        // the route refuses before authorship is even considered.
        const rows = await rowsFor(asReader());
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.mayDelete === false)).toBe(true);
    });

    it('does NOT leak the fields it was computed from', async () => {
        // `taskListSelect` projects `createdByUserId` and `treatmentGroupId` for
        // the computation; the row is documented as twelve fields plus the flag,
        // and `.passthrough()` means the schema would not have objected.
        const row = find(await rowsFor(asEditor()), mineId) as unknown as Record<string, unknown>;
        expect(Object.keys(row)).toContain('mayDelete');
        expect(Object.keys(row)).not.toContain('createdByUserId');
        expect(Object.keys(row)).not.toContain('treatmentGroupId');
    });

    it('two callers, same filters: the flag follows the CALLER, not the row', async () => {
        // What this proves: `mayDelete` is derived from `ctx` on each call, so
        // the same row answers differently for two people.
        //
        // What it does NOT prove, and what I first thought it did: that the
        // derivation happens outside the cache. There is no Redis here, so the
        // cached path is never taken and the mutation that moves the flag into
        // the loader passes this file entirely. See the file docblock, and
        // `tests/guards/per-caller-flag-outside-the-cache.test.ts` for the test
        // that does fail it.
        const editorRows = await rowsFor(asEditor());
        const readerRows = await rowsFor(asReader());
        expect(find(editorRows, mineId)?.mayDelete).toBe(true);
        expect(find(readerRows, mineId)?.mayDelete).toBe(false);
        // And back again — cheap, and it would catch a decorator that mutated
        // its input rather than mapping it.
        expect(find(await rowsFor(asEditor()), mineId)?.mayDelete).toBe(true);
    });

    it('the PAGINATED list carries it too', async () => {
        // Both routes, because a client should not have to know which list it is
        // talking to in order to know whether to draw a delete.
        const page = (await listTasksPaginated(asEditor(), { limit: 50 })) as unknown as { items: Row[] };
        expect(find(page.items, mineId)?.mayDelete).toBe(true);
        expect(find(page.items, theirsId)?.mayDelete).toBe(false);
    });
});

/**
 * #3063 — a bulk-delete refusal names WHICH tasks it refused, not just how
 * many.
 *
 * Raised by the agrent-ios session building the multi-select (their #626).
 * Both refusals already carried `params: { refused, selected }`, which lets a
 * client say «three of twenty were refused» and then leaves the farmer to find
 * the three. On a screen with «Избери всички» that selection may be a hundred
 * rows, and because the call is ALL-OR-NOTHING every one of them stays put —
 * so the only way forward is to untick exactly the offending ids.
 *
 * ## Why `details` and not `params`
 *
 * `ErrorParams` is `Record<string, string | number>` on purpose: named values
 * a client interpolates into its own TRANSLATED sentence. A list has nowhere
 * to go there, and a comma-joined string would satisfy the type while being
 * neither interpolatable copy nor a list a client can use without re-parsing
 * it. So the channels divide by purpose — `params` carries the counts the
 * sentence needs, `details` carries the ids the client acts on.
 *
 * ## What this file does NOT change
 *
 * All-or-nothing stands (owner ruling, reaffirmed 2026-11-15). Every case here
 * asserts that nothing was deleted alongside the ids, because the ids are only
 * useful if the rows are still there to untick — and a future "partial
 * success" change would make these assertions fail rather than quietly make
 * the payload misleading.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { bulkDeleteTask } from '@/app-layer/usecases/task';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `bdr-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
/** The caller: an EDITOR, so the creator-or-admin rule actually binds. */
let meId = '';
/** A colleague, whose tasks the caller may not delete. */
let otherId = '';

/** EDITOR, not OWNER — `canAdmin` would short-circuit the whole rule. */
const ctx = () =>
    makeRequestContext('EDITOR', { userId: meId, tenantId: TENANT_ID, tenantSlug: TAG });

async function mkTask(opts: {
    author: string;
    treatmentGroupId?: string | null;
}): Promise<string> {
    const row = await prisma.task.create({
        data: {
            tenantId: TENANT_ID,
            title: `t-${randomUUID().slice(0, 6)}`,
            type: 'TASK',
            createdByUserId: opts.author,
            ...(opts.treatmentGroupId ? { treatmentGroupId: opts.treatmentGroupId } : {}),
        },
        select: { id: true },
    });
    return row.id;
}

/** How many of these ids are still undeleted — the all-or-nothing control. */
async function aliveCount(ids: string[]): Promise<number> {
    return prisma.task.count({ where: { id: { in: ids }, deletedAt: null } });
}

function thrownBy(e: unknown): { code: string; params?: unknown; details?: unknown } {
    const err = e as { code: string; params?: unknown; details?: unknown };
    return { code: err.code, params: err.params, details: err.details };
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: TENANT_ID, slug: TAG },
    });
    for (const which of ['me', 'other'] as const) {
        const email = `${TAG}-${which}@example.test`;
        const u = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        if (which === 'me') meId = u.id; else otherId = u.id;
        await prisma.tenantMembership.create({
            data: {
                tenantId: TENANT_ID,
                userId: u.id,
                role: which === 'me' ? Role.EDITOR : Role.EDITOR,
                status: MembershipStatus.ACTIVE,
            },
        });
    }
});

/*
 * The tenant, its users and its tasks are LEFT BEHIND, matching
 * `task-delete-is-soft.test.ts` next door — and the reason is this file's own
 * subject, which is worth writing down because the first draft got it wrong.
 *
 * A teardown that called `prisma.task.deleteMany(...)` left every row in
 * place: `Task` is soft-deleted, so the extension turned it into an UPDATE and
 * the rows went on pinning their users through `Task_createdByUserId_fkey`.
 * The `TASK_DELETED` audit rows this suite writes pin them too, through
 * `AuditLog_userId_fkey`. So `user.deleteMany` failed with «Foreign key
 * constraint violated on the (not available)» — a real FK whose name the
 * adapter could not surface, which reads exactly like the trigger case.
 *
 * Hard-deleting properly would mean raw SQL plus removing audit rows, i.e.
 * breaking a tamper-evident trail to tidy a test. Every row here is tagged
 * with a unique `TAG`, so nothing can collide with another run or another
 * suite.
 */
afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$disconnect();
});

describeFn('#3063 — a bulk-delete refusal names the refused ids', () => {
    it('403 names EXACTLY the tasks created by somebody else', async () => {
        const mine = [await mkTask({ author: meId }), await mkTask({ author: meId })];
        const theirs = [await mkTask({ author: otherId })];
        const all = [...mine, ...theirs];

        const err = await bulkDeleteTask(ctx(), all).then(
            () => { throw new Error('expected a refusal'); },
            (e) => thrownBy(e),
        );

        expect(err.code).toBe('TASK_DELETE_NOT_PERMITTED');
        // The ids, which is the point of this file.
        expect(err.details).toEqual({ refusedTaskIds: theirs });
        // The counts still there — additive, so a client built on them is
        // untouched.
        expect(err.params).toEqual({ refused: 1, selected: 3 });
        // ALL-OR-NOTHING: the ids are only actionable because the rows remain.
        expect(await aliveCount(all)).toBe(3);
    });

    it('409 names EXACTLY the treatment shares', async () => {
        const plain = [await mkTask({ author: meId })];
        const share = [await mkTask({ author: meId, treatmentGroupId: `tg-${randomUUID()}` })];
        const all = [...plain, ...share];

        const err = await bulkDeleteTask(ctx(), all).then(
            () => { throw new Error('expected a refusal'); },
            (e) => thrownBy(e),
        );

        expect(err.code).toBe('TASK_BELONGS_TO_TREATMENT');
        // ONE spelling across both refusals, deliberately: a client handling
        // two refusals should not need two parsers.
        expect(err.details).toEqual({ refusedTaskIds: share });
        expect(err.params).toEqual({ refused: 1, selected: 2 });
        expect(await aliveCount(all)).toBe(2);
    });

    it('the details carry task ids ONLY — never the colleague who made them', async () => {
        const theirs = await mkTask({ author: otherId });

        const err = await bulkDeleteTask(ctx(), [theirs]).then(
            () => { throw new Error('expected a refusal'); },
            (e) => thrownBy(e),
        );

        // Naming the author would answer a question nobody asked and put a
        // person into an error payload, which is the line `ErrorParams` draws
        // for exactly this reason. Asserted on the SERIALISED form, because a
        // nested field is what a key-by-key check would miss.
        const wire = JSON.stringify({ params: err.params, details: err.details });
        expect(wire).not.toContain(otherId);
        expect(wire).toContain(theirs);
    });

    it('a clean selection still deletes and still reports a count', async () => {
        // The positive control. Every case above is a refusal, and a suite of
        // only refusals passes just as well when nothing can be deleted at
        // all — which is the shape P8.1's recursion bug hid behind.
        const mine = [await mkTask({ author: meId }), await mkTask({ author: meId })];

        await expect(bulkDeleteTask(ctx(), mine)).resolves.toEqual({ deleted: 2 });
        expect(await aliveCount(mine)).toBe(0);
    });

    it('an id this tenant does not own is filtered out, not refused', async () => {
        const mine = await mkTask({ author: meId });

        // Idempotency, as the iOS session asked: a repeat must be harmless.
        // An unknown id is not something to fail over — it was never theirs to
        // delete, and refusing would make a retry after a partial network
        // failure impossible.
        await expect(bulkDeleteTask(ctx(), [mine, `t-nonexistent-${randomUUID()}`]))
            .resolves.toEqual({ deleted: 1 });
    });
});

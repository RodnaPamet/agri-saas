/**
 * #3026 — attaching a machine to a task, and taking it off.
 *
 * The read half shipped in #2948 stage 3b with its own docblock saying the
 * write was "an ADMIN action and a later stage". This is that stage, and the
 * suite is built around the four things the schema and the policy already
 * decide, so each assertion has something to be wrong about:
 *
 *   · idempotence is the `@@unique([taskId, assetId])` index, not a pre-read;
 *   · a cross-farm pairing is refused by the composite FK, and the usecase's
 *     job is to make that a readable 404 rather than a 500;
 *   · `machines.manage` is OWNER + ADMIN, and the path is under `farm-tasks`,
 *     which `isOperatorAllowedPath` ADMITS for the operator persona — so the
 *     permission check is the only thing keeping a MECHANISATOR out;
 *   · every refusal is paired with the same call by somebody entitled to make
 *     it, because P8.1 is the instance where three refusal cases passed while
 *     nothing could write at all.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { attachTaskAsset, detachTaskAsset, listTaskAssets } from '@/app-layer/usecases/task-machines';
import { hashForLookup } from '@/lib/security/encryption';
import type { RequestContext } from '@/app-layer/types';
import type { Role } from '@prisma/client';
import { makeRequestContext } from '../helpers/make-context';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const FARM = `t-tmw-${TAG}`;
const OTHER = `t-tmw-other-${TAG}`;
const USERS: Record<string, string> = {};
let taskId = '';
let tractor = '';
let handTool = '';
let otherFarmAsset = '';
let otherFarmTask = '';

/**
 * A context in this farm, for one role — built with the shared helper.
 *
 * `makeRequestContext` rather than an object literal, because `permissions`
 * (coarse: canRead/canWrite/…) and `appPermissions` (the granular set) are
 * DIFFERENT shapes and a hand-rolled literal gets one of them wrong silently.
 * My first version set `permissions` to the granular set, so `canWrite` was
 * `undefined` and every case failed on the coarse gate before reaching the
 * thing under test — a fixture that cannot express the scenario, which
 * `a-control-that-cannot-express-failure` names.
 */
function ctxFor(role: Role, tenantId = FARM): RequestContext {
    return makeRequestContext(role, { tenantId, userId: USERS[role] ?? `u-${role}` });
}

describeFn('#3026 — task machine writes', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.createMany({
            data: [
                { id: FARM, name: 'ЗК Задачи', slug: FARM },
                { id: OTHER, name: 'ЗК Чужда', slug: OTHER },
            ],
        });
        for (const role of ['OWNER', 'ADMIN', 'EDITOR', 'MECHANISATOR'] as const) {
            const id = `u-tmw-${role.toLowerCase()}-${TAG}`;
            USERS[role] = id;
            const email = `${id}@example.test`;
            await prisma.user.create({
                data: { id, email, emailHash: hashForLookup(email) },
            });
            await prisma.tenantMembership.create({
                data: { tenantId: FARM, userId: id, role, status: 'ACTIVE' },
            });
        }
        // The other farm needs an OWNER of its own: the last-OWNER trigger
        // refuses a tenant with none, and the cross-farm cases need it to be a
        // real farm rather than an empty row.
        const otherOwner = `u-tmw-other-${TAG}`;
        const otherEmail = `${otherOwner}@example.test`;
        await prisma.user.create({
            data: { id: otherOwner, email: otherEmail, emailHash: hashForLookup(otherEmail) },
        });
        await prisma.tenantMembership.create({
            data: { tenantId: OTHER, userId: otherOwner, role: 'OWNER', status: 'ACTIVE' },
        });

        const t = await prisma.task.create({
            data: {
                tenantId: FARM,
                title: `Сеитба ${TAG}`,
                status: 'OPEN',
                createdByUserId: USERS.OWNER,
            },
            select: { id: true },
        });
        taskId = t.id;
        const a = await prisma.asset.create({
            data: { tenantId: FARM, name: 'Трактор задача', type: 'TRACTOR' },
            select: { id: true },
        });
        tractor = a.id;
        const h = await prisma.asset.create({
            data: { tenantId: FARM, name: 'Ръчен инструмент', type: 'TOOL' },
            select: { id: true },
        });
        handTool = h.id;
        const o = await prisma.asset.create({
            data: { tenantId: OTHER, name: 'Чужд трактор', type: 'TRACTOR' },
            select: { id: true },
        });
        otherFarmAsset = o.id;
        const ot = await prisma.task.create({
            data: {
                tenantId: OTHER,
                title: `Чужда задача ${TAG}`,
                status: 'OPEN',
                createdByUserId: otherOwner,
            },
            select: { id: true },
        });
        otherFarmTask = ot.id;
    }, 120_000);

    afterAll(async () => {
        await prisma.taskAsset.deleteMany({ where: { tenantId: { in: [FARM, OTHER] } } });
        await prisma.task.deleteMany({ where: { tenantId: { in: [FARM, OTHER] } } });
        await prisma.asset.deleteMany({ where: { tenantId: { in: [FARM, OTHER] } } });
        /*
         * Memberships, users and tenants STAY — deleting the membership trips
         * `P0001 LAST_OWNER_GUARD`, the trigger that exists so a tenant cannot
         * be left ownerless. Every identifier is TAG-scoped to one run.
         */
        await prisma.$disconnect();
    }, 60_000);

    const rows = () =>
        prisma.taskAsset.findMany({ where: { taskId, tenantId: FARM }, select: { assetId: true } });

    beforeEach(async () => {
        await prisma.taskAsset.deleteMany({ where: { tenantId: { in: [FARM, OTHER] } } });
    });

    describe('§1 the write works, so the refusals below mean something', () => {
        it('attaches a machine, and the READ returns it', async () => {
            const out = await attachTaskAsset(ctxFor('ADMIN'), taskId, tractor);
            expect(out).toEqual({ attached: true, alreadyAttached: false });

            expect((await rows()).map((r) => r.assetId)).toEqual([tractor]);
            // The read half is what makes the write observable — a write whose
            // effect no read returns is the shape P9.3 shipped three times.
            const view = await listTaskAssets(ctxFor('ADMIN'), taskId);
            expect(view.assets.map((a) => a.assetId)).toEqual([tractor]);
        });

        it('detaches it again, and the read goes empty', async () => {
            await attachTaskAsset(ctxFor('OWNER'), taskId, tractor);
            const out = await detachTaskAsset(ctxFor('OWNER'), taskId, tractor);
            expect(out).toEqual({ detached: true, wasAttached: true });
            expect(await rows()).toHaveLength(0);
        });
    });

    describe('§2 idempotence is the INDEX, asserted as a row count', () => {
        it('attaching twice leaves ONE row and says it was already there', async () => {
            const first = await attachTaskAsset(ctxFor('ADMIN'), taskId, tractor);
            const second = await attachTaskAsset(ctxFor('ADMIN'), taskId, tractor);

            expect(first.alreadyAttached).toBe(false);
            expect(second.alreadyAttached).toBe(true);
            // The COUNT is the assertion. A second row would satisfy both
            // return values above and break every read that assumes one.
            expect(await rows()).toHaveLength(1);
        });

        it('two attaches AT ONCE both succeed and leave ONE row', async () => {
            /*
             * THIS CASE FOUND A DEFECT, which is why it is here rather than
             * being decoration on a sequential idempotence test.
             *
             * `upsert` was the first spelling, and Prisma's `upsert` is NOT
             * atomic for a compound unique — it reads, then inserts. Two
             * overlapping transactions both miss and the loser raises P2002:
             * measured, this case failed 2 runs in 4 with `Unique constraint
             * failed on …TaskAsset_taskId_assetId_key` naming the upsert.
             *
             * `createMany` + `skipDuplicates` compiles to `ON CONFLICT DO
             * NOTHING`, so the database resolves the collision and `count`
             * says which side of it a call was on. Five consecutive runs green
             * after the change.
             *
             * The phone produces this race routinely: it is an outbox client on
             * rural LTE, so a request that times out is retried while the first
             * may still be in flight. A P2002 there is a 500 for work that in
             * fact succeeded, and an outbox item parked as poison on a phone
             * that was right to retry.
             */
            const [a, b] = await Promise.all([
                attachTaskAsset(ctxFor('ADMIN'), taskId, tractor),
                attachTaskAsset(ctxFor('ADMIN'), taskId, tractor),
            ]);

            expect(a.attached).toBe(true);
            expect(b.attached).toBe(true);
            expect(await rows()).toHaveLength(1);
        });

        it('detaching twice is not an error — the phone retries', async () => {
            await attachTaskAsset(ctxFor('ADMIN'), taskId, tractor);
            await detachTaskAsset(ctxFor('ADMIN'), taskId, tractor);
            const again = await detachTaskAsset(ctxFor('ADMIN'), taskId, tractor);
            expect(again).toEqual({ detached: true, wasAttached: false });
        });

        it('detaching something never attached is also not an error', async () => {
            const out = await detachTaskAsset(ctxFor('ADMIN'), taskId, handTool);
            expect(out).toEqual({ detached: true, wasAttached: false });
        });
    });

    describe('§3 the farm boundary — a readable refusal, not a 500', () => {
        it("refuses another farm's asset as NOT FOUND", async () => {
            await expect(attachTaskAsset(ctxFor('ADMIN'), taskId, otherFarmAsset)).rejects.toMatchObject({
                // The CODE, not the message: the prose is user-facing copy and
                // moves, while the code is the contract the phone branches on.
                code: 'ASSET_NOT_FOUND',
            });
            expect(await rows()).toHaveLength(0);
        });

        it("refuses another farm's task as NOT FOUND", async () => {
            await expect(attachTaskAsset(ctxFor('ADMIN'), otherFarmTask, tractor)).rejects.toMatchObject({
                // The CODE, not the message: the prose is user-facing copy and
                // moves, while the code is the contract the phone branches on.
                code: 'TASK_NOT_FOUND',
            });
        });

        it('and the SAME call inside this farm succeeds — the control', async () => {
            await expect(
                attachTaskAsset(ctxFor('ADMIN'), taskId, tractor),
            ).resolves.toMatchObject({ attached: true });
        });
    });

    describe('§4 a non-locatable asset is refused with a code the phone can act on', () => {
        it('refuses a hand tool', async () => {
            await expect(attachTaskAsset(ctxFor('ADMIN'), taskId, handTool)).rejects.toMatchObject({
                // The CODE, not the message: the prose is user-facing copy and
                // moves, while the code is the contract the phone branches on.
                code: 'ASSET_NOT_LOCATABLE',
            });
            expect(await rows()).toHaveLength(0);
        });

        it('accepts a tractor — the control for the type check', async () => {
            await expect(
                attachTaskAsset(ctxFor('ADMIN'), taskId, tractor),
            ).resolves.toMatchObject({ attached: true });
        });
    });

    describe('§5 the role matrix, with the operator persona named explicitly', () => {
        it('a MECHANISATOR cannot attach — the path is one the middleware ADMITS them to', async () => {
            await expect(attachTaskAsset(ctxFor('MECHANISATOR'), taskId, tractor)).rejects.toThrow();
            expect(await rows()).toHaveLength(0);
        });

        it('an EDITOR cannot attach either', async () => {
            await expect(attachTaskAsset(ctxFor('EDITOR'), taskId, tractor)).rejects.toThrow();
            expect(await rows()).toHaveLength(0);
        });

        it('a MECHANISATOR cannot DETACH a machine somebody else attached', async () => {
            await attachTaskAsset(ctxFor('ADMIN'), taskId, tractor);
            await expect(
                detachTaskAsset(ctxFor('MECHANISATOR'), taskId, tractor),
            ).rejects.toThrow();
            // The row survives, which is the assertion: a refused DELETE under
            // RLS also affects zero rows and returns normally, so "it threw"
            // and "it did nothing" are different claims.
            expect(await rows()).toHaveLength(1);
        });

        it('OWNER and ADMIN both can — the positives the four negatives rest on', async () => {
            await expect(
                attachTaskAsset(ctxFor('OWNER'), taskId, tractor),
            ).resolves.toMatchObject({ attached: true });
            await expect(
                detachTaskAsset(ctxFor('ADMIN'), taskId, tractor),
            ).resolves.toMatchObject({ wasAttached: true });
        });
    });
});

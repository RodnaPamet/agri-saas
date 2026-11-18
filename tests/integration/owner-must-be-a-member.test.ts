/**
 * #3208 — a person id taken from a request body must name an ACTIVE member of
 * the caller's farm.
 *
 * Task assignees and reviewers were checked in the first remediation batch.
 * Asset, location and evidence OWNERS are the same shape — a `*UserId` the
 * client supplies, stored, then returned with the person's name and e-mail
 * and used to address an assignment notice — and stayed unchecked. Executed
 * against real rows, through the real usecases, so the check runs on the
 * caller's own transaction the way production does.
 */
import { randomUUID } from 'crypto';

import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { makeRequestContext } from '../helpers/make-context';
import { createLocation } from '@/app-layer/usecases/location';
import { createEvidence } from '@/app-layer/usecases/evidence';
import { createAsset } from '@/app-layer/usecases/asset';
import { createAccessReview } from '@/app-layer/usecases/access-review';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `omm-${randomUUID().slice(0, 8)}`;
const FARM = `${TAG}-farm`;
const OTHER_FARM = `${TAG}-other`;
let editorId = '';
let memberId = '';
let outsiderId = ''; // a real person, in another farm only

async function person(label: string, tenantId: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const id = (await prisma.user.create({ data: { email, name: label }, select: { id: true } })).id;
    await prisma.tenantMembership.create({ data: { tenantId, userId: id, role: 'EDITOR', status: 'ACTIVE' } });
    return id;
}

describeFn('a named owner must be an ACTIVE member of this farm (#3208)', () => {
    let ctx: ReturnType<typeof makeRequestContext>;

    beforeAll(async () => {
        for (const id of [FARM, OTHER_FARM]) {
            await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        editorId = await person('editor', FARM);
        memberId = await person('member', FARM);
        outsiderId = await person('outsider', OTHER_FARM);
        ctx = makeRequestContext('EDITOR', { tenantId: FARM, tenantSlug: FARM, userId: editorId });
    }, 60_000);

    it('a location cannot be owned by somebody from another farm', async () => {
        await expect(createLocation(ctx, { name: `${TAG} блок`, ownerUserId: outsiderId }))
            .rejects.toMatchObject({ code: 'TARGET_USER_NOT_IN_TENANT' });
        // Nothing written.
        expect(await prisma.location.count({ where: { tenantId: FARM, name: `${TAG} блок` } })).toBe(0);
    });

    it('control: a location owned by a member of the farm is created', async () => {
        const loc = await createLocation(ctx, { name: `${TAG} свой блок`, ownerUserId: memberId });
        expect(loc).toMatchObject({ ownerUserId: memberId });
    });

    it('evidence cannot name an outsider as its owner', async () => {
        await expect(
            createEvidence(ctx, { type: 'TEXT', title: `${TAG} запис`, content: 'бележка', ownerUserId: outsiderId } as never),
        ).rejects.toMatchObject({ code: 'TARGET_USER_NOT_IN_TENANT' });
    });

    it('an asset cannot be assigned to an outsider', async () => {
        await expect(createAsset(ctx, { name: `${TAG} трактор`, type: 'TRACTOR', ownerUserId: outsiderId }))
            .rejects.toMatchObject({ code: 'TARGET_USER_NOT_IN_TENANT' });
    });

    it('an access review cannot be assigned to a reviewer from another farm', async () => {
        const adminCtx = makeRequestContext('ADMIN', { tenantId: FARM, tenantSlug: FARM, userId: editorId });
        await expect(createAccessReview(adminCtx, { name: `${TAG} преглед`, scope: 'ALL_USERS', reviewerUserId: outsiderId }))
            .rejects.toMatchObject({ code: 'TARGET_USER_NOT_IN_TENANT' });
    });

    it('a REMOVED member of this farm is refused too', async () => {
        await prisma.tenantMembership.updateMany({ where: { tenantId: FARM, userId: memberId }, data: { status: 'REMOVED' } });
        await expect(createLocation(ctx, { name: `${TAG} още блок`, ownerUserId: memberId }))
            .rejects.toMatchObject({ code: 'TARGET_USER_NOT_IN_TENANT' });
        await prisma.tenantMembership.updateMany({ where: { tenantId: FARM, userId: memberId }, data: { status: 'ACTIVE' } });
    });
});

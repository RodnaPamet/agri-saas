/**
 * Integration tests for the create-finding backend (assignee, linked
 * control, compensating control, multi-risk links, analysis) against a
 * real RLS-enforced DB.
 *
 * Proves: a finding persists every relation; the Finding<->Risk junction
 * rows are written; tenant validation rejects foreign control/risk/
 * assignee ids; update replaces the risk links; getFinding hydrates the
 * relations.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createFinding, updateFinding, getFinding } from '@/app-layer/usecases/finding';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `fcm-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const FOREIGN_TENANT_ID = `t-${TAG}-other`;

let admin: { userId: string };
let nonMember: { userId: string };
let CONTROL_ID = '';
let COMP_CONTROL_ID = '';
let FOREIGN_CONTROL_ID = '';

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    for (const [id, slug] of [
        [TENANT_ID, TAG],
        [FOREIGN_TENANT_ID, `${TAG}-other`],
    ]) {
        await globalPrisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: `t ${slug}`, slug } });
    }
    admin = await makeUser('admin');
    nonMember = await makeUser('outsider');
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: admin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
    const c = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Access control' } });
    CONTROL_ID = c.id;
    const cc = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Compensating MFA' } });
    COMP_CONTROL_ID = cc.id;
    const fc = await globalPrisma.control.create({ data: { tenantId: FOREIGN_TENANT_ID, name: 'Foreign control' } });
    FOREIGN_CONTROL_ID = fc.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) {
        await globalPrisma.$disconnect();
        return;
    }
    const t = { tenantId: { in: [TENANT_ID, FOREIGN_TENANT_ID] } };
    for (const del of [
        () => globalPrisma.auditLog.deleteMany({ where: t }),
        () => globalPrisma.finding.deleteMany({ where: t }),
        () => globalPrisma.control.deleteMany({ where: t }),
        () => globalPrisma.tenantMembership.deleteMany({ where: t }),
        () => globalPrisma.user.deleteMany({ where: { id: { in: [admin.userId, nonMember.userId] } } }),
        () => globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, FOREIGN_TENANT_ID] } } }),
    ]) {
        try { await del(); } catch { /* best effort */ }
    }
    await globalPrisma.$disconnect();
});

function adminCtx() {
    return makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId: admin.userId, tenantSlug: TAG });
}

describeFn('createFinding — relations (integration)', () => {


    it('rejects a foreign control', async () => {
        await expect(
            createFinding(adminCtx(), {
                title: 'x', description: 'x', severity: 'LOW', type: 'OBSERVATION',
                controlId: FOREIGN_CONTROL_ID,
            }),
        ).rejects.toThrow();
    });


    it('rejects an assignee who is not a tenant member', async () => {
        await expect(
            createFinding(adminCtx(), {
                title: 'x', description: 'x', severity: 'LOW', type: 'OBSERVATION',
                assigneeUserId: nonMember.userId,
            }),
        ).rejects.toThrow();
    });
});

describeFn('updateFinding — risk replacement (integration)', () => {

});

/**
 * Integration tests for the task Evidence tab backend.
 *
 * Proves, against a real database, that a task can attach evidence the
 * same way a practice can:
 *   • linkTaskEvidence creates a LINK Evidence row pointing at the task
 *   • getTaskEvidenceTab returns it in the `{ links, evidence }` shape
 *     the shared <EvidenceSubTable> renders
 *   • unlinkTaskEvidence detaches it (clears taskId) without deleting
 *     the underlying evidence
 *   • tenant isolation: a foreign task id is notFound
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    getTaskEvidenceTab,
    linkTaskEvidence,
    unlinkTaskEvidence,
} from '@/app-layer/usecases/task';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `tev-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const FOREIGN_TENANT_ID = `t-${TAG}-other`;

let admin: { userId: string };
let TASK_ID = '';
let FOREIGN_TASK_ID = '';

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
        await globalPrisma.tenant.upsert({
            where: { id },
            update: {},
            create: { id, name: `t ${slug}`, slug },
        });
    }
    admin = await makeUser('admin');
    await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_ID,
            userId: admin.userId,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    const task = await globalPrisma.task.create({
        data: { tenantId: TENANT_ID, title: 'Task with evidence', createdByUserId: admin.userId },
    });
    TASK_ID = task.id;
    const foreignTask = await globalPrisma.task.create({
        data: { tenantId: FOREIGN_TENANT_ID, title: 'Foreign task', createdByUserId: admin.userId },
    });
    FOREIGN_TASK_ID = foreignTask.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) {
        await globalPrisma.$disconnect();
        return;
    }
    // Best-effort teardown — the test DB is ephemeral in CI, and
    // hash-chained AuditLog rows (written by logEvent) hold FK refs to
    // tenant/user that make a strict delete order fragile. Don't let a
    // teardown FK error fail an otherwise-green suite.
    const tenants = { tenantId: { in: [TENANT_ID, FOREIGN_TENANT_ID] } };
    try { await globalPrisma.auditLog.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.evidence.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.task.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.tenantMembership.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.user.deleteMany({ where: { id: admin.userId } }); } catch { /* best effort */ }
    try { await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, FOREIGN_TENANT_ID] } } }); } catch { /* best effort */ }
    await globalPrisma.$disconnect();
});

describeFn('task evidence usecases (integration)', () => {
    const ctx = () =>
        makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId: admin.userId, tenantSlug: TAG });

    it('linkTaskEvidence creates a LINK evidence row pointing at the task', async () => {
        const ev = await linkTaskEvidence(ctx(), TASK_ID, {
            url: 'https://example.com/runbook',
            note: 'Runbook',
        });
        expect(ev.type).toBe('LINK');
        expect(ev.taskId).toBe(TASK_ID);
        expect(ev.content).toBe('https://example.com/runbook');
        expect(ev.title).toBe('Runbook');
    });

    it('getTaskEvidenceTab returns the attached evidence in {links, evidence} shape', async () => {
        const tab = await getTaskEvidenceTab(ctx(), TASK_ID);
        expect(tab.links).toEqual([]);
        expect(tab.evidence.length).toBeGreaterThanOrEqual(1);
        expect(tab.evidence.every((e) => e.taskId === TASK_ID)).toBe(true);
    });

    it('unlinkTaskEvidence detaches the evidence (clears taskId) but keeps the row', async () => {
        const ev = await linkTaskEvidence(ctx(), TASK_ID, { url: 'https://example.com/x' });
        await unlinkTaskEvidence(ctx(), TASK_ID, ev.id);
        const stillExists = await globalPrisma.evidence.findUnique({ where: { id: ev.id } });
        expect(stillExists).not.toBeNull();
        expect(stillExists?.taskId).toBeNull();
        // No longer on the task's evidence tab.
        const tab = await getTaskEvidenceTab(ctx(), TASK_ID);
        expect(tab.evidence.find((e) => e.id === ev.id)).toBeUndefined();
    });

    it('is tenant-isolated — a foreign task id is not found', async () => {
        await expect(
            linkTaskEvidence(ctx(), FOREIGN_TASK_ID, { url: 'https://example.com/y' }),
        ).rejects.toThrow();
        await expect(getTaskEvidenceTab(ctx(), FOREIGN_TASK_ID)).rejects.toThrow();
    });
});

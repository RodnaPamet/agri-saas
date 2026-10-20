/**
 * A bounced email undoing what it caused (DB-backed) — #1769 PR 2.
 *
 * #1753 measured the gap this closes: three DSA Art 16 alerts resolved
 * successfully, `notice-triage-alert` stamped `alertedAt` on each, all three
 * bounced minutes later, and nothing retried. `applyDeliveryFailure` is the
 * action; `OutboundMessage` (PR 1) is the join that makes it possible.
 *
 * What is asserted, each a decision rather than a mechanism:
 *
 *   1. The WHOLE digest is re-queued, not one report. One email covers N
 *      notices, so clearing one and leaving the rest is the "retries for one
 *      notice out of three" state the issue calls worse than no correlation.
 *   2. The failure is stamped on the correlation row even when the purpose has
 *      no action — an observability gap here would repeat #1753 in miniature.
 *   3. BOTH invite models are handled. The org path creates an `OrgInvite` and
 *      the tenant-admin paths a `TenantInvite`; recording one type for both
 *      would make `updateMany` match zero rows for half the invites the
 *      product sends, silently, because nothing reads the count.
 *   4. An uncorrelated message is a RETURN, not a throw — every email sent
 *      before PR 1 shipped has no row, and no retry will conjure one.
 *   5. Replaying the same event changes nothing. Resend retries, and the 500
 *      this route now answers on a failed action makes that likelier.
 */
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { applyDeliveryFailure } from '@/app-layer/notifications/apply-delivery-failure';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `bounce-${randomUUID().slice(0, 8)}`;
const mid = (s: string) => `${TAG}-${s}`;

let userId = '';
let tenantId = '';
let orgId = '';

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await prisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Bounce User' },
    })).id;
    tenantId = (await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    orgId = (await prisma.organization.create({ data: { name: `O ${TAG}`, slug: `${TAG}-o` } })).id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        await prisma.outboundMessage.deleteMany({ where: { messageId: { startsWith: TAG } } });
        await prisma.contentReport.deleteMany({ where: { subjectId: { startsWith: TAG } } });
        await prisma.tenantInvite.deleteMany({ where: { tenantId } });
        await prisma.orgInvite.deleteMany({ where: { organizationId: orgId } });
        await prisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" = $1`, orgId).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await prisma.$disconnect();
});

/** N reports, all already alerted — the state a digest leaves behind. */
async function alertedReports(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const r = await prisma.contentReport.create({
            data: {
                subjectKind: 'LISTING',
                subjectId: `${TAG}-subj-${i}`,
                reasonCode: 'ILLEGAL_CONTENT',
                alertedAt: new Date('2026-10-13T08:00:00.000Z'),
            },
            select: { id: true },
        });
        ids.push(r.id);
    }
    return ids;
}

const record = (messageId: string, purpose: string, subjectType: string | null, subjectIds: string[]) =>
    prisma.outboundMessage.create({
        data: { messageId, purpose, subjectType, subjectIds, recipientDomain: 'agrent.bg' },
    });

describeFn('a bounce undoes what the email caused', () => {
    it('re-queues the WHOLE digest, not one report', async () => {
        const ids = await alertedReports(3);
        const messageId = mid('digest');
        await record(messageId, 'notice-triage-alert', 'ContentReport', ids);

        const out = await applyDeliveryFailure({ messageId, kind: 'email.bounced' });

        expect(out.correlated).toBe(true);
        expect(out.purpose).toBe('notice-triage-alert');
        // The denominator: all three, so this cannot pass on one row.
        expect(out.reportsRequeued).toBe(3);
        const after = await prisma.contentReport.findMany({
            where: { id: { in: ids } },
            select: { alertedAt: true },
        });
        expect(after).toHaveLength(3);
        expect(after.every((r) => r.alertedAt === null)).toBe(true);
    });

    it('stamps the failure on the correlation row', async () => {
        const ids = await alertedReports(1);
        const messageId = mid('stamp');
        await record(messageId, 'notice-triage-alert', 'ContentReport', ids);

        await applyDeliveryFailure({ messageId, kind: 'email.complained', at: new Date('2026-10-20T10:00:00.000Z') });

        const row = await prisma.outboundMessage.findUnique({ where: { messageId } });
        expect(row?.failureKind).toBe('email.complained');
        expect(row?.failedAt?.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    });

    it('stamps the row even for a purpose with no action wired', async () => {
        const messageId = mid('noaction');
        await record(messageId, 'statement-dispatch', 'GrainStatement', ['stmt-1']);

        const out = await applyDeliveryFailure({ messageId, kind: 'email.bounced' });

        expect(out.correlated).toBe(true);
        expect(out.reportsRequeued).toBeUndefined();
        expect(out.invitesMarked).toBeUndefined();
        // The point of property 2: visible even with nothing to undo.
        const row = await prisma.outboundMessage.findUnique({ where: { messageId } });
        expect(row?.failedAt).not.toBeNull();
    });

    it('marks a TenantInvite undeliverable', async () => {
        const invite = await prisma.tenantInvite.create({
            data: {
                tenantId,
                email: `inv-${TAG}@x.test`,
                role: Role.READER,
                token: `tok-t-${TAG}`,
                invitedById: userId,
                expiresAt: new Date(Date.now() + 7 * 86_400_000),
            },
            select: { id: true },
        });
        const messageId = mid('tinvite');
        await record(messageId, 'invite', 'TenantInvite', [invite.id]);

        const out = await applyDeliveryFailure({ messageId, kind: 'email.bounced' });

        expect(out.invitesMarked).toBe(1);
        const after = await prisma.tenantInvite.findUnique({ where: { id: invite.id } });
        expect(after?.deliveryFailureKind).toBe('email.bounced');
        expect(after?.deliveryFailedAt).not.toBeNull();
    });

    it('marks an OrgInvite undeliverable — the OTHER model behind the same purpose', async () => {
        const invite = await prisma.orgInvite.create({
            data: {
                organizationId: orgId,
                email: `inv-o-${TAG}@x.test`,
                token: `tok-o-${TAG}`,
                invitedById: userId,
                expiresAt: new Date(Date.now() + 7 * 86_400_000),
            },
            select: { id: true },
        });
        const messageId = mid('oinvite');
        await record(messageId, 'invite', 'OrgInvite', [invite.id]);

        const out = await applyDeliveryFailure({ messageId, kind: 'email.bounced' });

        // Would be 0 if the sender recorded one subject type for both kinds —
        // the bug this test exists to pin, and it fails silently without it
        // because updateMany reports a count nobody was reading.
        expect(out.invitesMarked).toBe(1);
        const after = await prisma.orgInvite.findUnique({ where: { id: invite.id } });
        expect(after?.deliveryFailureKind).toBe('email.bounced');
    });

    it('returns rather than throws for an uncorrelated message', async () => {
        const out = await applyDeliveryFailure({ messageId: mid('never-recorded'), kind: 'email.bounced' });
        expect(out.correlated).toBe(false);
        expect(out.purpose).toBeUndefined();
    });

    it('is idempotent on a replayed event', async () => {
        const ids = await alertedReports(2);
        const messageId = mid('replay');
        await record(messageId, 'notice-triage-alert', 'ContentReport', ids);

        const first = await applyDeliveryFailure({ messageId, kind: 'email.bounced' });
        const second = await applyDeliveryFailure({ messageId, kind: 'email.bounced' });

        expect(first.reportsRequeued).toBe(2);
        // Still 2: updateMany re-matches the same rows and sets the same null.
        // A counter or an append would drift here.
        expect(second.reportsRequeued).toBe(2);
        const after = await prisma.contentReport.findMany({
            where: { id: { in: ids } },
            select: { alertedAt: true },
        });
        expect(after.every((r) => r.alertedAt === null)).toBe(true);
    });
});

/**
 * Resetting the cost register (agrent-ios #610, owner ruling 2026-11-15).
 *
 * ## Why this runs against a real database
 *
 * Every property is about what `updateMany` did to rows: how many it touched,
 * which farm's, whether a repeat moved a timestamp, and whether the invoice
 * survived. A mocked Prisma would assert the call shape and prove none of it,
 * and the property that matters most — that the other farm is untouched — is
 * expressible only against real rows belonging to two tenants.
 *
 * ## The gate is ADMIN, which is STRICTER than its per-row sibling
 *
 * `deleteCostEntry` asserts `assertCanWrite`, so an EDITOR may remove one
 * entry. Emptying the register is a different act, so this asserts
 * `assertCanAdmin`. Both directions are tested: an EDITOR is refused, and an
 * ADMIN succeeds in the same file — because "it threw" is satisfied equally by
 * a function that throws for everybody.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { resetCostRegister } from '@/app-layer/usecases/cost-entry';
import { hashForLookup } from '@/lib/security/encryption';

import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `creset-${randomUUID().slice(0, 8)}`;
let userId = '';

/*
 * A FRESH TENANT PAIR PER TEST, because audit rows cannot be cleaned up.
 *
 * `AuditLog` carries an `audit_log_immutable` trigger BEFORE DELETE OR UPDATE
 * — a hash-chained trail is not editable, which is the point of it. Prisma
 * reports that trigger as `Foreign key constraint violated on the (not
 * available)`, which sent the first draft of this file looking for an FK that
 * does not exist.
 *
 * So instead of clearing rows between tests, each test gets its own farms and
 * asserts over its own. That also means the tenants themselves are left
 * behind: the FK from `AuditLog.tenantId` would have to cascade into rows the
 * trigger refuses. Acceptable here — the test database is a per-run clone —
 * and deliberately not worked around, because the alternative is fighting an
 * immutability control to tidy a fixture.
 */
let MINE = '';
/** Another farm, whose register must survive my reset untouched. */
let THEIRS = '';

function ctxFor(tenantId: string, role = 'ADMIN') {
    return makeRequestContext(role, { tenantId, userId, tenantSlug: `${TAG}-slug` });
}

async function cost(tenantId: string, amount: string, extra: Record<string, unknown> = {}) {
    return prisma.costEntry.create({
        data: {
            tenantId,
            category: 'FUEL' as never,
            amount: amount as never,
            currency: 'EUR',
            incurredOn: new Date('2026-10-01T00:00:00.000Z'),
            ...extra,
        },
        select: { id: true },
    });
}

const live = (tenantId: string) =>
    prisma.costEntry.count({ where: { tenantId, deletedAt: null } });

describeFn('resetting the cost register (#610)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        const email = `${TAG}@example.test`;
        const u = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        userId = u.id;
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        const n = randomUUID().slice(0, 8);
        MINE = `t-${TAG}-${n}-mine`;
        THEIRS = `t-${TAG}-${n}-theirs`;
        await prisma.tenant.createMany({
            data: [
                { id: MINE, name: MINE, slug: `${TAG}-${n}-mine` },
                { id: THEIRS, name: THEIRS, slug: `${TAG}-${n}-theirs` },
            ],
        });
    });

    it('soft-deletes every live entry and reports the count', async () => {
        await cost(MINE, '100.00');
        await cost(MINE, '200.00');
        await cost(MINE, '300.00');

        const r = await resetCostRegister(ctxFor(MINE));

        expect(r).toEqual({ deleted: 3 });
        expect(await live(MINE)).toBe(0);
        // SOFT: the rows are still there, stamped. A hard delete would make
        // this zero, and a mistaken reset unrecoverable.
        expect(await prisma.costEntry.count({ where: { tenantId: MINE } })).toBe(3);
    }, 60_000);

    it('leaves ANOTHER farm untouched', async () => {
        await cost(MINE, '100.00');
        await cost(THEIRS, '500.00');
        await cost(THEIRS, '600.00');

        const r = await resetCostRegister(ctxFor(MINE));

        expect(r).toEqual({ deleted: 1 });
        // THE CONTROL that makes the count meaningful: the other farm's
        // register is intact, so something bounded the statement rather than
        // the statement finding only one row.
        expect(await live(THEIRS)).toBe(2);

        /*
         * WHICH LAYER enforces that is NOT proved here, and the mutation
         * sweep is what established it: removing `tenantId: ctx.tenantId`
         * from the repository clause leaves this test green, because
         * `runInTenantContext` binds RLS and the database scopes the UPDATE
         * on its own. The application-layer filter is defence in depth, which
         * is exactly what CLAUDE.md says it is — "makes error messages clear
         * when the app is working correctly".
         *
         * So the PROPERTY above is proved and the ATTRIBUTION is not. Making
         * it observable means dropping the policy on the test base, the way
         * `p8-9-hardening` proves its own isolation against RLS rather than
         * against the ORM. Not done here, and recorded rather than implied:
         * a comment claiming this line guards the clause would be false.
         */
    }, 60_000);

    it('does NOT re-stamp rows already deleted, and does not count them', async () => {
        const first = await cost(MINE, '100.00');
        await cost(MINE, '200.00');

        await resetCostRegister(ctxFor(MINE));
        const stamped = await prisma.costEntry.findUnique({
            where: { id: first.id }, select: { deletedAt: true },
        });

        const second = await resetCostRegister(ctxFor(MINE));

        // ZERO on the repeat: `deletedAt: null` in the `where` is what makes
        // the count honest. Without it this reports 2 again and claims to have
        // deleted rows it only touched.
        expect(second).toEqual({ deleted: 0 });
        const after = await prisma.costEntry.findUnique({
            where: { id: first.id }, select: { deletedAt: true },
        });
        // And the timestamp did not MOVE — somebody may be reading it as "when
        // was this removed".
        expect(after!.deletedAt!.toISOString()).toBe(stamped!.deletedAt!.toISOString());
    }, 60_000);

    it('leaves the INVOICE attachment alone, exactly as the per-row delete does', async () => {
        /*
         * A REAL `FileRecord`, because `CostEntry_invoiceFileId_fkey` is a
         * genuine foreign key — note the contrast with the audit trigger
         * above, which Prisma reported in the same words while naming no
         * constraint. A named constraint is an FK; "on the (not available)" is
         * a trigger.
         */
        const file = await prisma.fileRecord.create({
            data: {
                tenantId: MINE,
                pathKey: `invoices/${randomUUID()}.pdf`,
                originalName: 'faktura.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 1024,
                sha256: randomUUID().replace(/-/g, ''),
                uploadedByUserId: userId,
            },
            select: { id: true },
        });
        const withInvoice = await cost(MINE, '100.00', { invoiceFileId: file.id });

        await resetCostRegister(ctxFor(MINE));

        const row = await prisma.costEntry.findUnique({
            where: { id: withInvoice.id },
            select: { invoiceFileId: true, deletedAt: true },
        });
        // The owner's ruling: the bulk form matches `deleteCostEntry`, which
        // has never removed an invoice. The phone's spec asked for removal on
        // the belief that it did.
        expect(row!.invoiceFileId).toBe(file.id);
        // And the FILE ITSELF is still there, not merely the pointer.
        expect(await prisma.fileRecord.count({
            where: { id: file.id, deletedAt: null },
        })).toBe(1);
        expect(row!.deletedAt).not.toBeNull();
    }, 60_000);

    it('refuses an EDITOR, who may still delete entries one at a time', async () => {
        await cost(MINE, '100.00');

        await expect(resetCostRegister(ctxFor(MINE, 'EDITOR')))
            .rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN_FOR_ROLE' });
        // NOTHING was deleted by the refused call.
        expect(await live(MINE)).toBe(1);

        // THE PAIRING: an ADMIN on the same farm, same rows, succeeds — so the
        // refusal is the gate and not a function that throws for everybody.
        await expect(resetCostRegister(ctxFor(MINE, 'ADMIN')))
            .resolves.toEqual({ deleted: 1 });
    }, 60_000);

    it('refuses a READER and a MECHANISATOR too', async () => {
        await cost(MINE, '100.00');
        for (const role of ['READER', 'MECHANISATOR']) {
            await expect(resetCostRegister(ctxFor(MINE, role)))
                .rejects.toMatchObject({ code: 'ADMIN_FORBIDDEN_FOR_ROLE' });
        }
        expect(await live(MINE)).toBe(1);
    }, 60_000);

    it('writes ONE audit row naming the count, even when nothing was live', async () => {
        const r = await resetCostRegister(ctxFor(MINE));
        expect(r).toEqual({ deleted: 0 });

        const rows = await prisma.auditLog.findMany({
            where: { tenantId: MINE, action: 'COST_REGISTER_RESET' },
            select: { entity: true, detailsJson: true },
        });
        // Logged at ZERO: a reset that found nothing is still a decision, and
        // a trail recording only the non-empty ones cannot answer "did
        // anybody try".
        expect(rows).toHaveLength(1);
        expect(rows[0]!.entity).toBe('CostEntry');
        expect((rows[0]!.detailsJson as Record<string, unknown>).count).toBe(0);
    }, 60_000);

    it('writes ONE audit row for a batch of many, not one per entry', async () => {
        for (let i = 0; i < 5; i += 1) await cost(MINE, `${i + 1}0.00`);

        await resetCostRegister(ctxFor(MINE));

        const rows = await prisma.auditLog.findMany({
            where: { tenantId: MINE, action: 'COST_REGISTER_RESET' },
            select: { detailsJson: true },
        });
        // ONE: the act was one decision, and five rows would bury it.
        expect(rows).toHaveLength(1);
        expect((rows[0]!.detailsJson as Record<string, unknown>).count).toBe(5);
    }, 60_000);
});

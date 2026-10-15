/**
 * The REAL audit writers, driven with a secret in scope, and the stored row
 * scanned for it (#1882).
 *
 * ## The half #1784 could not cover
 *
 * `tests/guards/audit-details-carry-no-secrets.test.ts` scans all 220
 * `logEvent` call sites and fails on an identifier whose last path segment
 * names a secret. That is a NAME-level check on the call site, and its own
 * docblock says so: it cannot follow a value, so `details: summarise(x)` or a
 * spread hides whatever is inside.
 *
 * This is the other half. It calls `createApiKey` — which mints a plaintext
 * secret and writes its audit row in the SAME transaction — then reads the row
 * back out of Postgres and asserts the secret is not in it.
 *
 * ## Why this writer
 *
 * Of the three #1882 named, this one has a credential in scope that is
 * genuinely unrecoverable: the plaintext is returned once at creation, hashed
 * at rest, and never re-shown. If it reached the audit trail it would sit
 * there in a hash-chained, immutable table that deliberately resists deletion
 * — the one place a leaked secret cannot be cleaned up.
 *
 * ## Asserting the VALUE, not a pattern
 *
 * #1784's two deleted tests failed because they matched patterns against a
 * string the author typed. This takes the actual minted secret and looks for
 * THAT, so it cannot pass by the pattern being wrong — and it would catch a
 * leak of a secret whose shape nobody predicted.
 *
 * The positive control matters as much: the row must be FOUND and must carry
 * the key's NAME. Without that, a query returning nothing satisfies every
 * "secret is absent" assertion, which is the empty-population failure this
 * repo keeps meeting.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createApiKey } from '@/app-layer/usecases/api-keys';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `auditsec-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let USER_ID = '';

function ctx() {
    return makeRequestContext(Role.ADMIN, { userId: USER_ID, tenantId: TENANT_ID, tenantSlug: TAG });
}

async function seed(): Promise<void> {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
    });
    const email = `${TAG}@example.test`;
    const user = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    USER_ID = user.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: USER_ID, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
}

async function teardown(): Promise<void> {
    await globalPrisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT_ID } });
    // `session_replication_role` because AuditLog is append-only by trigger:
    // the same escape the sibling integration suites use for their teardown.
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
    });
    await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
    if (USER_ID) await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

describeFn('a real audit writer does not store the secret in scope (#1882)', () => {
    beforeAll(seed);
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });

    it('createApiKey: the minted plaintext is nowhere in its AuditLog row', async () => {
        const created = await createApiKey(ctx(), {
            name: `Key ${TAG}`,
            // A REAL scope — the usecase validates against the live list,
            // and 'read' is not one of them. Using the real validator rather
            // than a mock is what caught that.
            scopes: ['journal:read'],
        } as never);

        const plaintext = (created as { plaintext?: string }).plaintext ?? '';
        // The secret must actually exist, or the scan below is vacuous — the
        // control that separates "no leak" from "nothing was minted".
        expect(plaintext.length).toBeGreaterThan(16);

        const rows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entity: 'TenantApiKey' },
            select: { action: true, details: true, detailsJson: true, diffJson: true, metadataJson: true },
        });

        // POSITIVE CONTROL, first. A query that found nothing would satisfy
        // every absence assertion below, which is the empty-population failure
        // this repo keeps meeting.
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.map((r) => r.action)).toContain('API_KEY_CREATED');
        // And the row is about the right thing: it carries the key's NAME. If
        // it did not, this might be scanning some unrelated row.
        expect(JSON.stringify(rows)).toContain(`Key ${TAG}`);

        // THE assertion: the actual minted value, not a pattern. #1784's two
        // deleted tests matched patterns against a string their author typed,
        // so they could not fail on a secret whose shape nobody predicted.
        const serialised = JSON.stringify(rows);
        expect(serialised).not.toContain(plaintext);

        // Nor any substantial prefix of it: a writer that logged a "redacted"
        // key by truncation would pass the exact-match check while leaking the
        // part that makes it guessable.
        expect(serialised).not.toContain(plaintext.slice(0, 20));
    });

    it('the key HASH is not stored in the audit row either', async () => {
        // Weaker than the plaintext and still worth refusing: the hash is the
        // verifier, so an attacker holding it can confirm a guess offline. It
        // belongs in `TenantApiKey.keyHash` and nowhere else.
        const row = await globalPrisma.tenantApiKey.findFirst({
            where: { tenantId: TENANT_ID },
            select: { keyHash: true, keyPrefix: true },
        });
        expect(row?.keyHash).toBeTruthy();

        const rows = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, entity: 'TenantApiKey' },
            select: { details: true, detailsJson: true, diffJson: true, metadataJson: true },
        });
        expect(JSON.stringify(rows)).not.toContain(row!.keyHash);

        // The PREFIX is fine and is deliberately not asserted absent: it is
        // the non-secret handle an operator uses to recognise which key a row
        // is about, and refusing it would make the trail less useful for no
        // security gain.
        expect(row?.keyPrefix).toBeTruthy();
    });
});

/**
 * #3215 — a notice about an exchange MESSAGE captures the body only for a
 * reporter who is part of that conversation.
 *
 * `captureSnapshot` runs on the PRIVILEGED client. The `DIRECT_MESSAGE` arm
 * asserts the reporter is a participant (#2833); the `MESSAGE` arm read any
 * exchange message for anyone, including the anonymous route, which has no
 * reporter at all. So an id from a log, a screenshot or a farm the reporter had
 * left copied a private negotiation into the moderation queue, and the answer
 * was `{ id, RECEIVED }` either way.
 *
 * Every refusal here is paired with the same notice from somebody entitled to
 * file it, because "captured nothing" also satisfies every negative.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { prisma } from '@/lib/prisma';
import { encryptField } from '@/lib/security/encryption';
import { fileNotice } from '@/app-layer/usecases/trust-safety';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const S = randomUUID().slice(0, 8);

const SELLER_TENANT = `t-3215-s-${S}`;
const BUYER_TENANT = `t-3215-b-${S}`;
const SELLER = `u-3215-seller-${S}`;
const BUYER = `u-3215-buyer-${S}`;
const STRANGER = `u-3215-stranger-${S}`;
const LISTING = `el-3215-${S}`;
const THREAD = `et-3215-${S}`;
const MESSAGE = `em-3215-${S}`;
const filed: string[] = [];

async function snapshotFor(reportId: string) {
    return prisma.reportSnapshot.findFirstOrThrow({
        where: { reportId },
        select: { body: true, captureError: true },
    });
}

async function notice(reporter: string | null) {
    const r = await fileNotice(
        { subjectKind: 'MESSAGE', subjectId: MESSAGE, reasonCode: 'HARASSMENT_OR_HATE' },
        reporter,
    );
    filed.push(r.id);
    return snapshotFor(r.id);
}

describeFn('#3215 — reporting an exchange message', () => {
    beforeAll(async () => {
        await db.$executeRawUnsafe(
            `INSERT INTO "ExchangeListing"
               ("id","sellerTenantId","sellerUserId","side","kind","commodity",
                "quantityTonnes","regionCode","regionName","lat","lon","updatedAt")
             VALUES ($1,$2,$3,'SELL'::"ExchangeSide",'CULTURE'::"ExchangeKind",
                     'wheat',10,'BG-16','Пловдив',42.1,24.7,NOW())`,
            LISTING, SELLER_TENANT, SELLER,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "ExchangeThread" ("id","listingId","inquirerTenantId","inquirerUserId","updatedAt")
             VALUES ($1,$2,$3,$4,NOW())`,
            THREAD, LISTING, BUYER_TENANT, BUYER,
        );
        await db.$executeRawUnsafe(
            `INSERT INTO "ExchangeMessage" ("id","threadId","senderTenantId","senderUserId","body")
             VALUES ($1,$2,$3,$4,$5)`,
            MESSAGE, THREAD, BUYER_TENANT, BUYER, encryptField('частна оферта'),
        );
    });

    afterAll(async () => {
        if (filed.length) {
            await db.$executeRawUnsafe(`DELETE FROM "ReportSnapshot" WHERE "reportId" = ANY($1::text[])`, filed);
            await db.$executeRawUnsafe(`DELETE FROM "ContentReport" WHERE "id" = ANY($1::text[])`, filed);
        }
        await db.$executeRawUnsafe(`DELETE FROM "ExchangeMessage" WHERE "id" = $1`, MESSAGE);
        await db.$executeRawUnsafe(`DELETE FROM "ExchangeThread" WHERE "id" = $1`, THREAD);
        await db.$executeRawUnsafe(`DELETE FROM "ExchangeListing" WHERE "id" = $1`, LISTING);
        await db.$disconnect();
    });

    it('captures the body for a person in the conversation — the control', async () => {
        const snap = await notice(SELLER);
        expect(snap.captureError).toBeNull();
        expect(snap.body).toContain('частна оферта');
    });

    it('captures NOTHING for a stranger holding the id', async () => {
        const snap = await notice(STRANGER);
        expect(snap.captureError).toBe('SUBJECT_NOT_VISIBLE_TO_REPORTER');
        expect(snap.body ?? '').not.toContain('частна оферта');
    });

    it('captures NOTHING for an anonymous notice', async () => {
        const snap = await notice(null);
        expect(snap.captureError).toBe('SUBJECT_REQUIRES_A_REPORTER');
        expect(snap.body ?? '').not.toContain('частна оферта');
    });
});

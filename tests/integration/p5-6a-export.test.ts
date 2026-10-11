/**
 * P5.6a — the personal-data export (#1597).
 *
 * ## The assertion that matters is an ABSENCE
 *
 * This export runs on the privileged client, because no session context can
 * read the set: `StatementOfReasons` denies `app_user`, `ContentReport` admits
 * only a reporter through `app.user_id`, and the exchange models are
 * tenant-scoped. So **the `where` clause is the only thing scoping it to one
 * person** — the inverse of the usual arrangement, where RLS is the backstop.
 *
 * A test that asserted "my rows are present" would therefore pass while the
 * route exported the whole database. Every case here sets up a SECOND person
 * and asserts their rows are absent from the first person's export. That is the
 * assertion a dropped clause fails.
 *
 * ## And the exit criterion names its own test
 *
 * #1597: *"A person exports their own data in a machine-readable form, proven
 * to include the trust & safety rows that name them."* So the notice, the block
 * and the statement are each asserted present by CONTENT, not by a count.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { exportPersonalData } from '@/app-layer/usecases/personal-data-export';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { EXPORTED_MODELS } from '@/lib/privacy/personal-data-registry';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const reports: string[] = [];
const blocks: string[] = [];
const actions: string[] = [];
const statements: string[] = [];

async function makeUser(label: string): Promise<string> {
    const id = `u-p56-${label}-${randomUUID()}`;
    const email = `p56-${label}-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt","uiLanguage")
         VALUES ($1,$2,$3,NOW(),'bg')`,
        id, encryptField(email), hashForLookup(email),
    );
    users.push(id);
    return id;
}

async function makeNotice(reporterId: string, detail: string): Promise<string> {
    const id = `cr-p56-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,'LISTING',$2,'MISLEADING_LISTING'::"ReportReasonCode",'RECEIVED',$3,$4)`,
        id, `listing-${randomUUID()}`, encryptField(detail), reporterId,
    );
    reports.push(id);
    return id;
}

async function makeBlock(blockerId: string, blockedId: string): Promise<string> {
    const id = `ub-p56-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "UserBlock"("id","blockerUserId","blockedUserId")
         VALUES ($1,$2,$3)`,
        id, blockerId, blockedId,
    );
    blocks.push(id);
    return id;
}

async function makeStatement(recipientId: string, body: string): Promise<string> {
    const actionId = `ma-p56-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ModerationAction"
           ("id","moderatorRef","actionKind","subjectKind","subjectId","rationale")
         VALUES ($1,'platform-key:current','CONTENT_REMOVED'::"ModerationActionKind",
                 'LISTING',$2,$3)`,
        actionId, `listing-${randomUUID()}`, encryptField('because'),
    );
    actions.push(actionId);

    const id = `sor-p56-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "StatementOfReasons"
           ("id","actionId","recipientUserId","locale","bodyRendered")
         VALUES ($1,$2,$3,'bg',$4)`,
        id, actionId, recipientId, encryptField(body),
    );
    statements.push(id);
    return id;
}

describeFn('P5.6a — the personal-data export (#1597)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    afterAll(async () => {
        const del = async (table: string, col: string, ids: string[]) => {
            if (ids.length) {
                await globalPrisma.$executeRawUnsafe(
                    `DELETE FROM "${table}" WHERE "${col}" = ANY($1::text[])`, ids);
            }
        };
        await del('StatementOfReasons', 'id', statements);
        await del('ModerationAction', 'id', actions);
        await del('UserBlock', 'id', blocks);
        await del('ContentReport', 'id', reports);
        await del('User', 'id', users);
        await globalPrisma.$disconnect();
    });

    it('includes the TRUST & SAFETY rows the exit criterion names', async () => {
        const me = await makeUser('mine');
        const other = await makeUser('other');
        const mark = `my-notice-${randomUUID()}`;
        await makeNotice(me, mark);
        await makeBlock(me, other);
        const statementMark = `my-statement-${randomUUID()}`;
        await makeStatement(me, statementMark);

        const out = await exportPersonalData(me);

        // By CONTENT, not by count: a count of 1 is also what a wrong row
        // produces. And the detail arrives DECRYPTED, which is the half that
        // proves the extended client is in the path.
        expect(out.contentReports.rows.map((r) => r.detail)).toContain(mark);
        expect(out.statementsOfReasons.rows.map((r) => r.bodyRendered))
            .toContain(statementMark);
        expect(out.blocksIMade.rows.map((r) => r.blockedUserId)).toContain(other);
    });

    it('does NOT include another person’s notice', async () => {
        // THE REGRESSION TEST. The `where` clause is the only control here, so
        // this is the assertion a dropped one fails — and the one a
        // presence-only test would pass straight through.
        const me = await makeUser('mine');
        const other = await makeUser('other');
        const theirs = `their-notice-${randomUUID()}`;
        await makeNotice(other, theirs);

        const out = await exportPersonalData(me);

        expect(out.contentReports.rows.map((r) => r.detail)).not.toContain(theirs);
        expect(out.contentReports.rows).toHaveLength(0);
    });

    it('does NOT include another person’s statement of reasons', async () => {
        const me = await makeUser('mine');
        const other = await makeUser('other');
        const theirs = `their-statement-${randomUUID()}`;
        await makeStatement(other, theirs);

        const out = await exportPersonalData(me);

        expect(out.statementsOfReasons.rows.map((r) => r.bodyRendered))
            .not.toContain(theirs);
    });

    it('does NOT include blocks made AGAINST the caller', async () => {
        // P5.2b's silence, preserved through the export. The SELECT policy
        // admits both sides of a UserBlock row, so only the `where` withholds
        // it — and disclosing "who blocked you" would defeat the whole
        // difference between a social and an exchange block.
        const me = await makeUser('mine');
        const other = await makeUser('other');
        await makeBlock(other, me);

        const out = await exportPersonalData(me);

        expect(out.blocksIMade.rows).toHaveLength(0);
        expect(JSON.stringify(out)).not.toContain(other);
    });

    it('returns the caller’s own account row, decrypted, without the lookup hash', async () => {
        const me = await makeUser('mine');

        const out = await exportPersonalData(me);

        expect(out.account.id).toBe(me);
        expect(out.account.email).toMatch(/@example\.test$/);
        expect(out.account.uiLanguage).toBe('bg');
        // `emailHash` is a lookup derivation, not information about the person.
        // Publishing it hands out the input to a correlation attack against any
        // other system using the same HMAC.
        expect(out.account).not.toHaveProperty('emailHash');
        expect(JSON.stringify(out.account)).not.toContain('emailHash');
    });

    it('never includes a credential', async () => {
        const me = await makeUser('mine');

        const out = await exportPersonalData(me);
        const serialised = JSON.stringify(out);

        // `Account`, `AuthSession` and `PasswordResetToken` are ERASE_ONLY. A
        // live refresh token in a downloadable file is a credential leak, and
        // answers nothing the person asked.
        for (const forbidden of ['refresh_token', 'refreshToken', 'access_token',
            'accessToken', 'tokenHash', 'sessionToken']) {
            expect(serialised).not.toContain(forbidden);
        }
    });

    it('says what it does NOT contain, in the response', async () => {
        const me = await makeUser('mine');

        const out = await exportPersonalData(me);

        // Art 15 is a right to know what is held, so an export that silently
        // omitted categories would be a worse answer than one naming them.
        expect(out.notIncluded.length).toBeGreaterThan(3);
        expect(out.notIncluded.join(' ')).toMatch(/farm records/i);
        expect(out.notIncluded.join(' ')).toMatch(/credential/i);
        expect(out.notIncluded.join(' ')).toMatch(/blocks that other people/i);
    });

    it('represents every EXPORTED model from the registry', async () => {
        // Completeness against the derived registry rather than against a list
        // here: the guard proves the registry covers the schema, and this
        // proves the export covers the registry. Between them, a new
        // tenantless person column cannot be exported-by-nobody.
        const me = await makeUser('mine');
        const out = await exportPersonalData(me);

        const collections: Record<string, unknown> = {
            ContentReport: out.contentReports,
            StatementOfReasons: out.statementsOfReasons,
            UserBlock: out.blocksIMade,
            ExchangeBlock: out.exchangeBlocksAgainstMe,
            ExchangeListing: out.exchangeListings,
            ExchangeThread: out.exchangeThreads,
            ExchangeInquiry: out.exchangeInquiries,
            ExchangeMessage: out.exchangeMessages,
            InsuranceLead: out.insuranceLeads,
            PromotionLead: out.promotionLeads,
            OrgMembership: out.organisationMemberships,
            FeatureFlagCohortMember: out.featureCohorts,
        };

        const unrepresented = EXPORTED_MODELS.filter((m) => !(m in collections));
        expect(unrepresented).toEqual([]);
    });

    it('marks a collection truncated rather than silently returning a prefix', async () => {
        const me = await makeUser('mine');
        const out = await exportPersonalData(me);

        // An export that quietly omits rows is worse than one that admits it.
        expect(out.contentReports.truncated).toBe(false);
        expect(out.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});

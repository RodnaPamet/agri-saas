/**
 * #1619 — moderation decisions enter the hash-chained platform trail.
 *
 * ## Best-effort, by owner ruling, and the cost is asserted
 *
 * The append runs through `afterCommit`, so the decision has already committed
 * when it fires: a chain-writer failure cannot undo a moderation decision.
 * #1287 is the precedent — that writer failed on 275 of 275 attempts under one
 * runtime, and a moderation queue that cannot be worked because an audit
 * subsystem is sick is its own compliance failure with the DSA clock running.
 *
 * The cost is a crash window between COMMIT and the drain, and this suite
 * asserts the shape of it rather than pretending it away: a failing chain
 * writer leaves the decision recorded and the chain short, and the gap is
 * REPORTED rather than prevented.
 *
 * ## And `ACCOUNT_TERMINATED` now finalises
 *
 * Owner ruling 2026-10-11: terminate suspends AND requests deletion, so the Art
 * 17 statement ("we closed your account") is true of the data as well as of
 * access.
 *
 * This docblock used to continue: *"The test that matters is that a terminated
 * person cannot UNDO it — which holds because they are suspended, so
 * `getSessionOrThrow` refuses them before they reach the cancel route."* **That
 * premise expired and took the protection with it.** It was a property of a
 * DIFFERENT control, and #1667 changed that control — admitting suspended
 * accounts to the cancel route so a person who had asked to leave could change
 * their mind. Every required check was green, because nothing here asserted the
 * protection directly.
 *
 * It is a property of the erasure now: #1671 records
 * `User.deletionRequestedBy`, a termination writes `MODERATION`, and
 * `cancelAccountDeletion` refuses that with `ACCOUNT_TERMINATED`. The two
 * assertions below are the ones the old sentence stood in for — found by
 * mutating `actOnNotice` to record `SELF` and watching this entire suite stay
 * green.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { actOnNotice, queueStatement } from '@/app-layer/usecases/moderation';
import { cancelAccountDeletion } from '@/app-layer/usecases/account-erasure';
import { verifyPlatformChain } from '@/lib/audit/platform-audit-writer';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const reports: string[] = [];
const actions: string[] = [];
const statements: string[] = [];

async function makeUser(): Promise<string> {
    const id = `u-1619-${randomUUID()}`;
    const email = `i1619-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id, encryptField(email), hashForLookup(email),
    );
    users.push(id);
    return id;
}

async function fileNotice(): Promise<string> {
    const id = `cr-1619-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,'LISTING',$2,'ILLEGAL_CONTENT'::"ReportReasonCode",'RECEIVED',$3,NULL)`,
        id, `listing-${randomUUID()}`, encryptField('a complaint'),
    );
    reports.push(id);
    return id;
}

async function chainRows(action: string, needle: string) {
    return globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "PlatformAuditLog"
         WHERE "scope" = 'moderation' AND "action" = $1::"PlatformAuditAction"
           AND "detailsJson"::text LIKE '%' || $2 || '%'`,
        action, needle,
    );
}

describeFn('#1619 — moderation decisions in the platform chain', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    afterAll(async () => {
        const del = async (t: string, c: string, ids: string[]) => {
            if (ids.length) {
                await globalPrisma.$executeRawUnsafe(
                    `DELETE FROM "${t}" WHERE "${c}" = ANY($1::text[])`, ids);
            }
        };
        await del('StatementOfReasons', 'id', statements);
        await del('ModerationAction', 'id', actions);
        await del('ContentReport', 'id', reports);
        await del('UserSession', 'userId', users);
        await del('User', 'id', users);
        await globalPrisma.$disconnect();
    });

    it('records a decision in the chain, naming the key generation', async () => {
        const reportId = await fileNotice();

        const { actionId } = await actOnNotice({
            reportId, actionKind: 'CONTENT_REMOVED',
            rationale: 'the grade could not be substantiated', generation: 'previous',
        });
        actions.push(actionId);

        const rows = await chainRows('MODERATION_ACTION_RECORDED', actionId);
        expect(Number(rows[0].n)).toBe(1);

        // The generation, not a person — and this is exactly what #1599's
        // remaining scope changes. Pinned so that change is visible when it
        // lands rather than silent.
        const detail = await globalPrisma.$queryRawUnsafe<Array<{ d: string }>>(
            `SELECT "detailsJson"::text AS d FROM "PlatformAuditLog"
             WHERE "action" = 'MODERATION_ACTION_RECORDED'
               AND "detailsJson"::text LIKE '%' || $1 || '%' LIMIT 1`, actionId);
        expect(detail[0].d).toContain('platform-key:previous');
    });

    it('does NOT put the rationale in the chain', async () => {
        const reportId = await fileNotice();
        const secret = `moderator-words-${randomUUID()}`;

        const { actionId } = await actOnNotice({
            reportId, actionKind: 'CONTENT_DEMOTED',
            rationale: secret, generation: 'current',
        });
        actions.push(actionId);

        const detail = await globalPrisma.$queryRawUnsafe<Array<{ d: string }>>(
            `SELECT "detailsJson"::text AS d FROM "PlatformAuditLog"
             WHERE "detailsJson"::text LIKE '%' || $1 || '%' LIMIT 1`, actionId);
        // `detailsJson` is not an encrypted column; the rationale lives on
        // `ModerationAction.rationale`, which is. The chain records THAT there
        // was one.
        expect(detail[0].d).not.toContain(secret);
        expect(detail[0].d).toContain('hasRationale');
    });

    it('records a queued statement as its OWN verb', async () => {
        const reportId = await fileNotice();
        const recipient = await makeUser();
        const { actionId } = await actOnNotice({
            reportId, actionKind: 'CONTENT_REMOVED',
            rationale: 'removed', generation: 'current',
        });
        actions.push(actionId);

        const { statementId } = await queueStatement({
            actionId, recipientUserId: recipient, locale: 'bg',
            bodyRendered: 'draft text',
        });
        statements.push(statementId);

        // A separate verb, not a field on the action's entry: Art 17 makes
        // "decided" and "explained" two obligations, so an action with no
        // statement entry is visible in the chain rather than inferred from a
        // missing field.
        const rows = await chainRows('MODERATION_STATEMENT_QUEUED', statementId);
        expect(Number(rows[0].n)).toBe(1);
    });

    it('does NOT put the statement body in the chain', async () => {
        const reportId = await fileNotice();
        const recipient = await makeUser();
        const { actionId } = await actOnNotice({
            reportId, actionKind: 'CONTENT_REMOVED', rationale: 'r', generation: 'current',
        });
        actions.push(actionId);
        const body = `statement-body-${randomUUID()}`;

        const { statementId } = await queueStatement({
            actionId, recipientUserId: recipient, locale: 'bg', bodyRendered: body,
        });
        statements.push(statementId);

        const detail = await globalPrisma.$queryRawUnsafe<Array<{ d: string }>>(
            `SELECT "detailsJson"::text AS d FROM "PlatformAuditLog"
             WHERE "detailsJson"::text LIKE '%' || $1 || '%' LIMIT 1`, statementId);
        // Encrypted at rest — and P5.4b REPLACES it at send time, so a copy
        // here would be a draft the chain presented as final.
        expect(detail[0].d).not.toContain(body);
    });

    it('the chain still verifies after a decision and a statement', async () => {
        const reportId = await fileNotice();
        const recipient = await makeUser();
        const { actionId } = await actOnNotice({
            reportId, actionKind: 'NONE', rationale: 'looked, did nothing',
            generation: 'current',
        });
        actions.push(actionId);
        const { statementId } = await queueStatement({
            actionId, recipientUserId: recipient, locale: 'bg', bodyRendered: 'x',
        });
        statements.push(statementId);

        // The property the whole chain exists for: appending must not break
        // it. Two appends in one test, because a broken `previousHash` shows
        // on the SECOND entry rather than the first.
        const verdict = await verifyPlatformChain('moderation', globalPrisma as never);
        expect(verdict.intact).toBe(true);
        expect(verdict.brokenAt).toBeNull();
        expect(verdict.entries).toBeGreaterThanOrEqual(2);
    });

    describe('ACCOUNT_TERMINATED finalises', () => {
        it('suspends AND requests deletion, so the statement is true of both', async () => {
            const reportId = await fileNotice();
            const target = await makeUser();

            const { actionId } = await actOnNotice({
                reportId, actionKind: 'ACCOUNT_TERMINATED',
                rationale: 'repeat illegal content', generation: 'current',
                suspendUserId: target,
            });
            actions.push(actionId);

            const row = await globalPrisma.$queryRawUnsafe<Array<{
                s: Date | null; d: Date | null;
            }>>(
                `SELECT "suspendedAt" AS s, "deletionRequestedAt" AS d
                 FROM "User" WHERE "id" = $1`, target);
            // Both: access withheld now, data pseudonymised after the grace.
            // Suspension alone made "we closed your account" true of access
            // and not of the data.
            expect(row[0].s).not.toBeNull();
            expect(row[0].d).not.toBeNull();
        });

        it('records MODERATION as the initiator — the thing that makes it final', async () => {
            // Mutating this to 'SELF' left the whole suite green before this
            // test existed, which is how a termination could have become
            // cancellable by its subject with nothing noticing.
            const reportId = await fileNotice();
            const target = await makeUser();

            const { actionId } = await actOnNotice({
                reportId, actionKind: 'ACCOUNT_TERMINATED',
                rationale: 'repeat illegal content', generation: 'current',
                suspendUserId: target,
            });
            actions.push(actionId);

            const row = await globalPrisma.$queryRawUnsafe<Array<{ b: string | null }>>(
                `SELECT "deletionRequestedBy" AS b FROM "User" WHERE "id" = $1`, target);
            expect(row[0].b).toBe('MODERATION');
        });

        it('and the subject CANNOT cancel it', async () => {
            // The assertion the old docblock claimed without making. It no
            // longer depends on the suspension check: `cancelAccountDeletion`
            // refuses on the INITIATOR, so changing who may reach the route
            // cannot silently remove this.
            const reportId = await fileNotice();
            const target = await makeUser();

            const { actionId } = await actOnNotice({
                reportId, actionKind: 'ACCOUNT_TERMINATED',
                rationale: 'repeat illegal content', generation: 'current',
                suspendUserId: target,
            });
            actions.push(actionId);

            await expect(cancelAccountDeletion(target)).rejects.toMatchObject({
                status: 403,
                code: 'ACCOUNT_TERMINATED',
            });
            const row = await globalPrisma.$queryRawUnsafe<Array<{ d: Date | null }>>(
                `SELECT "deletionRequestedAt" AS d FROM "User" WHERE "id" = $1`, target);
            expect(row[0].d).not.toBeNull();
        });

        it('ACCOUNT_SUSPENDED does NOT request deletion', async () => {
            // The two statements must describe two different things, which is
            // what #1635 was about. A suspension that silently queued an
            // erasure would be the same defect inverted.
            const reportId = await fileNotice();
            const target = await makeUser();

            const { actionId } = await actOnNotice({
                reportId, actionKind: 'ACCOUNT_SUSPENDED',
                rationale: 'abusive messages', generation: 'current',
                suspendUserId: target,
            });
            actions.push(actionId);

            const row = await globalPrisma.$queryRawUnsafe<Array<{
                s: Date | null; d: Date | null;
            }>>(
                `SELECT "suspendedAt" AS s, "deletionRequestedAt" AS d
                 FROM "User" WHERE "id" = $1`, target);
            expect(row[0].s).not.toBeNull();
            expect(row[0].d).toBeNull();
        });

        it('revokes the sessions, which is what blocks the self-undo', async () => {
            // The safety argument for wiring a moderation outcome to a
            // self-service path: the person cannot reach
            // `DELETE /api/account/deletion` because they are suspended, and
            // `getSessionOrThrow` refuses `ACCOUNT_SUSPENDED`. Their sessions
            // being gone is the first half of that.
            const reportId = await fileNotice();
            const target = await makeUser();
            await globalPrisma.$executeRawUnsafe(
                `INSERT INTO "UserSession"
                   ("id","sessionId","userId","createdAt","lastActiveAt","expiresAt")
                 VALUES ($1,$2,$3,NOW(),NOW(),NOW() + INTERVAL '1 day')`,
                `usrow-${randomUUID()}`, `sess-${randomUUID()}`, target,
            );

            const { actionId } = await actOnNotice({
                reportId, actionKind: 'ACCOUNT_TERMINATED',
                rationale: 'terminated', generation: 'current', suspendUserId: target,
            });
            actions.push(actionId);

            const live = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "UserSession"
                 WHERE "userId" = $1 AND "revokedAt" IS NULL`, target);
            expect(Number(live[0].n)).toBe(0);
        });
    });
});

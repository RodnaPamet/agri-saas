/**
 * P5.6b — erasure by pseudonymisation (#1597).
 *
 * ## The exit criterion names its own hard part
 *
 * > *An erasure runs without FK or trigger violation and **the audit chain
 * > still verifies afterwards**.*
 *
 * The second half is the real one, and the issue says why: `AuditLog` has two
 * gates and an immutability trigger, so an erasure that rewrites a row inside a
 * hash chain breaks verification for every entry after it. So this suite runs
 * `verifyPlatformChain` AFTER an erasure rather than checking that the job
 * returned — and it writes a chain entry FIRST, because verifying an empty
 * chain proves nothing.
 *
 * ## And the Art 17(3)(b) consequence is asserted, not assumed
 *
 * The owner's ruling means erasure is INCOMPLETE: `ContentReport` keeps
 * pointing at the `User` row, which survives. A test that only checked "the
 * identifying columns are gone" would pass equally if the row had been deleted
 * and the moderation trail destroyed with it — so the surviving link is
 * asserted directly.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import {
    eraseAccount,
    requestAccountDeletion,
    requestAccountDeletionOnTx,
    cancelAccountDeletion,
    findAccountsDueForErasure,
    subjectMayCancelErasure,
    DELETION_GRACE_DAYS,
} from '@/app-layer/usecases/account-erasure';
import { appendPlatformAuditEntry, verifyPlatformChain } from '@/lib/audit/platform-audit-writer';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const users: string[] = [];
const reports: string[] = [];
const blocks: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeUser(): Promise<{ id: string; email: string }> {
    const id = `u-p56b-${randomUUID()}`;
    const email = `p56b-${randomUUID()}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","nameEncrypted","updatedAt")
         VALUES ($1,$2,$3,$4,NOW())`,
        id, encryptField(email), hashForLookup(email), encryptField('Иван Петров'),
    );
    users.push(id);
    return { id, email };
}

async function makeSession(userId: string): Promise<void> {
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "UserSession"
           ("id","sessionId","userId","createdAt","lastActiveAt","expiresAt")
         VALUES ($1,$2,$3,NOW(),NOW(),NOW() + INTERVAL '1 day')`,
        `usrow-${randomUUID()}`, `sess-${randomUUID()}`, userId,
    );
}

async function makeNotice(reporterId: string): Promise<string> {
    const id = `cr-p56b-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "ContentReport"
           ("id","subjectKind","subjectId","reasonCode","status","detail","reporterUserId")
         VALUES ($1,'LISTING',$2,'MISLEADING_LISTING'::"ReportReasonCode",'RECEIVED',$3,$4)`,
        id, `listing-${randomUUID()}`, encryptField('a real complaint'), reporterId,
    );
    reports.push(id);
    return id;
}

async function makeBlock(blockerId: string, blockedId: string): Promise<string> {
    const id = `ub-p56b-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "UserBlock"("id","blockerUserId","blockedUserId") VALUES ($1,$2,$3)`,
        id, blockerId, blockedId,
    );
    blocks.push(id);
    return id;
}

/** Backdate a request so the sweep considers it due. */
async function backdateRequest(userId: string, days: number): Promise<void> {
    await globalPrisma.$executeRawUnsafe(
        `UPDATE "User" SET "deletionRequestedAt" = NOW() - ($2 || ' days')::interval
         WHERE "id" = $1`, userId, String(days),
    );
}

describeFn('P5.6b — erasure by pseudonymisation (#1597)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    afterAll(async () => {
        const del = async (t: string, c: string, ids: string[]) => {
            if (ids.length) {
                await globalPrisma.$executeRawUnsafe(
                    `DELETE FROM "${t}" WHERE "${c}" = ANY($1::text[])`, ids);
            }
        };
        await del('UserBlock', 'id', blocks);
        await del('ContentReport', 'id', reports);
        await del('UserSession', 'userId', users);
        await del('User', 'id', users);
        await globalPrisma.$disconnect();
    });

    describe('the freeze', () => {
        it('stamps the request and revokes live sessions', async () => {
            const { id } = await makeUser();
            await makeSession(id);
            await makeSession(id);

            const result = await requestAccountDeletion(id);

            expect(result.applied).toBe(true);
            expect(result.sessionsRevoked).toBe(2);
            // Revoking is what makes recovery coherent: the person signs in
            // again, and signing in is where the cancellation is offered.
            const live = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "UserSession"
                 WHERE "userId" = $1 AND "revokedAt" IS NULL`, id);
            expect(Number(live[0].n)).toBe(0);
        });

        it('tells the caller WHEN erasure will run', async () => {
            const { id } = await makeUser();

            const result = await requestAccountDeletion(id);

            const erasesAt = new Date(result.erasesAt!).getTime();
            const expected = Date.now() + DELETION_GRACE_DAYS * DAY_MS;
            // Within a minute — a person deciding whether to cancel needs the
            // date, so it is returned rather than left for the UI to guess.
            expect(Math.abs(erasesAt - expected)).toBeLessThan(60_000);
        });

        it('asking twice does NOT restart the grace period', async () => {
            const { id } = await makeUser();
            await requestAccountDeletion(id);
            const first = await globalPrisma.$queryRawUnsafe<Array<{ d: Date }>>(
                `SELECT "deletionRequestedAt" AS d FROM "User" WHERE "id" = $1`, id);

            const second = await requestAccountDeletion(id);

            expect(second.alreadyRequested).toBe(true);
            const again = await globalPrisma.$queryRawUnsafe<Array<{ d: Date }>>(
                `SELECT "deletionRequestedAt" AS d FROM "User" WHERE "id" = $1`, id);
            // Otherwise a person could never actually be deleted — each ask
            // would push the date out.
            expect(again[0].d.getTime()).toBe(first[0].d.getTime());
        });

        it('cancelling clears it', async () => {
            const { id } = await makeUser();
            await requestAccountDeletion(id);

            const result = await cancelAccountDeletion(id);

            expect(result.wasRequested).toBe(true);
            const row = await globalPrisma.$queryRawUnsafe<Array<{ d: Date | null }>>(
                `SELECT "deletionRequestedAt" AS d FROM "User" WHERE "id" = $1`, id);
            expect(row[0].d).toBeNull();
        });

        // ── who asked, and who may take it back (#1671) ──────────────
        //
        // The rule lives in `cancelAccountDeletion` rather than at the route,
        // because the previous protection WAS a route behaviour — the cancel
        // refusing a suspended account — and that is a side effect of a
        // different control rather than a property of the erasure. #1667
        // removed it with every required check green, because nothing asserted
        // the protection directly. These two do.
        it('records SELF for a self-service request', async () => {
            const { id } = await makeUser();
            await requestAccountDeletion(id);

            const row = await globalPrisma.$queryRawUnsafe<Array<{ b: string | null }>>(
                `SELECT "deletionRequestedBy" AS b FROM "User" WHERE "id" = $1`, id);
            expect(row[0].b).toBe('SELF');
        });

        it('refuses to cancel a MODERATION-initiated erasure, with a DISTINCT code', async () => {
            const { id } = await makeUser();
            await requestAccountDeletionOnTx(globalPrisma, id, 'MODERATION');

            await expect(cancelAccountDeletion(id)).rejects.toMatchObject({
                status: 403,
                // NOT `ACCOUNT_SUSPENDED`: that invites an appeal, and an
                // appeal would not restore anything here.
                code: 'ACCOUNT_TERMINATED',
            });

            // And the erasure is STILL pending — a refused cancel must not
            // half-apply. Asserted on the row rather than on the return,
            // because "it threw" and "it threw after clearing the column" look
            // identical from the caller.
            const row = await globalPrisma.$queryRawUnsafe<Array<{ d: Date | null }>>(
                `SELECT "deletionRequestedAt" AS d FROM "User" WHERE "id" = $1`, id);
            expect(row[0].d).not.toBeNull();
        });

        // ── the predicate agrees with the enforcement (#1667) ───────
        //
        // The assertion that was missing both times this broke. `/api/auth/me`
        // decides whether its 403 carries `erasesAt` — which the phone renders
        // as a «stop the deletion» button — by calling
        // `subjectMayCancelErasure`. So "a date was offered" and "the cancel
        // was honoured" are the same question, and this asserts they give the
        // same answer against real rows rather than trusting that two call
        // sites were edited together.
        //
        // Twice they were not: #1671 added the initiator and #1667 added
        // `terminatedAt`, each to the usecase only, each shipping a PR with
        // ten green checks. Both found by agrent-ios reading the diff.
        describe.each([
            ['nothing pending', 'none'],
            ['a SELF request', 'self'],
            ['a MODERATION request', 'moderation'],
            ['a SELF request, then terminated', 'self-then-terminated'],
        ])('%s', (_label, kind) => {
            it('offers a date exactly when the cancel is honoured', async () => {
                const { id } = await makeUser();
                if (kind === 'self' || kind === 'self-then-terminated') {
                    await requestAccountDeletion(id);
                } else if (kind === 'moderation') {
                    await requestAccountDeletionOnTx(globalPrisma, id, 'MODERATION');
                }
                if (kind === 'self-then-terminated') {
                    // What `actOnNotice` writes. Done directly here so the case
                    // does not depend on the moderation surface being reachable
                    // from this suite.
                    await globalPrisma.$executeRawUnsafe(
                        `UPDATE "User" SET "terminatedAt" = NOW() WHERE "id" = $1`, id);
                }

                const row = await globalPrisma.$queryRawUnsafe<Array<{
                    deletionRequestedAt: Date | null;
                    deletionRequestedBy: 'SELF' | 'MODERATION' | null;
                    terminatedAt: Date | null;
                    pseudonymisedAt: Date | null;
                }>>(
                    `SELECT "deletionRequestedAt", "deletionRequestedBy",
                            "terminatedAt", "pseudonymisedAt"
                     FROM "User" WHERE "id" = $1`, id);

                // What the route would decide — the same function it calls.
                const wouldOfferADate = subjectMayCancelErasure(row[0]);

                // What the server actually does. A refusal THROWS; a cancel
                // with nothing pending resolves `wasRequested: false`. Neither
                // is an honoured cancel, and the distinction between them is
                // not this test's subject.
                let honoured: boolean;
                try {
                    honoured = (await cancelAccountDeletion(id)).wasRequested === true;
                } catch {
                    honoured = false;
                }

                expect(wouldOfferADate).toBe(honoured);
            });
        });

        it('and the four cases are not all the same answer — the control', async () => {
            // Without this, a predicate stuck at `false` and an enforcement
            // that refused everything would satisfy every case above. The
            // equivalence is only worth something if both values move.
            const { id: selfId } = await makeUser();
            await requestAccountDeletion(selfId);
            const { id: modId } = await makeUser();
            await requestAccountDeletionOnTx(globalPrisma, modId, 'MODERATION');

            const read = async (id: string) =>
                (await globalPrisma.$queryRawUnsafe<Array<{
                    deletionRequestedAt: Date | null;
                    deletionRequestedBy: 'SELF' | 'MODERATION' | null;
                    terminatedAt: Date | null;
                    pseudonymisedAt: Date | null;
                }>>(
                    `SELECT "deletionRequestedAt", "deletionRequestedBy",
                            "terminatedAt", "pseudonymisedAt"
                     FROM "User" WHERE "id" = $1`, id))[0];

            expect(subjectMayCancelErasure(await read(selfId))).toBe(true);
            expect(subjectMayCancelErasure(await read(modId))).toBe(false);
        });

        it('a NULL initiator reads as SELF — every row predating #1671', async () => {
            // The migration adds a nullable column, so existing requests carry
            // no initiator. Treating NULL as MODERATION would have made every
            // pre-existing self-service request uncancellable on deploy day.
            const { id } = await makeUser();
            await requestAccountDeletion(id);
            await globalPrisma.$executeRawUnsafe(
                `UPDATE "User" SET "deletionRequestedBy" = NULL WHERE "id" = $1`, id);

            await expect(cancelAccountDeletion(id)).resolves.toMatchObject({
                wasRequested: true,
            });
        });
    });

    describe('the grace period', () => {
        it('does NOT select a fresh request', async () => {
            const { id } = await makeUser();
            await requestAccountDeletion(id);

            expect(await findAccountsDueForErasure(100)).not.toContain(id);
        });

        it('selects one past the window', async () => {
            const { id } = await makeUser();
            await requestAccountDeletion(id);
            await backdateRequest(id, DELETION_GRACE_DAYS + 1);

            expect(await findAccountsDueForErasure(100)).toContain(id);
        });

        it('does not select an already-erased row', async () => {
            // Idempotence by query: `pseudonymisedAt IS NULL` is half the
            // predicate, so a completed erasure is simply not selected again.
            const { id } = await makeUser();
            await requestAccountDeletion(id);
            await backdateRequest(id, DELETION_GRACE_DAYS + 1);
            await eraseAccount(id);

            expect(await findAccountsDueForErasure(100)).not.toContain(id);
        });
    });

    describe('the erasure', () => {
        it('empties the identifying content and KEEPS the row', async () => {
            const { id, email } = await makeUser();

            const outcome = await eraseAccount(id);

            expect(outcome.applied).toBe(true);
            const row = await globalPrisma.$queryRawUnsafe<Array<{
                e: string; h: string | null; n: string | null; p: Date | null;
            }>>(
                `SELECT "emailEncrypted" AS e, "emailHash" AS h, "nameEncrypted" AS n,
                        "pseudonymisedAt" AS p
                 FROM "User" WHERE "id" = $1`, id);

            // The ROW survives — that is the Art 17(3)(b) ruling, not an
            // oversight.
            expect(row).toHaveLength(1);
            expect(row[0].p).not.toBeNull();
            expect(row[0].n).toBeNull();
            // The lookup hash is REPLACED, not nulled — `pii-middleware`
            // derives it from `email` on every write that sets `email`, so an
            // explicit null would be overridden. What matters is the effect:
            // the hash no longer matches the ORIGINAL address, which the
            // next test asserts directly.
            expect(row[0].h).not.toBe(hashForLookup(email));
        });

        it('frees the email address for re-registration', async () => {
            const { id, email } = await makeUser();
            await eraseAccount(id);

            // `emailHash` is `String? @unique`, so NULLing it is what lets the
            // same person sign up again. A tombstone VALUE there would have
            // locked the address out for ever.
            const clash = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "User" WHERE "emailHash" = $1`,
                hashForLookup(email));
            expect(Number(clash[0].n)).toBe(0);
        });

        it('DELETES a UserBlock, in both directions', async () => {
            const me = await makeUser();
            const other = await makeUser();
            const mine = await makeBlock(me.id, other.id);
            const theirs = await makeBlock(other.id, me.id);

            await eraseAccount(me.id);

            // A block made by an anonymised account protects nobody, and a
            // block against one refuses nobody.
            const left = await globalPrisma.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT "id" FROM "UserBlock" WHERE "id" = ANY($1::text[])`, [mine, theirs]);
            expect(left).toHaveLength(0);
        });

        it('RETAINS the ContentReport, still pointing at the surviving row', async () => {
            // The assertion that makes "erasure is incomplete" true rather
            // than a form of words. A test checking only that identifying
            // columns were emptied would pass if the row had been deleted and
            // the moderation trail destroyed with it.
            const { id } = await makeUser();
            const noticeId = await makeNotice(id);

            await eraseAccount(id);

            const notice = await globalPrisma.$queryRawUnsafe<Array<{ r: string }>>(
                `SELECT "reporterUserId" AS r FROM "ContentReport" WHERE "id" = $1`, noticeId);
            expect(notice).toHaveLength(1);
            expect(notice[0].r).toBe(id);

            const stillThere = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "User" WHERE "id" = $1`, id);
            expect(Number(stillThere[0].n)).toBe(1);
        });

        it('is IDEMPOTENT — a second run changes nothing', async () => {
            const { id } = await makeUser();
            await eraseAccount(id);
            const first = await globalPrisma.$queryRawUnsafe<Array<{ e: string; p: Date }>>(
                `SELECT "emailEncrypted" AS e, "pseudonymisedAt" AS p
                 FROM "User" WHERE "id" = $1`, id);

            const second = await eraseAccount(id);

            expect(second.applied).toBe(false);
            const again = await globalPrisma.$queryRawUnsafe<Array<{ e: string; p: Date }>>(
                `SELECT "emailEncrypted" AS e, "pseudonymisedAt" AS p
                 FROM "User" WHERE "id" = $1`, id);
            // A second pseudonym over an already-anonymised row is harmless
            // and makes the audit unreadable, so the marker prevents it.
            expect(again[0].e).toBe(first[0].e);
            expect(again[0].p.getTime()).toBe(first[0].p.getTime());
        });

        it('does nothing for an account that does not exist', async () => {
            const outcome = await eraseAccount(`u-p56b-missing-${randomUUID()}`);
            expect(outcome.applied).toBe(false);
        });
    });

    describe('THE EXIT CRITERION: the audit chain still verifies', () => {
        it('verifies after an erasure', async () => {
            // Written FIRST, because verifying an empty chain proves nothing —
            // and the chain's verdict is about every entry, so this also
            // covers the ones P5.9's suspensions wrote.
            await appendPlatformAuditEntry({
                scope: 'moderation',
                action: 'ACCOUNT_SUSPENDED',
                actorUserId: null,
                detailsJson: { note: 'p5-6b chain fixture' },
            });
            const before = await verifyPlatformChain('moderation', globalPrisma as never);
            expect(before.intact).toBe(true);

            const { id } = await makeUser();
            await makeNotice(id);
            await eraseAccount(id);

            // The real criterion. `OrgAuditLog` and `PlatformAuditLog` are
            // RETAIN_ONLY precisely so the erasure works AROUND the chain:
            // rewriting a row inside one breaks verification for every entry
            // after it, and `platform_audit_log_immutable` would refuse the
            // UPDATE anyway.
            const after = await verifyPlatformChain('moderation', globalPrisma as never);
            expect(after.intact).toBe(true);
            expect(after.brokenAt).toBeNull();
            // The chain only grows. A verifier reporting FEWER entries after
            // an erasure would mean rows had been removed from inside it.
            expect(after.entries).toBeGreaterThanOrEqual(before.entries);
        });

        it('leaves no PlatformAuditLog row naming the erased person', async () => {
            // Not because it would be wrong to keep one — RETAIN_ONLY says we
            // do — but to pin WHICH guarantee we make: the chain is untouched,
            // so any row naming them stays. This asserts the erasure did not
            // quietly try to rewrite one.
            const { id } = await makeUser();
            await appendPlatformAuditEntry({
                scope: 'moderation',
                action: 'ACCOUNT_SUSPENDED',
                actorUserId: null,
                detailsJson: { targetUserId: id },
            });

            await eraseAccount(id);

            const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "PlatformAuditLog"
                 WHERE "detailsJson"::text LIKE '%' || $1 || '%'`, id);
            // Still there, and the chain still verifies — both are the ruling.
            expect(Number(rows[0].n)).toBeGreaterThan(0);
            const verdict = await verifyPlatformChain('moderation', globalPrisma as never);
            expect(verdict.intact).toBe(true);
        });
    });
});

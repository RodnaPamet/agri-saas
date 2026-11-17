/**
 * #2996 — "which moderation decisions produced no statement of reasons".
 *
 * The load-bearing test is the LAST one: the SQL anti-join and the TypeScript
 * predicate `expectsStatement` are two spellings of one rule, and this view
 * exists because two spellings of a moderation rule diverged once already
 * (#1664). So it writes one `ModerationAction` for EVERY
 * (ModerationActionKind × ReportSubjectKind) pair — 42 today — and asserts the
 * set the database returns is exactly the set the predicate says it should be.
 *
 * Rows are written with the raw client on purpose. `ModerationAction.rationale`
 * is encrypted, and going through the extended client would need a tenant DEK
 * for a TENANTLESS model; the view never selects that column, so a ciphertext
 * value in it is irrelevant to what is under test — and writing it raw is also
 * what proves the view reads rows it did not itself create through an ORM.
 */
import { PrismaClient, ModerationActionKind, ReportSubjectKind } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { expectsStatement } from '@/app-layer/usecases/moderation';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const ACTION_KINDS = Object.keys(ModerationActionKind);
const SUBJECT_KINDS = Object.keys(ReportSubjectKind);

/** A tag unique to this run, so assertions scope to their own rows. */
const TAG = `t${process.pid}x${Date.now().toString(36)}`;
let seq = 0;
const nextId = () => `${TAG}-${++seq}`;

async function writeAction(
    actionKind: string,
    subjectKind: string,
    id = nextId(),
): Promise<string> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "ModerationAction"
           ("id","createdAt","moderatorRef","actionKind","subjectKind","subjectId","rationale")
         VALUES ($1, NOW(), 'platform-key:test', $2::"ModerationActionKind",
                 $3::"ReportSubjectKind", $4, 'r')`,
        id,
        actionKind,
        subjectKind,
        `${id}-subject`,
    );
    return id;
}

async function writeStatement(actionId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "StatementOfReasons"
           ("id","createdAt","actionId","recipientUserId","locale","bodyRendered")
         VALUES ($1, NOW(), $2, 'user-1', 'bg', 'b')`,
        `s-${actionId}`,
        actionId,
    );
}

/** Only this run's rows — the table is global and other suites write it. */
async function mine(): Promise<Set<string>> {
    const { listDecisionsWithoutStatement } = await import('@/app-layer/usecases/moderation');
    const rows = await listDecisionsWithoutStatement(500);
    return new Set(rows.filter((r) => r.id.startsWith(TAG)).map((r) => r.id));
}

describeFn('listDecisionsWithoutStatement', () => {
    afterAll(async () => {
        await prisma.$executeRawUnsafe(
            `DELETE FROM "StatementOfReasons" WHERE "actionId" LIKE $1`,
            `${TAG}-%`,
        );
        await prisma.$executeRawUnsafe(`DELETE FROM "ModerationAction" WHERE "id" LIKE $1`, `${TAG}-%`);
        await prisma.$disconnect();
    });

    it('reports a removal that produced no statement', async () => {
        const id = await writeAction('CONTENT_REMOVED', 'LISTING');
        expect(await mine()).toContain(id);
    });

    it('does NOT report one that produced a statement', async () => {
        const id = await writeAction('CONTENT_REMOVED', 'MESSAGE');
        await writeStatement(id);
        expect(await mine()).not.toContain(id);
    });

    it('does NOT report a NONE decision — a rejected notice explains nothing', async () => {
        const id = await writeAction('NONE', 'LISTING');
        expect(await mine()).not.toContain(id);
    });

    it('does NOT report a recipientless subject kind', async () => {
        // PROFILE and THREAD have no recipient by design (#1690), so a
        // statement was never possible and its absence is not a gap.
        const profile = await writeAction('CONTENT_REMOVED', 'PROFILE');
        const thread = await writeAction('CONTENT_REMOVED', 'THREAD');
        const got = await mine();
        expect(got).not.toContain(profile);
        expect(got).not.toContain(thread);
    });

    it('reports a suspension whatever the subject kind, because its recipient is SUPPLIED', async () => {
        const onAccount = await writeAction('ACCOUNT_SUSPENDED', 'ACCOUNT');
        const onProfile = await writeAction('ACCOUNT_TERMINATED', 'PROFILE');
        const got = await mine();
        expect(got).toContain(onAccount);
        expect(got).toContain(onProfile);
    });

    it('returns no encrypted column — `rationale` is absent from the row shape', async () => {
        // A raw read cannot decrypt, so selecting it would hand an auditor a
        // `v1:`/`v2:` envelope that looks like a value. The P8.5 inbox trap.
        await writeAction('CONTENT_REMOVED', 'CHANNEL_POST');
        const { listDecisionsWithoutStatement } = await import('@/app-layer/usecases/moderation');
        const rows = await listDecisionsWithoutStatement(500);
        const row = rows.find((r) => r.id.startsWith(TAG))!;
        expect(row).toBeDefined();
        expect(Object.keys(row).sort()).toEqual(
            ['actionKind', 'createdAt', 'id', 'reportId', 'subjectId', 'subjectKind'].sort(),
        );
        expect(row).not.toHaveProperty('rationale');
    });

    it('honours the limit', async () => {
        const { listDecisionsWithoutStatement } = await import('@/app-layer/usecases/moderation');
        await writeAction('CONTENT_REMOVED', 'LISTING');
        await writeAction('CONTENT_REMOVED', 'LISTING');
        expect((await listDecisionsWithoutStatement(1)).length).toBe(1);
    });

    it('the SQL filter and `expectsStatement` agree over EVERY enum pair', async () => {
        // The whole point. 42 pairs today; the counts are printed so a shrunk
        // enum is visible rather than quietly reducing the population.
        const written: { id: string; actionKind: string; subjectKind: string }[] = [];
        for (const actionKind of ACTION_KINDS) {
            for (const subjectKind of SUBJECT_KINDS) {
                written.push({ id: await writeAction(actionKind, subjectKind), actionKind, subjectKind });
            }
        }
        console.log(
            `[unexplained-decisions] action kinds=${ACTION_KINDS.length} subject kinds=${SUBJECT_KINDS.length} pairs=${written.length}`,
        );
        expect(written.length).toBeGreaterThanOrEqual(42);

        const reported = await mine();
        const expected = written.filter((w) => expectsStatement(w.actionKind, w.subjectKind));

        // Both directions, and both controls. A filter that reported
        // everything and one that reported nothing would each satisfy one of
        // these assertions alone.
        expect(expected.length).toBeGreaterThan(0);
        expect(expected.length).toBeLessThan(written.length);

        for (const w of written) {
            const shouldReport = expectsStatement(w.actionKind, w.subjectKind);
            expect(reported.has(w.id)).toBe(shouldReport);
        }
    });
});

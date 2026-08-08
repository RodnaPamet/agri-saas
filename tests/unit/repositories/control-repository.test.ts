/**
 * Coverage wave 22 — `ControlRepository`.
 *
 * 24 uncovered functions at 11.11% (20.25% lines): the densest remaining
 * file in `src/app-layer/repositories`. Every usecase test in the repo
 * `jest.mock`s this class away, so the query shapes it owns — including
 * the tenant predicate — have never been executed.
 *
 * Controls are the one entity with a SHARED tier: `tenantId: null` rows
 * are the platform-provided catalogue every tenant reads. That makes the
 * isolation contract asymmetric and easy to get wrong, which is exactly
 * why it is asserted here rather than assumed:
 *
 *   - READS accept `tenantId = mine OR tenantId IS NULL`
 *   - WRITES require `tenantId = mine` (a shared control is not editable)
 *   - nested `evidence` on a read is STRICTLY mine, never the null tier
 *
 * These assert the QUERY the repository emits, not Prisma's behaviour —
 * the boundary contract this code owns. `db` is a recording double; the
 * pagination helpers (`clampLimit`, `buildCursorWhere`, `computePageInfo`)
 * run for real, because their interaction with the repository is part of
 * what is under test.
 */
import { ControlRepository } from '@/app-layer/repositories/ControlRepository';
import { makeRequestContext } from '../../helpers/make-context';
import { encodeCursor, MAX_LIMIT, DEFAULT_LIMIT } from '@/lib/pagination';
import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN'); // tenantId: 'tenant-1', userId: 'user-1'
const OTHER_TENANT = makeRequestContext('ADMIN', { tenantId: 'tenant-2' });

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
        delete: jest.fn().mockResolvedValue({ id: 'deleted' }),
    });
    return {
        control: model(),
        controlContributor: model(),
        controlTask: model(),
        controlEvidenceLink: model(),
        controlAsset: model(),
        frameworkMapping: model(),
    };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

/** The whole argument object of the first call. */
const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
/** The `where` of the first call. */
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;
/** The `data` of the first call. */
const dataOf = (fn: jest.Mock) => fn.mock.calls[0][0].data;

/** A control row shaped for `computePageInfo`. */
const row = (id: string, iso: string) => ({ id, createdAt: new Date(iso) });

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

// ─────────────────────────────────────────────────────────────────────
// Tenant predicate — the shared-catalogue asymmetry
// ─────────────────────────────────────────────────────────────────────

describe('ControlRepository — the read tenant predicate', () => {
    it('admits the calling tenant AND the shared (null) tier, nothing else', async () => {
        // Break: dropping the `tenantId: ctx.tenantId` arm leaves only the
        // shared catalogue (the page goes blank); dropping the OR entirely
        // returns every tenant's controls to whoever asks. Both are one
        // deleted line, and only an assertion on the emitted predicate
        // distinguishes them.
        await ControlRepository.list(asTx(db), ctx);

        expect(whereOf(db.control.findMany)).toEqual({
            OR: [{ tenantId: 'tenant-1' }, { tenantId: null }],
        });
    });

    it('follows the caller when the caller is a different tenant', async () => {
        // Break: hoisting the predicate to a module constant, or caching
        // it across requests. Naming one tenant in a single test cannot
        // catch that; two can.
        await ControlRepository.list(asTx(db), OTHER_TENANT);

        expect(whereOf(db.control.findMany)).toEqual({
            OR: [{ tenantId: 'tenant-2' }, { tenantId: null }],
        });
    });

    it('keeps the tenant predicate when filters are also applied', async () => {
        // Break: building `where` from the filters and then forgetting to
        // seed it with the tenant arms — a filtered list would go global.
        await ControlRepository.list(asTx(db), ctx, { status: 'IMPLEMENTED' });

        expect(whereOf(db.control.findMany)).toMatchObject({
            OR: [{ tenantId: 'tenant-1' }, { tenantId: null }],
            status: 'IMPLEMENTED',
        });
    });
});

describe('ControlRepository — list filters', () => {
    it('applies owner and category filters verbatim', async () => {
        await ControlRepository.list(asTx(db), ctx, {
            ownerUserId: 'user-9',
            category: 'Access Control',
        });

        expect(whereOf(db.control.findMany)).toMatchObject({
            ownerUserId: 'user-9',
            category: 'Access Control',
        });
    });

    it('accepts the two real applicability values', async () => {
        await ControlRepository.list(asTx(db), ctx, { applicability: 'NOT_APPLICABLE' });

        expect(whereOf(db.control.findMany)).toMatchObject({ applicability: 'NOT_APPLICABLE' });
    });

    it('drops an applicability value outside the enum instead of forwarding it', async () => {
        // Break: removing the allowlist. `applicability` is a Prisma enum
        // column, so a query-string value like `?applicability=ALL` would
        // reach the driver and blow the whole list page up with a
        // validation error rather than being ignored.
        await ControlRepository.list(asTx(db), ctx, { applicability: 'ALL' });

        expect(whereOf(db.control.findMany)).not.toHaveProperty('applicability');
    });

    it('searches name, code and description case-insensitively for a text query', async () => {
        // Break: narrowing the search to `name` only. Users search
        // controls by their code ("A.8.1") far more often than by name,
        // and the regression is invisible — the page still works, it
        // just stops finding things.
        await ControlRepository.list(asTx(db), ctx, { q: 'encryption' });

        expect(whereOf(db.control.findMany).AND).toEqual([
            {
                OR: [
                    { name: { contains: 'encryption', mode: 'insensitive' } },
                    { code: { contains: 'encryption', mode: 'insensitive' } },
                    { description: { contains: 'encryption', mode: 'insensitive' } },
                ],
            },
        ]);
    });

    it('adds no filter keys at all when no filters are supplied', async () => {
        await ControlRepository.list(asTx(db), ctx, {});

        expect(Object.keys(whereOf(db.control.findMany))).toEqual(['OR']);
    });
});

describe('ControlRepository.list — shape', () => {
    it('orders by code and selects the list projection', async () => {
        // `annexId` used to be the tiebreak here. It was dropped with the
        // control exoskeleton, and because Prisma argument objects are not
        // excess-property checked, the stale `orderBy` typechecked while
        // throwing at runtime — it 500'd /controls and /evidence until CI
        // E2E caught it. Assert the surviving single-key order.
        await ControlRepository.list(asTx(db), ctx);

        const arg = argOf(db.control.findMany);
        expect(arg.orderBy).toEqual([{ code: 'asc' }]);
        // `createdAt` is not rendered but IS required by computePageInfo —
        // dropping it from the projection breaks cursor pagination.
        expect(arg.select).toMatchObject({ id: true, code: true, createdAt: true });
        expect(arg.include).toBeUndefined();
    });

    it('omits `take` entirely when no cap is requested', async () => {
        // Break: defaulting `take` to a number would silently truncate the
        // Controls page, which is unpaginated by contract.
        await ControlRepository.list(asTx(db), ctx);

        expect(argOf(db.control.findMany)).not.toHaveProperty('take');
    });

    it('forwards an explicit take', async () => {
        await ControlRepository.list(asTx(db), ctx, undefined, { take: 5 });

        expect(argOf(db.control.findMany).take).toBe(5);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Cursor pagination
// ─────────────────────────────────────────────────────────────────────

describe('ControlRepository.listPaginated', () => {
    it('over-fetches by one so hasNextPage can be decided without a count', async () => {
        await ControlRepository.listPaginated(asTx(db), ctx, { limit: 10 });

        expect(argOf(db.control.findMany).take).toBe(11);
        expect(argOf(db.control.findMany).orderBy).toEqual([
            { createdAt: 'desc' },
            { id: 'desc' },
        ]);
    });

    it('clamps an absent limit to the default and an oversized one to the max', async () => {
        // Break: passing `params.limit` straight through lets a caller ask
        // for ?limit=1000000 and pull the whole table into memory.
        await ControlRepository.listPaginated(asTx(db), ctx, {});
        expect(argOf(db.control.findMany).take).toBe(DEFAULT_LIMIT + 1);

        db = makeDb();
        await ControlRepository.listPaginated(asTx(db), ctx, { limit: 10_000 });
        expect(argOf(db.control.findMany).take).toBe(MAX_LIMIT + 1);
    });

    it('trims the over-fetched row and emits a cursor when more pages exist', async () => {
        const items = Array.from({ length: 4 }, (_, i) =>
            row(`c-${i}`, `2026-01-0${i + 1}T00:00:00.000Z`),
        );
        db.control.findMany.mockResolvedValue(items);

        const res = await ControlRepository.listPaginated(asTx(db), ctx, { limit: 3 });

        expect(res.items).toHaveLength(3);
        expect(res.pageInfo.hasNextPage).toBe(true);
        expect(res.pageInfo.nextCursor).toBe(
            encodeCursor({ createdAt: items[2].createdAt.toISOString(), id: 'c-2' }),
        );
    });

    it('reports the last page with no cursor', async () => {
        // Break: emitting a cursor on the final page makes the client
        // request a page that is always empty — an infinite "load more".
        db.control.findMany.mockResolvedValue([row('c-0', '2026-01-01T00:00:00.000Z')]);

        const res = await ControlRepository.listPaginated(asTx(db), ctx, { limit: 3 });

        expect(res.pageInfo.hasNextPage).toBe(false);
        expect(res.pageInfo.nextCursor).toBeUndefined();
    });

    it('appends the cursor predicate instead of replacing the search predicate', async () => {
        // Break: `where.AND = [cursorWhere]` instead of a spread. Page 1 of
        // a SEARCH would be correct and page 2 would silently return the
        // unfiltered table — the single nastiest bug shape in this file,
        // and invisible unless both filters are present at once.
        const cursor = encodeCursor({ createdAt: '2026-01-02T00:00:00.000Z', id: 'c-9' });

        await ControlRepository.listPaginated(asTx(db), ctx, { cursor, filters: { q: 'audit' } });

        const and = whereOf(db.control.findMany).AND;
        expect(and).toHaveLength(2);
        expect(and[0].OR[1]).toEqual({ code: { contains: 'audit', mode: 'insensitive' } });
        expect(and[1].OR[0]).toEqual({
            createdAt: { lt: new Date('2026-01-02T00:00:00.000Z') },
        });
    });

    it('leaves AND unset when there is neither a cursor nor a text query', async () => {
        await ControlRepository.listPaginated(asTx(db), ctx, {});

        expect(whereOf(db.control.findMany).AND).toBeUndefined();
    });

    it('ignores a corrupt cursor rather than throwing', async () => {
        // Break: letting decodeCursor's failure propagate. A stale or
        // hand-edited `?cursor=` in a bookmarked URL would 500 the list
        // instead of restarting at page one.
        await ControlRepository.listPaginated(asTx(db), ctx, { cursor: 'not-base64-json' });

        expect(whereOf(db.control.findMany).AND).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Detail reads
// ─────────────────────────────────────────────────────────────────────

describe('ControlRepository — detail reads', () => {
    it('requires id AND the tenant-or-shared predicate to read a control', async () => {
        // Break: looking up by id alone makes every tenant's control
        // readable by anyone who can guess or leak an id.
        await ControlRepository.getById(asTx(db), ctx, 'c-1');

        expect(whereOf(db.control.findFirst)).toEqual({
            id: 'c-1',
            OR: [{ tenantId: 'tenant-1' }, { tenantId: null }],
        });
    });

    it('scopes the nested evidence of a control STRICTLY to the caller', async () => {
        // Break: reusing the outer `OR: [mine, null]` for the nested
        // `evidence` relation. Controls have a shared tier; EVIDENCE never
        // does. On a shared (tenantId: null) control that mistake would
        // hand one tenant another tenant's uploaded evidence.
        await ControlRepository.getById(asTx(db), ctx, 'c-1');

        expect(argOf(db.control.findFirst).include.evidence.where).toEqual({
            tenantId: 'tenant-1',
        });
    });

    it('does not eager-load the four tab relations on the header read', async () => {
        // Break: re-adding the arrays to `getHeaderById` re-introduces the
        // payload blow-up the tab-lazy split (#102) removed, while the tab
        // endpoints keep fetching them — double the work, silently.
        await ControlRepository.getHeaderById(asTx(db), ctx, 'c-1');

        const include = argOf(db.control.findFirst).include;
        expect(include).not.toHaveProperty('controlTasks');
        expect(include).not.toHaveProperty('evidenceLinks');
        expect(include).not.toHaveProperty('evidence');
        expect(include).not.toHaveProperty('frameworkMappings');
        // ...but the badge counts must still be there, or every tab
        // renders "(0)".
        expect(include._count.select).toEqual({
            controlTasks: true,
            evidenceLinks: true,
            evidence: true,
            frameworkMappings: true,
        });
    });

    it('applies the same tenant predicate on the header read as on the full read', async () => {
        await ControlRepository.getHeaderById(asTx(db), OTHER_TENANT, 'c-1');

        expect(whereOf(db.control.findFirst)).toEqual({
            id: 'c-1',
            OR: [{ tenantId: 'tenant-2' }, { tenantId: null }],
        });
    });

    it('reaches framework mappings through the control tenant, not the mapping row', async () => {
        // Break: `where: { toControlId }` alone. FrameworkMapping carries
        // no tenant column of its own, so the relation filter is the ONLY
        // thing stopping a leaked control id from listing another tenant's
        // mappings.
        await ControlRepository.listFrameworkMappings(asTx(db), ctx, 'c-1');

        expect(whereOf(db.frameworkMapping.findMany)).toEqual({
            toControlId: 'c-1',
            toControl: { tenantId: 'tenant-1' },
        });
    });
});

// ─────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────

describe('ControlRepository.create', () => {
    it('stamps the calling tenant', async () => {
        await ControlRepository.create(asTx(db), ctx, { code: 'A.5.1', name: 'Policy' } as never);

        expect(dataOf(db.control.create)).toMatchObject({
            code: 'A.5.1',
            tenantId: 'tenant-1',
        });
    });

    it('overrides a caller-supplied tenantId rather than honouring it', async () => {
        // Break: spreading `...data` AFTER `tenantId`. The create payload
        // originates in a request body, so that ordering flip is a direct
        // write-into-another-tenant primitive.
        await ControlRepository.create(asTx(db), ctx, {
            code: 'A.5.1',
            tenantId: 'tenant-2',
        } as never);

        expect(dataOf(db.control.create).tenantId).toBe('tenant-1');
    });
});

describe('ControlRepository.update', () => {
    it('checks ownership with a STRICT tenant match before writing', async () => {
        // Break: reusing the read predicate (`OR: [mine, null]`) here would
        // let any tenant edit the shared platform catalogue for everyone.
        // Asserting only "update was not called" would NOT catch that — the
        // where-clause itself is the contract.
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.update(asTx(db), ctx, 'c-1', { name: 'New' });

        expect(whereOf(db.control.findFirst)).toEqual({ id: 'c-1', tenantId: 'tenant-1' });
        expect(dataOf(db.control.update)).toEqual({ name: 'New' });
    });

    it('returns null and issues no write when the control is not the caller’s', async () => {
        const res = await ControlRepository.update(asTx(db), ctx, 'c-1', { name: 'New' });

        expect(res).toBeNull();
        expect(db.control.update).not.toHaveBeenCalled();
    });
});

describe('ControlRepository.setApplicability', () => {
    beforeEach(() => {
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });
    });

    it('keeps the justification when marking NOT_APPLICABLE and stamps the decider', async () => {
        await ControlRepository.setApplicability(asTx(db), ctx, 'c-1', 'NOT_APPLICABLE', 'No cloud estate');

        expect(dataOf(db.control.update)).toMatchObject({
            applicability: 'NOT_APPLICABLE',
            applicabilityJustification: 'No cloud estate',
            applicabilityDecidedByUserId: 'user-1',
        });
        expect(dataOf(db.control.update).applicabilityDecidedAt).toBeInstanceOf(Date);
    });

    it('clears a stale justification when the control becomes APPLICABLE again', async () => {
        // Break: writing `justification` unconditionally. The Statement of
        // Applicability would then show an APPLICABLE control still
        // carrying its old "not applicable because…" text — an auditor-
        // facing contradiction in the exported SoA.
        await ControlRepository.setApplicability(asTx(db), ctx, 'c-1', 'APPLICABLE', 'stale reason');

        expect(dataOf(db.control.update).applicabilityJustification).toBeNull();
    });

    it('refuses on a control the caller does not own', async () => {
        db.control.findFirst.mockResolvedValue(null);

        expect(await ControlRepository.setApplicability(asTx(db), ctx, 'c-1', 'APPLICABLE', null)).toBeNull();
        expect(db.control.update).not.toHaveBeenCalled();
    });
});

describe('ControlRepository.setOwner', () => {
    it('tenant-checks, then writes the owner', async () => {
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.setOwner(asTx(db), ctx, 'c-1', 'user-7');

        expect(whereOf(db.control.findFirst)).toEqual({ id: 'c-1', tenantId: 'tenant-1' });
        expect(dataOf(db.control.update)).toEqual({ ownerUserId: 'user-7' });
    });

    it('supports clearing the owner', async () => {
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.setOwner(asTx(db), ctx, 'c-1', null);

        expect(dataOf(db.control.update)).toEqual({ ownerUserId: null });
    });

    it('refuses on a foreign control', async () => {
        expect(await ControlRepository.setOwner(asTx(db), ctx, 'c-1', 'user-7')).toBeNull();
        expect(db.control.update).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Contributors
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────

describe('ControlRepository — tasks', () => {
    it('lists a control’s tasks tenant-scoped, oldest first', async () => {
        await ControlRepository.listTasks(asTx(db), ctx, 'c-1');

        expect(whereOf(db.controlTask.findMany)).toEqual({ controlId: 'c-1', tenantId: 'tenant-1' });
        expect(argOf(db.controlTask.findMany).orderBy).toEqual({ createdAt: 'asc' });
    });

    it('parses the due date and normalises blank optionals to null on create', async () => {
        // Break: forwarding `dueAt` as the raw ISO string. Prisma rejects a
        // string for a DateTime column, so every task created with a due
        // date would fail at the driver.
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.createTask(asTx(db), ctx, 'c-1', {
            title: 'Collect logs',
            dueAt: '2026-03-01T00:00:00.000Z',
        });

        const data = dataOf(db.controlTask.create);
        expect(data.dueAt).toEqual(new Date('2026-03-01T00:00:00.000Z'));
        expect(data).toMatchObject({
            tenantId: 'tenant-1',
            controlId: 'c-1',
            title: 'Collect logs',
            description: null,
            assigneeUserId: null,
        });
    });

    it('stores a null due date when none is given', async () => {
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.createTask(asTx(db), ctx, 'c-1', { title: 'T' });

        expect(dataOf(db.controlTask.create).dueAt).toBeNull();
    });

    it('refuses to create a task under a foreign control', async () => {
        expect(await ControlRepository.createTask(asTx(db), ctx, 'c-1', { title: 'T' })).toBeNull();
        expect(db.controlTask.create).not.toHaveBeenCalled();
    });

    it('patches only the keys actually supplied', async () => {
        // Break: building `data` from the object directly. `status` and
        // `assigneeUserId` would then be written as `undefined`/null on
        // every rename, silently unassigning the task.
        db.controlTask.findFirst.mockResolvedValue({ id: 't-1' });

        await ControlRepository.updateTask(asTx(db), ctx, 't-1', { title: 'Renamed' });

        expect(dataOf(db.controlTask.update)).toEqual({ title: 'Renamed' });
    });

    it('distinguishes an explicit null from an omitted field', async () => {
        // Break: an `if (data.assigneeUserId)` truthiness check instead of
        // an `!== undefined` check would make "unassign" impossible.
        db.controlTask.findFirst.mockResolvedValue({ id: 't-1' });

        await ControlRepository.updateTask(asTx(db), ctx, 't-1', {
            assigneeUserId: null,
            description: null,
            dueAt: null,
            status: 'DONE',
        });

        expect(dataOf(db.controlTask.update)).toEqual({
            assigneeUserId: null,
            description: null,
            dueAt: null,
            status: 'DONE',
        });
    });

    it('parses a supplied due date on patch too, not just on create', async () => {
        // Break: forwarding the ISO string on the UPDATE path while the
        // create path parses it. Creating a task with a due date would
        // work and rescheduling one would fail — the asymmetry is what
        // makes this worth its own assertion.
        db.controlTask.findFirst.mockResolvedValue({ id: 't-1' });

        await ControlRepository.updateTask(asTx(db), ctx, 't-1', {
            dueAt: '2026-06-30T00:00:00.000Z',
        });

        expect(dataOf(db.controlTask.update).dueAt).toEqual(new Date('2026-06-30T00:00:00.000Z'));
    });

    it('tenant-checks the task itself before patching it', async () => {
        db.controlTask.findFirst.mockResolvedValue({ id: 't-1' });

        await ControlRepository.updateTask(asTx(db), ctx, 't-1', { title: 'x' });

        expect(whereOf(db.controlTask.findFirst)).toEqual({ id: 't-1', tenantId: 'tenant-1' });
    });

    it('refuses to patch or delete a foreign task', async () => {
        expect(await ControlRepository.updateTask(asTx(db), ctx, 't-1', { title: 'x' })).toBeNull();
        expect(db.controlTask.update).not.toHaveBeenCalled();

        expect(await ControlRepository.deleteTask(asTx(db), ctx, 't-1')).toBeNull();
        expect(db.controlTask.delete).not.toHaveBeenCalled();
    });

    it('deletes an owned task', async () => {
        db.controlTask.findFirst.mockResolvedValue({ id: 't-1' });

        expect(await ControlRepository.deleteTask(asTx(db), ctx, 't-1')).toBe(true);
        expect(whereOf(db.controlTask.delete)).toEqual({ id: 't-1' });
    });
});

// ─────────────────────────────────────────────────────────────────────
// Evidence links
// ─────────────────────────────────────────────────────────────────────

describe('ControlRepository — evidence links', () => {
    it('lists evidence links tenant-scoped, newest first', async () => {
        await ControlRepository.listEvidenceLinks(asTx(db), ctx, 'c-1');

        expect(whereOf(db.controlEvidenceLink.findMany)).toEqual({
            controlId: 'c-1',
            tenantId: 'tenant-1',
        });
        expect(argOf(db.controlEvidenceLink.findMany).orderBy).toEqual({ createdAt: 'desc' });
    });

    it('records who attached the evidence', async () => {
        // Break: dropping `createdByUserId`. Evidence provenance is the
        // point of the audit trail — an attachment with no attributable
        // author is not evidence an auditor will accept.
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.linkEvidence(asTx(db), ctx, 'c-1', {
            kind: 'LINK',
            url: 'https://example.invalid/report',
        });

        expect(dataOf(db.controlEvidenceLink.create)).toEqual({
            tenantId: 'tenant-1',
            controlId: 'c-1',
            kind: 'LINK',
            fileId: null,
            url: 'https://example.invalid/report',
            note: null,
            createdByUserId: 'user-1',
        });
    });

    it('normalises the unused half of a FILE link to null', async () => {
        // A FILE link carries a fileId and no url; a LINK link is the
        // mirror image. Break: leaving the unused field `undefined`.
        // Prisma treats undefined as "do not set", so on the create path
        // the column falls to its default rather than an explicit null —
        // and the evidence renderer branches on `url === null`.
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.linkEvidence(asTx(db), ctx, 'c-1', {
            kind: 'FILE',
            fileId: 'f-1',
            note: 'Q1 export',
        });

        expect(dataOf(db.controlEvidenceLink.create)).toMatchObject({
            kind: 'FILE',
            fileId: 'f-1',
            url: null,
            note: 'Q1 export',
        });
    });

    it('refuses to link evidence to a foreign control', async () => {
        expect(
            await ControlRepository.linkEvidence(asTx(db), ctx, 'c-1', { kind: 'LINK' }),
        ).toBeNull();
        expect(db.controlEvidenceLink.create).not.toHaveBeenCalled();
    });

    it('requires the link to belong to BOTH the named control and the tenant', async () => {
        // Break: matching on `id` alone. The unlink endpoint takes the link
        // id from the URL, so without the `controlId` arm a caller could
        // detach evidence from a control they are not even looking at.
        db.controlEvidenceLink.findFirst.mockResolvedValue({ id: 'l-1' });

        expect(await ControlRepository.unlinkEvidence(asTx(db), ctx, 'c-1', 'l-1')).toBe(true);
        expect(whereOf(db.controlEvidenceLink.findFirst)).toEqual({
            id: 'l-1',
            controlId: 'c-1',
            tenantId: 'tenant-1',
        });
        expect(whereOf(db.controlEvidenceLink.delete)).toEqual({ id: 'l-1' });
    });

    it('is a no-op when the evidence link is not found', async () => {
        expect(await ControlRepository.unlinkEvidence(asTx(db), ctx, 'c-1', 'l-1')).toBeNull();
        expect(db.controlEvidenceLink.delete).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Asset links
// ─────────────────────────────────────────────────────────────────────

describe('ControlRepository — asset links', () => {
    it('verifies the control before creating the asset join row', async () => {
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });

        await ControlRepository.linkAsset(asTx(db), ctx, 'c-1', 'a-1');

        expect(whereOf(db.control.findFirst)).toEqual({ id: 'c-1', tenantId: 'tenant-1' });
        expect(dataOf(db.controlAsset.create)).toEqual({
            tenantId: 'tenant-1',
            controlId: 'c-1',
            assetId: 'a-1',
        });
    });

    it('refuses to link an asset to a foreign control', async () => {
        expect(await ControlRepository.linkAsset(asTx(db), ctx, 'c-1', 'a-1')).toBeNull();
        expect(db.controlAsset.create).not.toHaveBeenCalled();
    });

    it('locates the join row by control, asset AND tenant before deleting it', async () => {
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });
        db.controlAsset.findFirst.mockResolvedValue({ id: 'ca-1' });

        expect(await ControlRepository.unlinkAsset(asTx(db), ctx, 'c-1', 'a-1')).toBe(true);
        expect(whereOf(db.controlAsset.findFirst)).toEqual({
            controlId: 'c-1',
            assetId: 'a-1',
            tenantId: 'tenant-1',
        });
        expect(whereOf(db.controlAsset.delete)).toEqual({ id: 'ca-1' });
    });

    it('is a no-op when the asset link does not exist', async () => {
        db.control.findFirst.mockResolvedValue({ id: 'c-1' });
        db.controlAsset.findFirst.mockResolvedValue(null);

        expect(await ControlRepository.unlinkAsset(asTx(db), ctx, 'c-1', 'a-1')).toBeNull();
        expect(db.controlAsset.delete).not.toHaveBeenCalled();
    });

    it('refuses to unlink an asset from a foreign control', async () => {
        expect(await ControlRepository.unlinkAsset(asTx(db), ctx, 'c-1', 'a-1')).toBeNull();
        expect(db.controlAsset.findFirst).not.toHaveBeenCalled();
    });
});

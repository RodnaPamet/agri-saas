/**
 * Coverage wave 22 — `FrameworkRepository`.
 *
 * 10 uncovered functions at 0% (4.76% lines) — the file had never been
 * executed.
 *
 * Frameworks, requirements and packs are GLOBAL catalogue data: no
 * tenant column, deliberately readable by everyone. The tenant axis
 * enters at exactly two points, and both are the interesting ones:
 *
 *   - `getCoverage` joins the global requirement list against the
 *     tenant's OWN control mappings to compute the SoA coverage figure;
 *   - `isPackInstalled` counts the tenant's OWN controls matching the
 *     pack's template codes.
 *
 * A missing tenant filter in either does not leak rows to a user, but it
 * does something arguably worse for a compliance product: it reports
 * another customer's coverage as this customer's. That is a number an
 * auditor is shown. The arithmetic (including the divide-by-zero guard)
 * is therefore asserted against real fixture data, not just the query.
 */
import { FrameworkRepository } from '@/app-layer/repositories/FrameworkRepository';
import type { PrismaTx } from '@/lib/db-context';

function makeDb() {
    const model = () => ({
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        // `Framework.key` lost its single-column unique so two revisions of a
        // standard can coexist, which means a lookup by key alone is a
        // `findFirst` (newest version first) rather than a `findUnique`.
        // FrameworkPack.key is still unique and still uses findUnique.
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
    });
    return {
        framework: model(),
        frameworkRequirement: model(),
        frameworkMapping: model(),
        frameworkPack: model(),
        control: model(),
    };
}

type FakeDb = ReturnType<typeof makeDb>;
const asTx = (db: FakeDb) => db as unknown as PrismaTx;

const argOf = (fn: jest.Mock) => fn.mock.calls[0][0];
const whereOf = (fn: jest.Mock) => fn.mock.calls[0][0].where;

const req = (id: string, code: string) => ({
    id,
    code,
    title: `Requirement ${code}`,
    theme: 'Organizational',
    themeNumber: 5,
});

let db: FakeDb;
beforeEach(() => {
    db = makeDb();
});

describe('FrameworkRepository — catalogue reads', () => {
    it('lists frameworks by key with their requirement counts and packs', async () => {
        // Break: dropping `_count.requirements`. The framework picker
        // shows "ISO 27001 (93 requirements)"; without the count every
        // entry reads as empty and the catalogue looks broken.
        await FrameworkRepository.listFrameworks(asTx(db));

        expect(argOf(db.framework.findMany).orderBy).toEqual({ key: 'asc' });
        expect(argOf(db.framework.findMany).include._count.select).toEqual({ requirements: true });
    });

    it('loads a framework by key with its requirements in sort order', async () => {
        // Break: losing `orderBy: sortOrder`. Requirement codes are not
        // lexically ordered ("A.5.10" sorts before "A.5.2"), so the stored
        // sortOrder is the only thing that renders a framework in its
        // published sequence.
        await FrameworkRepository.getFrameworkByKey(asTx(db), 'iso27001');

        expect(whereOf(db.framework.findFirst)).toEqual({ key: 'iso27001' });
        expect(argOf(db.framework.findFirst).include.requirements.orderBy).toEqual({
            sortOrder: 'asc',
        });
    });
});

describe('FrameworkRepository.listRequirements', () => {
    it('resolves the framework key to an id before querying requirements', async () => {
        // Break: filtering requirements on the KEY string. `frameworkId`
        // is the FK column; a key-shaped value matches nothing, so the
        // requirement list silently comes back empty.
        db.framework.findFirst.mockResolvedValue({ id: 'fw-1' });

        await FrameworkRepository.listRequirements(asTx(db), 'iso27001');

        expect(whereOf(db.frameworkRequirement.findMany)).toEqual({ frameworkId: 'fw-1' });
        expect(argOf(db.frameworkRequirement.findMany).orderBy).toEqual({ sortOrder: 'asc' });
    });

    it('returns null for an unknown framework instead of querying on undefined', async () => {
        // Break: dropping the null check. `frameworkId: undefined` is not
        // a filter in Prisma — it is an ABSENT filter, so a typo'd
        // framework key would return EVERY framework's requirements.
        expect(await FrameworkRepository.listRequirements(asTx(db), 'nope')).toBeNull();
        expect(db.frameworkRequirement.findMany).not.toHaveBeenCalled();
    });
});

describe('FrameworkRepository.getCoverage', () => {
    beforeEach(() => {
        db.framework.findFirst.mockResolvedValue({ id: 'fw-1' });
    });

    it('counts only mappings whose control belongs to the asking tenant', async () => {
        // Break: dropping `toControl: { tenantId }`. Coverage would then
        // count every customer's mappings, so a tenant with zero controls
        // could be shown "87% covered" — a false assurance number that
        // ends up in an audit pack.
        db.frameworkRequirement.findMany.mockResolvedValue([req('r-1', 'A.5.1')]);

        await FrameworkRepository.getCoverage(asTx(db), 'iso27001', 'tenant-1');

        expect(whereOf(db.frameworkMapping.findMany)).toEqual({
            fromRequirement: { frameworkId: 'fw-1' },
            toControl: { tenantId: 'tenant-1' },
        });
    });

    it('splits requirements into mapped and unmapped and rounds the percentage', async () => {
        db.frameworkRequirement.findMany.mockResolvedValue([
            req('r-1', 'A.5.1'),
            req('r-2', 'A.5.2'),
            req('r-3', 'A.5.3'),
        ]);
        db.frameworkMapping.findMany.mockResolvedValue([
            { fromRequirementId: 'r-1', toControlId: 'c-1' },
        ]);

        const res = await FrameworkRepository.getCoverage(asTx(db), 'iso27001', 'tenant-1');

        expect(res).toMatchObject({ total: 3, mappedCount: 1, unmappedCount: 2, coveragePercent: 33 });
        expect(res!.mapped.map((r) => r.code)).toEqual(['A.5.1']);
        expect(res!.unmapped.map((r) => r.code)).toEqual(['A.5.2', 'A.5.3']);
    });

    it('counts a requirement once even when several controls map to it', async () => {
        // Break: computing `mappedCount` from `mappings.length` instead of
        // the deduplicated requirement set. Mapping three controls onto
        // one requirement would report 300% coverage of a single-
        // requirement framework.
        db.frameworkRequirement.findMany.mockResolvedValue([req('r-1', 'A.5.1'), req('r-2', 'A.5.2')]);
        db.frameworkMapping.findMany.mockResolvedValue([
            { fromRequirementId: 'r-1', toControlId: 'c-1' },
            { fromRequirementId: 'r-1', toControlId: 'c-2' },
            { fromRequirementId: 'r-1', toControlId: 'c-3' },
        ]);

        const res = await FrameworkRepository.getCoverage(asTx(db), 'iso27001', 'tenant-1');

        expect(res).toMatchObject({ total: 2, mappedCount: 1, coveragePercent: 50 });
    });

    it('reports 0% rather than NaN for a framework with no requirements', async () => {
        // Break: removing the `length > 0` guard. 0/0 is NaN, which
        // serialises to `null` in JSON and renders as a blank coverage
        // dial — a silently broken dashboard rather than an honest zero.
        db.frameworkRequirement.findMany.mockResolvedValue([]);

        const res = await FrameworkRepository.getCoverage(asTx(db), 'empty', 'tenant-1');

        expect(res).toMatchObject({ total: 0, coveragePercent: 0 });
        expect(Number.isNaN(res!.coveragePercent)).toBe(false);
    });

    it('returns null for an unknown framework without touching the requirement table', async () => {
        db.framework.findFirst.mockResolvedValue(null);

        expect(await FrameworkRepository.getCoverage(asTx(db), 'nope', 'tenant-1')).toBeNull();
        expect(db.frameworkRequirement.findMany).not.toHaveBeenCalled();
    });
});


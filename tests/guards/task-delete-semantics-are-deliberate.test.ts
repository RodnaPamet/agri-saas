/**
 * One `Task` table, two delete semantics — pinned so neither note can rot
 * (#2215, owner ruling 2026-10-23).
 *
 * `Task.deletedAt` is indexed and filtered on, and for a long time it looked
 * like scaffolding nobody wired up. On 2026-10-23 that was wrong — a TREATMENT
 * withdrawal wrote it, with a restore and a Trash behind it — and the owner
 * ruled the asymmetry should stay, because a register entry is a filed record
 * that must be reversible.
 *
 * On 2026-10-24 the owner removed «Кошче» altogether: "what's deleted is
 * deleted". So the column IS now scaffolding nobody writes, and the two routes
 * agree. Both rulings are recorded because the second overrides reasoning the
 * first had considered, and a reader who sees only the outcome cannot tell
 * that apart from an oversight.
 *
 * ## Why a guard for a ruling that changed no behaviour
 *
 * Because the ruling's whole output is two docblocks, and a docblock asserting
 * what OTHER code does is the shape that goes false with nothing failing:
 * somebody converts `deleteTask` to a soft delete, or drops the withdrawal's
 * restore, and both notes quietly start lying about the thing a reader came to
 * them to learn. Each note names this file so the pair is discoverable from
 * either end.
 *
 * ## The third fact is the one that bites
 *
 * `OperationParcel` carries `onDelete: Cascade` on its task relation, and
 * those rows ARE the lines the БАБХ ДНЕВНИК prints. So the hard path does not
 * merely destroy a to-do — it destroys register lines, which is #2220. Pinned
 * here because the docblocks now say so, and because a schema change that
 * relaxed the cascade would make them wrong in the *safe* direction, which is
 * exactly the kind of drift nobody goes looking for.
 *
 * ## What this does NOT claim
 *
 * Not that either semantics is right. It asserts only that they are what the
 * two notes say they are. A deliberate change to either should come here,
 * change the expectation, and change the note — which is the point.
 */
import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';
import { readPrismaSchema } from '../helpers/prisma-schema';

const REPO = path.resolve(__dirname, '..', '..');
const HARD = 'src/app-layer/usecases/task.ts';
const SOFT = 'src/app-layer/usecases/diary-treatment.ts';

const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** Comments and string literals blanked, so prose cannot satisfy a code assertion. */
const code = (rel: string): string => blankNonCode(read(rel));

describe('the task path calls delete — which the extension makes SOFT', () => {
    it('`deleteTask` and `bulkDeleteTask` call delete / deleteMany', () => {
        const c = code(HARD);
        expect(c).toContain('db.task.delete(');
        expect(c).toContain('db.task.deleteMany(');
    });

    /**
     * ⚠ WHAT THIS SUITE CANNOT SEE — #2242.
     *
     * This file reads SOURCE. `Task` is in `SOFT_DELETE_MODELS`, and
     * `withSoftDeleteExtension` (`src/lib/prisma.ts:459`) rewrites both calls
     * above into `update({ data: { deletedAt } })` before they reach the
     * database. Measured through the real tenant client:
     *
     *     delete     -> SOFT (deletedAt=true)
     *     deleteMany -> SOFT (deletedAt=true)
     *
     * An earlier version of this suite asserted "nothing on that path writes
     * `deletedAt`" and PASSED, which is true of the file and false of the
     * behaviour. It is blind by construction: no scan of a call site can see
     * something rewriting the call. The assertion is gone rather than fixed,
     * because there is no regex that closes that gap — the replacement is a
     * DB-backed case, tracked in #2242.
     */
    it('records that the call shape is not the semantics', () => {
        // A deliberate non-assertion would be worse than none. What IS
        // checkable here: the file tells the reader where the truth is.
        expect(read(HARD)).toMatch(/SOFT_DELETE_MODELS|#2242/);
    });

    it('the file points the reader at the TREATMENT path', () => {
        // The cross-reference is load-bearing: the asymmetry is invisible from
        // either route, so each has to name the other.
        expect(read(HARD)).toContain('deleteDiaryTreatment');
    });
});

/**
 * REWRITTEN 2026-10-24. This describe was `the soft path is soft, with a
 * restore`, and every assertion in it is now false by ruling rather than by
 * drift: «Кошче» is gone and the treatment delete is physical.
 *
 * The guard's PURPOSE survives the reversal unchanged — two routes delete
 * rows from one table, and each file's docblock describes the other, so each
 * can go stale silently. What changed is which facts it pins.
 */
describe('the treatment path erases what the extension would otherwise spare', () => {
    it('deletes the register LINES explicitly, not by cascade', () => {
        // The crux. `Task` is in `SOFT_DELETE_MODELS`, so the extension
        // rewrites its delete into an UPDATE — and an update cascades
        // NOTHING. Relying on `onDelete: Cascade` here leaves every
        // `OperationParcel` row in place and the ДНЕВНИК still printing a
        // treatment the farmer erased.
        //
        // This assertion is the one that would have caught #2242: the source
        // reads `db.task.delete`, which looks hard and is not.
        expect(code(SOFT)).toMatch(/db\.operationParcel\.deleteMany\(/);
    });

    it('it deletes the journal entries EXPLICITLY', () => {
        // The load-bearing one. `LogEntry.operationParcel` is an optional
        // relation with no `onDelete`, so Prisma defaults it to SET NULL:
        // cascading from the task would leave every entry alive with a null
        // `operationParcelId`. A refactor that "simplifies" this away relies
        // on a cascade that does not exist, and the entries come back as
        // orphans with nothing pointing at them.
        expect(code(SOFT)).toMatch(/db\.logEntry\.deleteMany\(/);
    });

    it('nothing restores a treatment any more', () => {
        expect(code(SOFT)).not.toContain('export async function restoreDiaryTreatment');
        expect(code(SOFT)).not.toContain('export async function listDeletedTreatments');
    });

    it('the file points the reader at the hard path', () => {
        expect(read(SOFT)).toContain('deleteTask');
    });
});

describe('the cascade that makes the hard path destroy register lines (#2220)', () => {
    /**
     * Parsed from the raw schema rather than `parseSchemaModels()`, which
     * carries field names and types but not relation ATTRIBUTES — and
     * `onDelete` is the whole question here.
     */
    const relationLines = (model: string): string[] => {
        const schema = readPrismaSchema();
        const m = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
        if (!m) throw new Error(`model ${model} not found in the schema`);
        return m[1].split('\n').filter((l) => /@relation\(/.test(l));
    };

    const taskRelation = (model: string): string => {
        const hit = relationLines(model).filter((l) => /\bTask\b/.test(l));
        if (hit.length !== 1) {
            throw new Error(`expected exactly 1 Task relation on ${model}, found ${hit.length}`);
        }
        return hit[0];
    };

    it('OperationParcel cascades — so deleting the task deletes the lines', () => {
        expect(taskRelation('OperationParcel')).toMatch(/onDelete:\s*Cascade/);
    });

    it('so does the LOCATION link the register joins through', () => {
        expect(taskRelation('TaskLink')).toMatch(/onDelete:\s*Cascade/);
    });

    it('CONTROL: the parse can see a relation that does NOT cascade', () => {
        // Without this, a regex that silently matched nothing would make both
        // assertions above pass for the wrong reason — and a cascade check
        // that cannot distinguish Cascade from its absence is inert.
        // `Evidence.task` is optional and carries no `onDelete`.
        expect(taskRelation('Evidence')).not.toMatch(/onDelete:\s*Cascade/);
    });

    it('CONTROL: a missing model throws rather than returning nothing', () => {
        expect(() => taskRelation('NoSuchModelHere')).toThrow(/not found in the schema/);
    });
});

describe('CONTROL: prose cannot satisfy a code assertion', () => {
    it('blankNonCode removes a commented-out call', () => {
        const src = ['// db.task.delete({ where: { id } });', 'const x = 1;'].join('\n');
        const stripped = blankNonCode(src);
        expect(stripped).not.toContain('db.task.delete(');
        expect(stripped).toContain('const x = 1;');
    });

    it('…and keeps a real one', () => {
        expect(blankNonCode('await db.task.delete({ where: { id } });')).toContain(
            'db.task.delete(',
        );
    });
});

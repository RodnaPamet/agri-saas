/**
 * One `Task` table, two delete semantics — pinned so neither note can rot
 * (#2215, owner ruling 2026-10-23).
 *
 * `Task.deletedAt` is indexed and filtered on, and for a long time it looked
 * like scaffolding nobody wired up. It is not: a TREATMENT withdrawal writes
 * it, with a restore and a Trash behind it, while the generic task delete is
 * `db.task.delete`. The owner ruled the asymmetry stays — a register entry is
 * a filed record, so withdrawing one must be reversible; an ordinary task
 * carries no such obligation.
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

describe('the hard path is hard, in code and not only in prose', () => {
    it('`deleteTask` and `bulkDeleteTask` destroy the row', () => {
        const c = code(HARD);
        expect(c).toContain('db.task.delete(');
        expect(c).toContain('db.task.deleteMany(');
    });

    it('nothing on that path writes `deletedAt`', () => {
        // The failure this catches: a well-meant conversion to a soft delete
        // that leaves both docblocks describing a hard one. `deletedAt` may
        // appear in a FILTER elsewhere in the file, so the assertion is about
        // a WRITE — `deletedAt:` followed by a value, inside an update.
        const c = code(HARD);
        expect(c).not.toMatch(/db\.task\.update(Many)?\([^)]*deletedAt/s);
    });

    it('the file points the reader at the soft path', () => {
        // The cross-reference is load-bearing: the asymmetry is invisible from
        // either route, so each has to name the other.
        expect(read(HARD)).toContain('deleteDiaryTreatment');
    });
});

describe('the soft path is soft, with a restore', () => {
    it('the withdrawal SETS `deletedAt` on the tasks', () => {
        expect(code(SOFT)).toMatch(/db\.task\.updateMany\([^)]*deletedAt:\s*now/s);
    });

    it('the restore CLEARS it', () => {
        expect(code(SOFT)).toMatch(/deletedAt:\s*null,\s*deletedByUserId:\s*null/s);
    });

    it('a Trash lists what was withdrawn', () => {
        expect(code(SOFT)).toContain('export async function listDeletedTreatments');
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

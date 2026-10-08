/**
 * A `.not.toHaveBeenCalled()` on a prisma write must name a method the
 * production code can actually call (#1419).
 *
 * ## The defect class
 *
 * A POSITIVE assertion breaks loudly when its subject is renamed — the mock
 * has no such method, or it was never called. A NEGATIVE one goes **quiet**,
 * because the subject's disappearance is exactly what makes it pass. So
 * renaming a prisma write in `src/` silently disarms every
 * `expect(db.model.oldName).not.toHaveBeenCalled()` aimed at it, with nothing
 * going red.
 *
 * Found by #1418: making `openExchangeThread` insert with
 * `createMany({ skipDuplicates })` instead of `create` turned TWO assertions
 * vacuous, one of them the #1407 assertion proving a blocked buyer gets no
 * thread — a security property, disarmed by an unrelated refactor.
 *
 * ## Why THIS rule and not "has a positive counterpart"
 *
 * The obvious check — every negative assertion needs a positive one in the
 * same file — was measured and rejected: **257 of 673** negative assertions
 * repo-wide have no same-file positive, and most are fine because the
 * corroboration is INDIRECT. `apple-native-route.test.ts` asserts
 * `recordNewSession` was not called and is not vacuous: if the route stopped
 * calling it, a DIFFERENT test's `claims.userSessionId` assertion fails. A
 * check with a 38% flag rate teaches people to add exemptions without reading.
 *
 * That framing asks "is this corroborated?", which is undecidable. This asks
 * **"could it ever fail?"**, which for a prisma mock is decidable: flag a
 * negative assertion on `model.method` when `src/` never calls
 * `.model.method(` **but does call another write method on the same model**.
 * The capability survives under a new name, so the assertion names something
 * superseded.
 *
 * The supersession clause is what keeps it honest, and it was forced by a
 * false positive. `integrationExecution.create` is asserted negatively twice
 * and `src/` writes that model by NO route — so there is no superseded
 * sibling and the assertion is a FORWARD-LOOKING guard ("do not start minting
 * executions here"). It is correctly left alone, structurally, with no
 * exemption list. A rule without that clause flags it, and one false positive
 * in a population this size already needs curation.
 *
 * ## Scope: prisma mocks only, and that is deliberate
 *
 * The repo has ~1098 `.not.toHaveBeenCalled()` assertions across 371 distinct
 * receiver roots. This covers the prisma-shaped subset — `<root>.<model>.<method>`
 * where the method is a prisma write — because that is the only family where
 * "can production call this?" is answerable by reading `src/`, and because
 * prisma method names are a vocabulary somebody ELSE owns, which is where a
 * rename is most likely. For an arbitrary jest mock there is no model to
 * enumerate siblings on.
 *
 * Same justification `web-platform-identifiers.test.ts` carries for pinning
 * `Cache-Control` and `aria-controls`: a reader who understands why the scope
 * is narrow will not widen it badly.
 *
 * The population is matched ROOT-AGNOSTICALLY on purpose. My first measurement
 * keyed on `mockPrisma` and saw **46 of 1098**; the real prisma-shaped
 * population is ~144 across six roots (`mockDb` is the largest at 73, not
 * `mockPrisma`). A matcher that recognises one spelling reports the forms its
 * author thought of rather than the assertions that exist.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { globSync } from 'glob';

const ROOT = join(__dirname, '../..');

/** Prisma's write verbs. A read being superseded is not a safety problem. */
const WRITE_METHODS = [
    'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
] as const;

/** `expect(<anyRoot>.<model>.<method>).not.toHaveBeenCalled` */
const NEGATIVE = /expect\(\s*([A-Za-z_$][\w$]*)\.(\w+)\.(\w+)\s*\)\.not\.toHaveBeenCalled/g;

interface Finding {
    model: string;
    method: string;
    supersededBy: string[];
    files: string[];
    count: number;
}

function readAll(pattern: string): Array<{ file: string; text: string }> {
    return globSync(pattern, { cwd: ROOT, absolute: false })
        .map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
}

function analyse() {
    const tests = readAll('tests/**/*.test.ts?(x)');
    const src = readAll('src/**/*.ts').map((f) => f.text).join('\n');

    const seen = new Map<string, { count: number; files: Set<string> }>();
    const roots = new Set<string>();

    for (const { file, text } of tests) {
        for (const m of text.matchAll(NEGATIVE)) {
            const [, root, model, method] = m;
            if (!(WRITE_METHODS as readonly string[]).includes(method)) continue;
            roots.add(root);
            const key = `${model}.${method}`;
            const entry = seen.get(key) ?? { count: 0, files: new Set<string>() };
            entry.count += 1;
            entry.files.add(file);
            seen.set(key, entry);
        }
    }

    const findings: Finding[] = [];
    for (const [key, { count, files }] of seen) {
        const [model, method] = key.split('.');
        if (src.includes(`.${model}.${method}(`)) continue;
        const supersededBy = WRITE_METHODS.filter(
            (w) => w !== method && src.includes(`.${model}.${w}(`),
        );
        if (supersededBy.length === 0) continue; // forward-looking guard
        findings.push({ model, method, supersededBy, files: [...files].sort(), count });
    }

    return { findings, population: [...seen.values()].reduce((n, e) => n + e.count, 0), pairs: seen.size, roots };
}

describe('a negative assertion on a prisma write names a live method', () => {
    const { findings, population, pairs, roots } = analyse();

    it('prints its denominator, so a selection bug cannot read as a clean pass', () => {
        // eslint-disable-next-line no-console -- the population IS the result
        console.log(
            `[negative-assertion-liveness] ${population} assertion(s) over ${pairs} ` +
                `(model, method) pair(s), across ${roots.size} receiver root(s): ` +
                `${[...roots].sort().join(', ')}`,
        );
        // A refactor of how the prisma mock is spelled could empty this
        // selection, and an empty selection passes every assertion below. The
        // floor is well under the measured 144 so it does not need editing for
        // ordinary churn, but it cannot silently reach zero.
        expect(population).toBeGreaterThan(50);
        expect(roots.size).toBeGreaterThan(1);
    });

    it('flags no assertion that names a superseded write', () => {
        const report = findings
            .map(
                (f) =>
                    `  ${f.model}.${f.method} (${f.count}x) — src calls ` +
                    `${f.supersededBy.map((s) => `${f.model}.${s}`).join(', ')} instead\n` +
                    f.files.map((x) => `      ${x}`).join('\n'),
            )
            .join('\n');
        expect(findings).toEqual([]);
        // Unreachable when the array is empty; kept so the message is attached
        // to the assertion rather than living only in a comment.
        if (findings.length) throw new Error(`Vacuous negative assertion(s):\n${report}`);
    });
});

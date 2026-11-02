/**
 * A write to a tenant-keyed ENCRYPTED column must run inside a farm context.
 *
 * ## Why this half needs a guard and the read half does not
 *
 * #2723's class has two directions and they are NOT symmetric:
 *
 *   · a READ with no farm bound hands back the `v2:` ENVELOPE, which is
 *     detectable at a boundary — `readableOrNull` in
 *     `@/lib/db/per-tenant-content` does exactly that, and an envelope
 *     reaching a response is a defect whatever produced it.
 *   · a WRITE with no farm bound falls back to the `v1:` GLOBAL KEK. It reads
 *     back PERFECTLY, because the extension dispatches per value on the
 *     envelope. There is no symptom, ever, at any boundary. The only thing
 *     lost is per-tenant key isolation — the property `GLOBAL_KEK_MODELS`
 *     exists to protect, and whose own comment says a tenant-scoped model must
 *     not join that set "precisely because it would throw that isolation
 *     away".
 *
 * So the read half gets a general mechanism and the write half gets
 * site-by-site discipline plus this scan. Nothing else can see it.
 * Measured in `tests/integration/per-tenant-encrypted-io.test.ts` §4: the same
 * row written bound comes out `v2:`, unbound `v1:`, and both read back fine.
 *
 * ## The unit of the rule is `(model, column)`, never either alone
 *
 * A detector keyed on COLUMN NAME across all models reports **38** sites in
 * this tree and all of them are noise: `name` matches `User.name`,
 * `Company.name` and a dozen more; `body` matches email and HTTP bodies;
 * `description` matches `FeatureFlag.description`, which is global-KEK anyway.
 * That is #1222 reproduced BY the detector hunting it — a flat set of field
 * names cannot tell models apart, which is why a model absent from the
 * manifest resolving to `'*'` once encrypted 18 pairs by collision rather
 * than by decision. Pairing the two keys the manifest pairs takes 38 to 1
 * (measured by agrent backend-1, from the other direction).
 *
 * ## What it cannot see, stated rather than implied
 *
 * A NESTED write (`parent.create({ data: { child: { create: … } } })`) whose
 * target model the schema cannot resolve goes through
 * `encryptDataNodeAllModels`, the one place where the flat-name reading is the
 * RUNTIME's behaviour rather than a scanning error. This guard is keyed on the
 * top-level model, so a nested encrypted write is outside its population. That
 * is the residual to worry about on this axis, and it wants an AST rather than
 * a regex.
 *
 * **An ALIASED client also defeats it**, and that is not a guess — it is how
 * the first attempt to mutation-prove this guard accidentally passed. A write
 * spelled `db.task.create` where `db` is bound to the global client is
 * invisible, because the needle is the literal `prisma.<model>.<verb>`. The
 * guard therefore answers "is there a DIRECT global-client write to an
 * encrypted column", which is the shape that actually shipped (#2723), and
 * not "can an unbound write be reached", which is the same reachability
 * question that makes a static guard the wrong tool on the read half.
 *
 * Both limits point the same way: this is a RATCHET over a population that is
 * currently zero, not a proof of absence. It makes the next direct instance
 * cost a visible line.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { GLOBAL_KEK_MODELS } from '@/lib/db/encryption-middleware';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** Write verbs that carry a `data:` payload. */
const WRITE_VERBS = ['create', 'createMany', 'update', 'updateMany', 'upsert'];

/**
 * Sites where a global-client write to an encrypted tenant-keyed column is
 * deliberate. EMPTY, and meant to stay that way: there is no legitimate reason
 * to store a tenant's content under the master KEK. An entry needs a written
 * reason and an issue.
 */
const ALLOWED: ReadonlyArray<{ file: string; why: string }> = [];

/** `AssistantTurn` -> `assistantTurn`, as a Prisma client property. */
const clientProp = (model: string): string => model[0].toLowerCase() + model.slice(1);

/** Models whose encrypted columns are protected by a PER-TENANT DEK. */
function tenantKeyedModels(): Array<[string, readonly string[]]> {
    return Object.entries(ENCRYPTED_FIELDS).filter(([model]) => !GLOBAL_KEK_MODELS.has(model)) as Array<
        [string, readonly string[]]
    >;
}

/** The balanced-paren argument text of a call starting at `openParen`. */
function callArgument(src: string, openParen: number): string {
    let depth = 1;
    let i = openParen + 1;
    let out = '';
    while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        if (depth > 0) out += c;
        i += 1;
    }
    return out;
}

function offendersIn(relPath: string, code: string, models: Array<[string, readonly string[]]>): string[] {
    const found: string[] = [];
    for (const [model, columns] of models) {
        for (const verb of WRITE_VERBS) {
            const needle = `prisma.${clientProp(model)}.${verb}`;
            let from = 0;
            for (;;) {
                const at = code.indexOf(needle, from);
                if (at === -1) break;
                from = at + needle.length;
                const open = code.indexOf('(', at + needle.length);
                if (open === -1) continue;
                const arg = callArgument(code, open);
                const written = columns.filter((col) => new RegExp(`\\b${col}\\s*:`).test(arg));
                if (written.length > 0) {
                    found.push(`${relPath}  prisma.${clientProp(model)}.${verb} -> ${model}.{${written.join(',')}}`);
                }
            }
        }
    }
    return found;
}

describe('a write to an encrypted tenant-keyed column binds a farm', () => {
    const models = tenantKeyedModels();
    const files = collectSourceFiles({
        roots: ['src'],
        // Well under the real ~2,350 so a genuine refactor does not trip it,
        // and far enough above zero that an exclude predicate eating the
        // population fails instead of passing over nothing.
        floor: 500,
    });

    it('the population is real — models, columns and files all non-empty', () => {
        // Each of the three is a selection, and an empty selection passes for
        // free. The manifest shrinking to nothing, `GLOBAL_KEK_MODELS` growing
        // to cover everything, or a renamed root would each make this guard a
        // permanent green tick over no code.
        const columnCount = models.reduce((n, [, cols]) => n + cols.length, 0);
        expect(models.length).toBeGreaterThan(10);
        expect(columnCount).toBeGreaterThan(20);
        expect(files.length).toBeGreaterThan(500);
        // eslint-disable-next-line no-console
        console.log(
            `[encrypted-write-scan] ${models.length} tenant-keyed model(s), ${columnCount} column(s), ` +
                `${files.length} file(s), ${ALLOWED.length} allowed`,
        );
    });

    it('the detector matches the shape it is meant to catch', () => {
        // A positive control against SYNTHETIC source, because the real
        // population is zero and a scan over a clean tree is indistinguishable
        // from a scan whose matcher stopped working.
        const [model, columns] = models.find(([, c]) => c.length > 0)!;
        const bad = `const x = await prisma.${clientProp(model)}.create({ data: { ${columns[0]}: 'v' } });`;
        expect(offendersIn('synthetic.ts', bad, models)).toHaveLength(1);

        // And the two shapes that must NOT match: a write through a
        // transaction client, and a write that touches no encrypted column.
        const viaTx = `const x = await db.${clientProp(model)}.create({ data: { ${columns[0]}: 'v' } });`;
        expect(offendersIn('synthetic.ts', viaTx, models)).toHaveLength(0);
        const noEncrypted = `const x = await prisma.${clientProp(model)}.create({ data: { id: 'v' } });`;
        expect(offendersIn('synthetic.ts', noEncrypted, models)).toHaveLength(0);
    });

    it('no global-client write reaches a tenant-keyed encrypted column', () => {
        const offenders: string[] = [];
        for (const abs of files) {
            const rel = path.relative(REPO_ROOT, abs);
            if (ALLOWED.some((a) => a.file === rel)) continue;
            // Comments stripped, so a docblock EXPLAINING this rule — this
            // file's own subject matter — is not reported as breaking it.
            const code = blankNonCode(readFileSync(abs, 'utf8'), { strings: true });
            offenders.push(...offendersIn(rel, code, models));
        }
        expect(offenders).toEqual([]);
    });
});

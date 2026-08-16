/**
 * Every key in a Prisma `include` must be a real relation on that model.
 *
 * ── WHY A GUARD AND NOT THE COMPILER ─────────────────────────────────
 *
 * Because the compiler does not check this. `PrismaTx` (src/lib/db-context.ts)
 * is `Omit<PrismaClient, '$connect' | '$disconnect' | …>`, and that `Omit`
 * DEGRADES the generated delegate typing. Every repository takes a `PrismaTx`,
 * so every `include` / `select` in the repository layer is unchecked.
 *
 * Proven, not assumed: adding
 *
 *     zzzTotallyBogusRelation: { select: { id: true } }
 *
 * to an include in `WorkItemRepository.ts` and running `npx tsc --noEmit`
 * produces ZERO errors.
 *
 * ── WHAT THAT COST ───────────────────────────────────────────────────
 *
 * GRC teardown phase 3 dropped 47 tables, 44 enums and 5 columns from live
 * agri tables. `tsc` was clean throughout, and the full 1,578-suite jest run
 * was green — because unit tests mock Prisma, so a query that throws against a
 * real database passes against a mock. Two live 500s shipped to a PR branch:
 *
 *   - `WorkItemRepository.getById` included `practice`. It is the FIRST
 *     statement in `getTask`, `setTaskStatus` AND `deleteTask`, so a farm
 *     operator could not open, complete or delete a task from any of three
 *     surfaces. Found only because one E2E spec happened to click into a task.
 *   - `AssetMaintenanceRepository.listForAsset` included `vendor`, killing the
 *     Maintenance tab for every asset in every tenant. Nothing found this —
 *     no E2E covers that tab.
 *
 * A schema deletion is therefore not a compile-time event in this codebase. It
 * is a runtime event, discoverable only by executing the query. This guard is
 * the substitute for the type-check that does not happen.
 *
 * ── SCOPE, STATED HONESTLY ───────────────────────────────────────────
 *
 * It validates the TOP-LEVEL keys of `include: { … }` blocks that are lexically
 * attached to a `db.<model>.` / `prisma.<model>.` / `tx.<model>.` call. It does
 * NOT validate:
 *   - nested includes below the first level
 *   - `select` blocks (they mix scalars and relations; a separate, noisier job)
 *   - `where` / `orderBy` / `data` keys
 *   - includes built as a variable and passed in by reference
 *
 * That is a real limit, and it is stated here rather than left for someone to
 * discover: a clean run of this guard means the first level is sound, not that
 * every query is. The right permanent fix is to stop erasing the delegate types
 * — if `PrismaTx` is ever narrowed so that `tsc` checks includes again, DELETE
 * this file rather than carrying both.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseSchemaModels } from '../helpers/prisma-schema-models';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

/** model name (lowercased delegate) -> set of relation field names */
function relationsByDelegate(): Map<string, Set<string>> {
    const models = parseSchemaModels();
    const modelNames = new Set(models.map((m) => m.name));
    const out = new Map<string, Set<string>>();
    for (const m of models) {
        // A relation field is one whose TYPE is another model. Scalars and
        // enums are excluded — those belong in `select`, not `include`.
        const rels = new Set(
            m.fields.filter((f) => modelNames.has(f.type)).map((f) => f.name),
        );
        // Prisma also permits `_count` in any include.
        rels.add('_count');
        out.set(m.name.charAt(0).toLowerCase() + m.name.slice(1), rels);
    }
    return out;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
    return out;
}

/** Slice out the balanced `{ … }` beginning at `open`. */
function balanced(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) return text.slice(open, i + 1);
        }
    }
    return '';
}

/** Top-level keys of an object literal source slice. */
function topLevelKeys(block: string): string[] {
    const body = block.slice(1, -1);
    const keys: string[] = [];
    let depth = 0;
    let atKeyPosition = true;
    let buf = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        if (depth === 0 && c === ',') {
            atKeyPosition = true;
            buf = '';
            continue;
        }
        if (depth === 0 && c === ':' && atKeyPosition) {
            const k = buf.trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.push(k);
            atKeyPosition = false;
            buf = '';
            continue;
        }
        if (depth === 0) buf += c;
    }
    return keys;
}

/**
 * The `{ … }` value of `key` at DEPTH 0 of `block`, or null. Depth matters:
 * an `include` nested inside a `select` describes a different model.
 */
function topLevelObjectValue(block: string, key: string): string | null {
    const body = block.slice(1, -1);
    const offset = 1;
    let depth = 0;
    let atKeyPosition = true;
    let buf = '';
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        if (depth === 0 && c === ',') { atKeyPosition = true; buf = ''; continue; }
        if (depth === 0 && c === ':' && atKeyPosition) {
            if (buf.trim() === key) {
                const open = body.indexOf('{', i);
                if (open === -1) return null;
                // Only an object literal counts; `include: someVar` is out of
                // scope and is declared so in the docblock.
                if (body.slice(i + 1, open).trim() !== '') return null;
                return balanced(block, open + offset);
            }
            atKeyPosition = false;
            buf = '';
            continue;
        }
        if (depth === 0) buf += c;
    }
    return null;
}

export interface BadInclude {
    file: string;
    line: number;
    delegate: string;
    key: string;
}

/** Exported for the mutation proof. */
export function findBadIncludes(
    files: ReadonlyArray<{ rel: string; text: string }>,
    relations: Map<string, Set<string>>,
): BadInclude[] {
    const bad: BadInclude[] = [];
    // `db.task.findFirst({`, `prisma.evidence.findMany({`, `tx.asset.update({`
    const call = /\b(?:db|prisma|tx|client)\.([a-z][A-Za-z0-9]*)\.(?:findFirst|findMany|findUnique|findUniqueOrThrow|findFirstOrThrow|create|update|upsert|delete)\s*\(\s*\{/g;
    for (const f of files) {
        let m: RegExpExecArray | null;
        while ((m = call.exec(f.text)) !== null) {
            const delegate = m[1];
            const known = relations.get(delegate);
            if (!known) continue; // not a model delegate we can resolve
            const argsBlock = balanced(f.text, f.text.indexOf('{', m.index + m[0].length - 1));
            if (!argsBlock) continue;
            // The `include` must be at DEPTH 0 of the args object. A regex
            // scan matched includes at any depth, which flagged
            // `select: { tenantMemberships: { include: { tenant } } }` in
            // sso.ts against `User` — `tenant` is a relation of
            // TenantMembership, not User. A false positive is worse than a
            // miss here: it is how a guard gets disabled.
            const incBlock = topLevelObjectValue(argsBlock, 'include');
            if (!incBlock) continue;
            for (const key of topLevelKeys(incBlock)) {
                if (!known.has(key)) {
                    bad.push({
                        file: f.rel,
                        line: f.text.slice(0, m.index).split('\n').length,
                        delegate,
                        key,
                    });
                }
            }
        }
    }
    return bad;
}

describe('Prisma includes name real relations', () => {
    const relations = relationsByDelegate();
    const files = walk(SRC).map((full) => ({
        rel: full.replace(ROOT + '/', ''),
        text: readFileSync(full, 'utf8'),
    }));

    it('the schema parse and file walk both found something', () => {
        // Guards the guard. Either collapsing to empty makes every result clean.
        expect(relations.size).toBeGreaterThan(50);
        expect(files.length).toBeGreaterThan(200);
        expect(relations.get('task')?.has('comments')).toBe(true);
    });

    it('no include names a relation that does not exist', () => {
        const bad = findBadIncludes(files, relations);
        expect({
            bad: bad.map((b) => `${b.file}:${b.line} ${b.delegate}.include.${b.key}`),
        }).toEqual({ bad: [] });
    });

    // ── Mutation proof ────────────────────────────────────────────────
    describe('the detector actually detects', () => {
        const rels = new Map([['task', new Set(['comments', 'assignee', '_count'])]]);

        it('flags the exact include that shipped two 500s', () => {
            const files = [{
                rel: 'src/app-layer/repositories/WorkItemRepository.ts',
                text: `db.task.findFirst({\n  where: { id },\n  include: {\n    assignee: { select: { id: true } },\n    practice: { select: { id: true, code: true } },\n  },\n})`,
            }];
            const bad = findBadIncludes(files, rels);
            expect(bad).toHaveLength(1);
            expect(bad[0].key).toBe('practice');
        });

        it('accepts an include whose keys are all real relations', () => {
            const files = [{
                rel: 'src/x.ts',
                text: `db.task.findFirst({ include: { assignee: true, comments: { orderBy: { createdAt: 'asc' } } } })`,
            }];
            expect(findBadIncludes(files, rels)).toEqual([]);
        });

        it('allows _count, which Prisma permits on any include', () => {
            const files = [{
                rel: 'src/x.ts',
                text: `db.task.findMany({ include: { _count: { select: { comments: true } } } })`,
            }];
            expect(findBadIncludes(files, rels)).toEqual([]);
        });

        it('does not confuse a nested include key for a top-level one', () => {
            // `createdBy` is nested under `comments` and belongs to a
            // different model; flagging it against `task` would be a false
            // positive, which is how a noisy guard gets disabled.
            const files = [{
                rel: 'src/x.ts',
                text: `db.task.findFirst({ include: { comments: { include: { createdBy: true } } } })`,
            }];
            expect(findBadIncludes(files, rels)).toEqual([]);
        });

        it('does not attribute an include nested under a select to the outer model', () => {
            // The sso.ts false positive: `tenant` is a relation of
            // TenantMembership, reached through User.select. Flagging it
            // against `user` would be wrong.
            const files = [{
                rel: 'src/app-layer/usecases/sso.ts',
                text: `prisma.user.findUnique({ where: { id }, select: { id: true, tenantMemberships: { include: { tenant: { select: { id: true } } } } } })`,
            }];
            expect(findBadIncludes(files, new Map([['user', new Set(['tenantMemberships', '_count'])]]))).toEqual([]);
        });

        it('ignores a delegate it cannot resolve to a model', () => {
            const files = [{ rel: 'src/x.ts', text: `db.somethingElse.findMany({ include: { nope: true } })` }];
            expect(findBadIncludes(files, rels)).toEqual([]);
        });
    });
});

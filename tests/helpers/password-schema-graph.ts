/**
 * Which password-shaped Zod fields a route can reach — FOLLOWING ITS IMPORTS (#1166).
 *
 * ## The `auth/register` examples below are HISTORICAL (#1386)
 *
 * The route `POST /api/auth/register` was retired in #1379. #1386 then measured
 * both its schemas to have no importer and resolved them differently, because
 * the two cost different things to remove: `AuthActionSchema` published no
 * OpenAPI component, so deleting it left the spec byte-identical and it is
 * gone; `AuthRegisterSchema` published `AuthRegisterRequest`, so it is marked
 * `deprecated` and deleted once a client build has shipped against that marker.
 * The reasoning they illustrate is unchanged —
 * a route whose password field lives behind a barrel import still scores zero
 * on a route-file-only scan, which is the whole reason this helper follows the
 * symbol graph — but the two names no longer resolve to anything. Kept as
 * written rather than re-pointed at a live example, because the retired chain
 * is what the design was measured against; grepping for them will find only
 * this prose, and that is expected, not rot.
 *
 * ## The measurement this exists for
 *
 * `tests/guardrails/hibp-coverage.test.ts` pairs a curated list of
 * password-handling routes with a structural scan whose whole job is the
 * routes nobody remembered to curate. That scan matched
 * `password: z.…` against each `src/app/api/**\/route.ts` and nothing else,
 * so it could only ever see a password field DECLARED IN THE ROUTE FILE:
 *
 *     auth/change-password   2 matches   (ChangePasswordSchema, inline)
 *     auth/reset-password    1 match     (ResetPasswordSchema, inline)
 *     auth/register          0 matches   (AuthActionSchema, in @/lib/schemas)
 *
 * The primary signup route scored zero. It is registered by hand, so nothing
 * was exposed — but the half of the guard that catches an UNREGISTERED route
 * would have missed a second signup route written the same way, which is the
 * shape the most important password route in the repo already has.
 *
 * ## Why this follows the SCHEMA graph and not the module graph
 *
 * 40 of the 369 route files import something from `@/lib/schemas`. Scanning
 * the whole of an imported module would therefore mark 40 routes as
 * password-handling to find the 1 that is — a detector with 39 false
 * positives is a detector somebody switches off.
 *
 * So resolution is per-SYMBOL. A route importing `AuthActionSchema` resolves
 * that one binding to its declaration, reads composition out of the
 * declaration (`AuthActionSchema` is built from `AuthRegisterSchema`), and
 * follows that. A route importing `CreateLocationSchema` from the same barrel
 * resolves only `CreateLocationSchema`.
 *
 * Composition is followed only out of a declaration that is itself
 * Zod-shaped (`ZOD_SHAPED_RE`). That bound is a property of the thing being
 * tracked rather than a name heuristic: a route's `prisma` or `signToken`
 * import resolves, finds no `z.`, and stops there.
 *
 * **It is a COST bound, not a correctness bound** — measured, not assumed.
 * Removing the gate and re-running the whole population flags the same three
 * routes, because resolution is per-symbol and `AuthRegisterSchema` is
 * referenced by exactly one other declaration. What changes is the work:
 * 2,558 symbol visits → 97,443 (38x), 634 modules parsed → 811, 0.8s → 4.4s
 * (2026-10-01, 369 routes). So the gate is held by a budget
 * (`WALK_BUDGET_PER_ROUTE`) rather than by an assertion about false
 * positives it does not in fact prevent.
 *
 * ## It parses rather than greps
 *
 * Same reason as `tests/helpers/url-field-parser.ts`: several of these
 * schemas carry docblocks quoting the very expressions being matched —
 * `AuthRegisterSchema`'s own `.openapi()` description contains the word
 * password — and a regex over whole files would read prose as a declaration.
 * Matching runs against the AST text of ONE declaration at a time.
 *
 * ## It matches the field NAME, not the field's spelling (#1166 follow-up)
 *
 * `PASSWORD_FIELD_RE` requires a literal `z.` after the colon, so it saw
 * `password: z.string().min(8)` and nothing else. That is one of two shapes a
 * Zod field takes in this repo, and the other one — `password: PwFieldSchema`,
 * a named sub-schema — is the idiom the schema layer actually prefers for a
 * reusable field (23 uses across 12 files in `src/lib/schemas` and
 * `src/app-layer/schemas`). Measured 2026-10-02 over 374 route files:
 *
 *     detector                                    routes flagged
 *     regex only (before)                              3
 *     + field-name match, Zod-gated (now)              3     same set
 *     + field-name match, UNGATED                      4     staging/seed, false
 *
 * The before/after SET is identical, which is the point: nothing in the tree
 * used the blind shape, so no measurement of the live population could have
 * revealed this. What revealed it was a probe — an unregistered route
 * parsing `z.object({ password: PasswordFieldSchema })`, against which the
 * whole guard passed 13/13 while reporting the inline-shaped probe beside it.
 * `passwordFieldsIn` is the union of the two matchers, so the population can
 * only grow.
 *
 * ## What it deliberately does not do
 *
 * It does not type-check. A schema assembled at runtime (`schemas[key]`), a
 * computed field key (`[FIELD]: z.string()`), or a schema reached through a
 * namespace import is invisible to it. `hibp-coverage` asserts that no route
 * file uses a repo-internal namespace import, so that last gap cannot open
 * without a test saying so.
 *
 * It also reports a DECLARATION, not an ingestion: a route that takes
 * `req.json()` straight into a helper with no Zod field at all is outside
 * this detector by construction. #1216 measured that population (a
 * destructure-site matcher covers `auth/register` and misses the other two)
 * and chose not to bolt a second, differently-blind pattern on beside this
 * one.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

export const REPO_ROOT = path.resolve(__dirname, '../..');

/** Field names that mean "a user-chosen password arrives here". */
export const PASSWORD_FIELD_NAMES = [
    'password',
    'newPassword',
    'currentPassword',
    'confirmPassword',
] as const;

/**
 * Password-field heuristic, unchanged from the scan this replaces.
 *
 * Global, so only ever used with `String.prototype.matchAll` — which clones
 * the regex. A `.test()` on this would carry `lastIndex` into the next
 * caller and answer about the wrong offset.
 */
export const PASSWORD_FIELD_RE = new RegExp(
    `\\b(${PASSWORD_FIELD_NAMES.join('|')})\\s*:\\s*z\\.`,
    'g',
);

/**
 * Does a declaration look like a Zod schema?
 *
 * This gates two different things, and it is a different KIND of gate in
 * each — measured, because the two readings disagree:
 *
 *  - On following COMPOSITION it is a **cost** bound. Removing it reports
 *    the same routes 38x more expensively (#1216, see the module docblock).
 *  - On reporting a HIT it is a **correctness** bound, and the witness is in
 *    the tree: `src/app/api/staging/seed/route.ts` returns
 *    `login: { email, password: 'password123' }` — a property literally
 *    named `password` in a plain object literal. Ungated, field-name
 *    matching flags that route (measured: 4 routes of 374 ungated vs 3
 *    gated). It is a hardcoded seed credential on a handler that 403s in
 *    production, not a user-chosen password, so flagging it is a false
 *    positive — and a false positive is how a guard gets switched off.
 *
 * Non-global on purpose: `.test()` is called on it, and a `/g` regex would
 * make that stateful.
 */
export const ZOD_SHAPED_RE = /\bz\s*\./;

/**
 * Symbol hops to follow from a route before giving up.
 *
 * `auth/register` needs 2 (`AuthActionSchema` → `AuthRegisterSchema`). The
 * cap is a backstop against a cycle the visited set somehow misses, not a
 * budget anyone should be near; `hibp-coverage` asserts the real chain is
 * well inside it, so a schema layer that grew deeper than this would be
 * reported rather than silently truncated.
 */
export const MAX_HOPS = 8;

/**
 * Average symbol visits per route the walk may cost.
 *
 * Measured 6.9 with the composition gate and 264 without it, so this is the
 * assertion that actually holds `ZOD_SHAPED_RE` in place — see the module
 * docblock. 40 sits ~5.8x above today and ~6.6x below the ungated figure;
 * it is an average rather than a total so the budget does not tighten as the
 * route tree grows.
 */
export const WALK_BUDGET_PER_ROUTE = 40;

let lastVisits = 0;

/** Symbol visits the most recent `findPasswordFields` call made. */
export function lastWalkSymbolVisits(): number {
    return lastVisits;
}

const EXTENSIONS = ['.ts', '.tsx'] as const;

/** Where one imported binding came from. */
interface Binding {
    /** The module specifier as written. */
    spec: string;
    /** The name as exported by that module (`default` / `*` are literal). */
    imported: string;
}

interface ModuleIndex {
    /** Top-level declarations by declared name. */
    decls: Map<string, ts.Node>;
    /** Local name → where it came from. Includes `export { X } from '…'`. */
    bindings: Map<string, Binding>;
    /** Specifiers of `export * from '…'`, tried when a name is not local. */
    starExports: string[];
    /** Specifiers of `import * as ns from '…'` — recorded, never followed. */
    namespaceSpecs: string[];
    source: ts.SourceFile;
}

const indexCache = new Map<string, ModuleIndex>();

/**
 * Resolve a module specifier to a file in this repo, or `null`.
 *
 * `@/x` is the tsconfig alias for `src/x`. A bare specifier is a package —
 * there is nothing of ours to follow into one.
 */
export function resolveSpecifier(fromFile: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) {
        base = path.join(REPO_ROOT, 'src', spec.slice(2));
    } else if (spec.startsWith('.')) {
        base = path.resolve(path.dirname(fromFile), spec);
    } else {
        return null;
    }
    const candidates = [
        ...EXTENSIONS.map((e) => `${base}${e}`),
        ...EXTENSIONS.map((e) => path.join(base, `index${e}`)),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

function declaredNames(node: ts.Node): Array<{ name: string; node: ts.Node }> {
    if (ts.isVariableStatement(node)) {
        const out: Array<{ name: string; node: ts.Node }> = [];
        for (const d of node.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, node: d.initializer ?? d });
        }
        return out;
    }
    if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
    ) {
        return [{ name: node.name.text, node }];
    }
    if (ts.isExportAssignment(node)) {
        return [{ name: 'default', node: node.expression }];
    }
    return [];
}

/** Parse a file once and record what it declares and what it imports. */
export function indexModule(abs: string): ModuleIndex {
    const cached = indexCache.get(abs);
    if (cached) return cached;

    const source = ts.createSourceFile(
        abs,
        fs.readFileSync(abs, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
    const index: ModuleIndex = {
        decls: new Map(),
        bindings: new Map(),
        starExports: [],
        namespaceSpecs: [],
        source,
    };

    for (const stmt of source.statements) {
        for (const { name, node } of declaredNames(stmt)) index.decls.set(name, node);

        if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const spec = stmt.moduleSpecifier.text;
            const clause = stmt.importClause;
            if (!clause) continue;
            if (clause.name) index.bindings.set(clause.name.text, { spec, imported: 'default' });
            const named = clause.namedBindings;
            if (named && ts.isNamespaceImport(named)) {
                index.namespaceSpecs.push(spec);
                index.bindings.set(named.name.text, { spec, imported: '*' });
            } else if (named && ts.isNamedImports(named)) {
                for (const el of named.elements) {
                    index.bindings.set(el.name.text, {
                        spec,
                        imported: (el.propertyName ?? el.name).text,
                    });
                }
            }
            continue;
        }

        // `export { X } from './y'` and `export * from './y'` — a barrel.
        if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const spec = stmt.moduleSpecifier.text;
            if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
                for (const el of stmt.exportClause.elements) {
                    index.bindings.set(el.name.text, {
                        spec,
                        imported: (el.propertyName ?? el.name).text,
                    });
                }
            } else if (!stmt.exportClause) {
                index.starExports.push(spec);
            }
        }
    }

    indexCache.set(abs, index);
    return index;
}

/**
 * Password-shaped PROPERTY NAMES declared inside one declaration.
 *
 * `PASSWORD_FIELD_RE` requires the value to begin with a literal `z.`, so it
 * reads `password: z.string().min(8)` and is blind to
 * `password: PasswordFieldSchema`. That second shape is not hypothetical —
 * it is this repo's dominant idiom for a reusable Zod field, used 23 times
 * across 12 files in `src/lib/schemas` and `src/app-layer/schemas`
 * (`category: CostCategorySchema`, `geometry: PolygonGeometrySchema`,
 * `type: IdentityProviderTypeSchema`, …). Measured 2026-10-02: a route
 * parsing `z.object({ password: PasswordFieldSchema })` scored ZERO and the
 * whole guard stayed green at 13 passed with that route unregistered in the
 * tree.
 *
 * So the question asked here is "is a field with this NAME declared?" rather
 * than "is a field with this name declared THIS WAY" — what makes a route
 * password-handling is the name it binds off the request body, not the
 * expression that validates it.
 *
 * Matching is on the AST, so it cannot read prose: `AuthRegisterSchema`'s own
 * `.openapi()` description contains the word password, and a property named
 * `password` inside a docblock is not a `PropertyAssignment`. A computed key
 * (`[FIELD]: z.string()`) is still invisible, as it is to the regex.
 */
export function passwordPropertyNames(node: ts.Node): string[] {
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isPropertyAssignment(n)) {
            const name = ts.isIdentifier(n.name)
                ? n.name.text
                : ts.isStringLiteral(n.name)
                  ? n.name.text
                  : null;
            if (name && (PASSWORD_FIELD_NAMES as readonly string[]).includes(name)) {
                out.push(name);
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
}

/**
 * Every password-shaped field one declaration declares — the UNION of the
 * two detectors, deduplicated.
 *
 * A union rather than a replacement so the population can only grow: the
 * regex keeps whatever it already matched (a `password: z.…` outside a
 * `PropertyAssignment` — in a type literal, say) and the name matcher adds
 * the shapes it could not see. `hibp-coverage` asserts the three known
 * routes still report exactly the fields they did before, which is the
 * assertion that would catch a "widening" that quietly dropped a case.
 */
export function passwordFieldsIn(node: ts.Node, source: ts.SourceFile): string[] {
    const text = node.getText(source);

    // Cheap pre-filter: an AST walk is only worth doing if one of the names
    // appears in the text at all. A property named `password` cannot be
    // present without the substring being present.
    const mentionsAny = PASSWORD_FIELD_NAMES.some((n) => text.includes(n));
    if (!mentionsAny) return [];

    const fields = [...text.matchAll(PASSWORD_FIELD_RE)].map((m) => m[1]);
    if (ZOD_SHAPED_RE.test(text)) fields.push(...passwordPropertyNames(node));
    return [...new Set(fields)];
}

/** Every identifier named inside a declaration, deduplicated. */
function identifiersIn(node: ts.Node): string[] {
    const names = new Set<string>();
    const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) names.add(n.text);
        ts.forEachChild(n, visit);
    };
    visit(node);
    return [...names];
}

/** One password-shaped Zod field, and how the route reaches it. */
export interface PasswordFieldHit {
    /** The field name, e.g. `password`. */
    field: string;
    /** Repo-relative path of the file that DECLARES it. */
    declaredIn: string;
    /** `file#symbol` hops from the route to the declaration, route first. */
    via: readonly string[];
}

interface WorkItem {
    file: string;
    symbol: string;
    via: readonly string[];
}

/**
 * Every password-shaped Zod field reachable from one route file.
 *
 * Inline declarations are reported with `declaredIn` equal to the route
 * itself, so the population the old scan found is a strict subset of this
 * one and the two are directly comparable.
 */
export function findPasswordFields(routeAbs: string): PasswordFieldHit[] {
    const routeRel = path.relative(REPO_ROOT, routeAbs);
    const hits: PasswordFieldHit[] = [];

    const routeIndex = indexModule(routeAbs);

    // 1. Declared in the route file — the only shape the old scan saw. Read
    //    per DECLARATION rather than over the whole file so a docblock
    //    quoting `password: z.string()` cannot register as one.
    for (const [name, node] of routeIndex.decls) {
        for (const field of passwordFieldsIn(node, routeIndex.source)) {
            hits.push({ field, declaredIn: routeRel, via: [`${routeRel}#${name}`] });
        }
    }

    // 2. Reached through an import — the shape it was blind to.
    const seen = new Set<string>();
    const queue: WorkItem[] = [];

    for (const [local, binding] of routeIndex.bindings) {
        const target = resolveSpecifier(routeAbs, binding.spec);
        if (!target) continue;
        // A namespace import has no single symbol to resolve. Recorded by
        // `indexModule` and asserted absent from route files by the guard.
        if (binding.imported === '*') continue;
        queue.push({
            file: target,
            symbol: binding.imported,
            via: [`${routeRel}#${local}`],
        });
    }

    while (queue.length > 0) {
        const item = queue.shift()!;
        const key = `${item.file}#${item.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (item.via.length > MAX_HOPS) continue;

        const index = indexModule(item.file);
        const rel = path.relative(REPO_ROOT, item.file);
        const decl = index.decls.get(item.symbol);

        if (!decl) {
            // Not declared here — a re-export, or behind `export *`.
            const via = [...item.via, `${rel}#${item.symbol}`];
            const forwarded = index.bindings.get(item.symbol);
            if (forwarded && forwarded.imported !== '*') {
                const target = resolveSpecifier(item.file, forwarded.spec);
                if (target) queue.push({ file: target, symbol: forwarded.imported, via });
            } else {
                for (const spec of index.starExports) {
                    const target = resolveSpecifier(item.file, spec);
                    if (target) queue.push({ file: target, symbol: item.symbol, via });
                }
            }
            continue;
        }

        const text = decl.getText(index.source);
        const via = [...item.via, `${rel}#${item.symbol}`];
        for (const field of passwordFieldsIn(decl, index.source)) {
            hits.push({ field, declaredIn: rel, via });
        }

        // Follow composition only out of a Zod-shaped declaration. Removing
        // this gate reports the same routes 38x more expensively — see
        // WALK_BUDGET_PER_ROUTE, which is what holds it here.
        if (!ZOD_SHAPED_RE.test(text)) continue;

        for (const ref of identifiersIn(decl)) {
            if (ref === item.symbol) continue;
            if (index.decls.has(ref)) {
                queue.push({ file: item.file, symbol: ref, via });
                continue;
            }
            const binding = index.bindings.get(ref);
            if (!binding || binding.imported === '*') continue;
            const target = resolveSpecifier(item.file, binding.spec);
            if (target) queue.push({ file: target, symbol: binding.imported, via });
        }
    }

    lastVisits = seen.size;
    return hits;
}

/** Repo-internal namespace imports in a file — the one gap, made visible. */
export function namespaceImportSpecs(abs: string): string[] {
    return indexModule(abs).namespaceSpecs.filter(
        (spec) => resolveSpecifier(abs, spec) !== null,
    );
}

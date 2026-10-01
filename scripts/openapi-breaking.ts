/**
 * Breaking-change detection for the API contract.
 *
 * WHY A SEPARATE NOTION FROM "DRIFT". The existing contract test tells you the
 * spec CHANGED. That is necessary and insufficient: it cannot tell you whether
 * removing a field breaks an installed client. And the asymmetry matters more
 * here than in most products — an App Store binary cannot be rolled back the
 * way a Watchtower-updated image can, so a shape break's only fast remedy is a
 * SERVER revert.
 *
 * WHY ADDITIVE MUST STAY CHEAP. A guard that fires on every new optional field
 * gets routed around, and then it protects nothing. That is not hypothetical
 * in this repo: the OI-3 auth guard hard-pinned an action version and reddened
 * on routine Dependabot bumps until it was relaxed (#599). A contract guard
 * that cries wolf earns the same contempt. So the classifier below is
 * deliberately narrow — it reports only changes that can break a client that is
 * already installed and cannot be updated on our schedule.
 *
 * ── DEPTH, AND WHY IT IS SPELLED OUT (#1214) ────────────────────────────────
 *
 * This module used to compare exactly one level: `schema.properties[prop]`, and
 * nothing below it. Measured on the committed spec, that left 259 of 1541
 * described properties — spread over 45 of 204 schemas — outside the gate
 * entirely, and NOTHING SAID SO. Deleting
 * `CurrentUser.properties.user.properties.role` reported clean; retyping it
 * from `string` to `number` reported clean. For every nested field the verdict
 * was a non-verdict dressed as a pass.
 *
 * The walk below is now a PARALLEL RECURSION over previous and next, so the
 * same classes are scored at every depth and reported with a dotted path
 * (`user.role`). Path syntax, so a report is unambiguous:
 *
 *   `a.b`        an object property
 *   `a[]`        the element schema of an array (`items`)
 *   `a[0]`       a tuple position (`prefixItems`)
 *   `a{}`        the value schema of a free-form map (`additionalProperties`)
 *   `a/allOf[0]` a composition member
 *
 * ── THE `$ref` DECISION: OPAQUE, NOT RESOLVED ───────────────────────────────
 *
 * A `$ref` is NOT followed. Three reasons, in order of weight:
 *
 *   1. Nothing is lost. Every `$ref` in this spec points at a named schema
 *      under `components.schemas` (measured: 54 distinct refs, 0 that do not
 *      resolve, and `openapi-breaking-depth.test.ts` keeps asserting it), and
 *      the outer loop already compares every named schema on its own. A field
 *      removed from `UserRef` IS reported — as `UserRef.id`, under its own
 *      name, rather than at each of the nine paths that reference it.
 *   2. Resolving would OVER-report, which is the failure this module's
 *      preamble exists to avoid: one field removed from a nine-times-
 *      referenced schema would produce ten identical findings and train
 *      people to skim the report.
 *   3. Termination becomes structural instead of bookkept. An unresolved
 *      OpenAPI document is a tree; a resolved one is a graph that can cycle.
 *      An ancestor guard is still carried below as belt-and-braces (a
 *      hand-built cyclic document is exercised by the depth test), but it is
 *      not what the recursion relies on.
 *
 * The residual gaps that choice leaves, stated plainly rather than discovered
 * later:
 *
 *   - a `$ref` REPOINTED at a different target changes the shape at that path
 *     without changing either schema, so it is detected explicitly as
 *     `ref-retargeted`;
 *   - a refactor that swaps an inline object for a `$ref` (or back) makes the
 *     two sides structurally incomparable at that path, so the subtree is
 *     SKIPPED rather than reported as twenty removed properties. Skipping is
 *     the deliberate choice: #1214's own second candidate fix was a mass
 *     inline -> `$ref` extraction, and a merge gate that reddens on a
 *     shape-preserving refactor is a gate someone disables.
 */

export interface BreakingChange {
    /** Machine-readable class, so the report can be grouped and counted. */
    kind:
        | 'schema-removed'
        | 'property-removed'
        | 'property-now-required'
        | 'enum-narrowed'
        | 'type-changed'
        | 'ref-retargeted';
    schema: string;
    /**
     * Property path within the schema, when the change is property-scoped.
     * Dotted and depth-aware since #1214 — `user.role`, `rows[].id`,
     * `featureFlags{}`. Absent when the change is about the schema node itself.
     */
    property?: string;
    detail: string;
}

type Json = Record<string, unknown>;

/** Composition keywords. Descended positionally, on an equal member count. */
const COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf'] as const;

function schemasOf(spec: Json): Record<string, Json> {
    const components = spec.components as Json | undefined;
    return (components?.schemas as Record<string, Json>) ?? {};
}

function propsOf(schema: Json): Record<string, Json> {
    return (schema.properties as Record<string, Json>) ?? {};
}

function requiredOf(schema: Json): string[] {
    const r = schema.required;
    return Array.isArray(r) ? (r as string[]) : [];
}

/** `type` may be a string or an array (nullable unions). Normalise to a set. */
function typeSet(schema: Json): Set<string> {
    const t = schema.type;
    if (typeof t === 'string') return new Set([t]);
    if (Array.isArray(t)) return new Set(t.map(String));
    return new Set();
}

function enumOf(schema: Json): Set<string> | null {
    const e = schema.enum;
    if (!Array.isArray(e)) return null;
    return new Set(e.map((v) => JSON.stringify(v)));
}

function isSchemaNode(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `$ref` target at this node, or null. Never followed — see the header. */
function refOf(schema: Json): string | null {
    return typeof schema.$ref === 'string' ? schema.$ref : null;
}

/**
 * Append one path segment. `[`, `{` and `/` are self-delimiting, so only a
 * plain property name takes a dot.
 */
function join(path: string, segment: string): string {
    if (path === '') return segment;
    const delimited = /^[[{/]/.test(segment);
    return delimited ? `${path}${segment}` : `${path}.${segment}`;
}

/**
 * Every property path this module COMPARES, fully qualified (`Schema.a.b`).
 *
 * Exported because a gate that cannot say what it covers is the defect #1214
 * was about. `tests/contracts/openapi-breaking-depth.test.ts` asserts this set
 * is a superset of an independently written census of the spec, so a future
 * narrowing of the walk fails loudly instead of quietly shrinking the gate's
 * field of view.
 */
export function collectComparedPaths(spec: Json): string[] {
    const out: string[] = [];
    for (const [name, schema] of Object.entries(schemasOf(spec))) {
        if (isSchemaNode(schema)) collectFrom(schema, name, '', out, new Set());
    }
    return out;
}

function collectFrom(
    node: Json,
    schemaName: string,
    path: string,
    out: string[],
    ancestors: Set<Json>,
): void {
    if (ancestors.has(node)) return;
    if (refOf(node) !== null) return;
    const inner = new Set(ancestors).add(node);

    for (const [prop, child] of Object.entries(propsOf(node))) {
        const childPath = join(path, prop);
        out.push(`${schemaName}.${childPath}`);
        if (isSchemaNode(child)) collectFrom(child, schemaName, childPath, out, inner);
    }

    if (isSchemaNode(node.items)) {
        collectFrom(node.items, schemaName, join(path, '[]'), out, inner);
    }
    if (isSchemaNode(node.additionalProperties)) {
        collectFrom(node.additionalProperties, schemaName, join(path, '{}'), out, inner);
    }
    if (Array.isArray(node.prefixItems)) {
        node.prefixItems.forEach((member, i) => {
            if (isSchemaNode(member)) collectFrom(member, schemaName, join(path, `[${i}]`), out, inner);
        });
    }
    for (const key of COMPOSITION_KEYS) {
        const members = node[key];
        if (!Array.isArray(members)) continue;
        members.forEach((member, i) => {
            if (isSchemaNode(member)) {
                collectFrom(member, schemaName, join(path, `/${key}[${i}]`), out, inner);
            }
        });
    }
}

/**
 * Compare a previous spec against the next one and return only the changes
 * that could break an already-installed client.
 *
 * DIRECTIONALITY IS THE WHOLE POINT, so it is spelled out per class:
 *
 *   - a REMOVED schema or property breaks a client that reads it;
 *   - a property becoming REQUIRED breaks a client that does not send it;
 *   - an enum LOSING a member breaks a client that still sends it — gaining one
 *     does not, so widening is silent;
 *   - a CHANGED type breaks a client that parses the old one, but WIDENING a
 *     type (string -> string|null) is a superset and is silent;
 *   - a `$ref` REPOINTED at a different schema changes the shape at that path
 *     without changing either schema (#1214).
 *
 * Everything else — new schemas, new optional properties, wider enums,
 * descriptions, examples — returns nothing at all. Since #1214 every class
 * above is scored at EVERY depth, not only on a schema's top-level properties.
 */
export function findBreakingChanges(previous: Json, next: Json): BreakingChange[] {
    const out: BreakingChange[] = [];
    const prevSchemas = schemasOf(previous);
    const nextSchemas = schemasOf(next);

    for (const [name, prevSchema] of Object.entries(prevSchemas)) {
        const nextSchema = nextSchemas[name];

        if (!nextSchema) {
            out.push({
                kind: 'schema-removed',
                schema: name,
                detail: `schema "${name}" no longer exists; a client decoding it fails outright`,
            });
            continue;
        }

        if (isSchemaNode(prevSchema) && isSchemaNode(nextSchema)) {
            compareNode(prevSchema, nextSchema, name, '', out, new Set());
        }
    }

    return out;
}

/**
 * One node of the parallel walk. `path` is the location WITHIN the schema, so
 * `''` is the schema node itself.
 *
 * Reports at this node, then recurses into every child both sides share. A
 * child present on one side only is reported (a removal) or ignored (an
 * addition) and NOT descended into: one deleted object must read as one
 * finding, not as one finding per field it happened to contain.
 */
function compareNode(
    prev: Json,
    next: Json,
    schema: string,
    path: string,
    out: BreakingChange[],
    ancestors: Set<Json>,
): void {
    // Belt-and-braces. A `$ref` is never followed, so an OpenAPI document is a
    // tree and this cannot fire on real input. It is here because a caller may
    // hand us an in-memory document with self-referential nodes, and "the gate
    // hung" is a worse failure than "the gate stopped early".
    if (ancestors.has(prev)) return;
    const inner = new Set(ancestors).add(prev);

    const at = path === '' ? undefined : path;
    const label = path === '' ? `schema "${schema}"` : `"${path}"`;

    // ── A repointed `$ref` ──────────────────────────────────────────────
    // Only when BOTH sides are refs. An inline <-> `$ref` swap is a refactor
    // the gate must tolerate (see the header), and it also makes the two sides
    // structurally incomparable, so that subtree is skipped.
    const prevRef = refOf(prev);
    const nextRef = refOf(next);
    if (prevRef !== null && nextRef !== null) {
        if (prevRef !== nextRef) {
            out.push({
                kind: 'ref-retargeted',
                schema,
                property: at,
                detail: `${label} now points at ${nextRef} (was ${prevRef}); the shape a client decodes at this path changed`,
            });
        }
        // A `$ref` node carries no shape of its own. Nothing below to compare.
        return;
    }
    if (prevRef !== null || nextRef !== null) return;

    // ── Type and enum narrowing, at every depth BELOW the schema root ───
    //
    // The root is deliberately exempt, and the exemption is measured rather
    // than assumed. Scoring a named schema's OWN `type` looks like a free
    // extra class, but replaying this classifier over all 42 commits that
    // touched the committed spec produced exactly one finding from it, and
    // that finding was wrong: #1109 moved `FieldBriefing`'s nullability from
    // the named schema (`type: ["object","null"]`) out to the referencing
    // site (`FieldBriefingPayload.briefing: anyOf [$ref, {type: "null"}]`).
    // The shape a client decodes was unchanged; only where the `null` was
    // written moved. #1214 is about DEPTH, and the root was never the blind
    // spot — so the root keeps exactly the classes it had, and the recursion
    // adds its classes strictly below it. One false "breaking change" on a
    // legitimate PR is what gets a merge gate switched off.
    if (path !== '') {
        // WIDENING is not breaking. string -> string|null is a superset, so
        // only report when the previous set is not contained in the next.
        const prevTypes = typeSet(prev);
        const nextTypes = typeSet(next);
        if (prevTypes.size > 0 && nextTypes.size > 0) {
            const lost = [...prevTypes].filter((t) => !nextTypes.has(t));
            if (lost.length > 0) {
                out.push({
                    kind: 'type-changed',
                    schema,
                    property: at,
                    detail: `${label} no longer accepts ${lost.join('|')} (was ${[...prevTypes].join('|')}, now ${[...nextTypes].join('|')})`,
                });
            }
        }

        // Enum narrowing. Gaining members is additive and silent.
        const prevEnum = enumOf(prev);
        const nextEnum = enumOf(next);
        if (prevEnum && nextEnum) {
            const lost = [...prevEnum].filter((v) => !nextEnum.has(v));
            if (lost.length > 0) {
                out.push({
                    kind: 'enum-narrowed',
                    schema,
                    property: at,
                    detail: `${label} no longer accepts ${lost.join(', ')}; a client still sending it is rejected`,
                });
            }
        }
    }

    // ── A property becoming required breaks any client that omits it. ───
    const prevRequired = new Set(requiredOf(prev));
    for (const req of requiredOf(next)) {
        if (!prevRequired.has(req)) {
            const reqPath = join(path, req);
            out.push({
                kind: 'property-now-required',
                schema,
                property: reqPath,
                detail: `"${reqPath}" is now required; a client that omits it is rejected`,
            });
        }
    }

    // ── Properties: removal, then recurse into the survivors. ───────────
    const prevProps = propsOf(prev);
    const nextProps = propsOf(next);
    for (const [prop, prevChild] of Object.entries(prevProps)) {
        const childPath = join(path, prop);
        const nextChild = nextProps[prop];
        if (!nextChild) {
            out.push({
                kind: 'property-removed',
                schema,
                property: childPath,
                detail: `"${childPath}" was removed; a client reading it gets undefined`,
            });
            continue;
        }
        if (isSchemaNode(prevChild) && isSchemaNode(nextChild)) {
            compareNode(prevChild, nextChild, schema, childPath, out, inner);
        }
    }

    // ── Array elements, free-form map values, tuple positions. ──────────
    if (isSchemaNode(prev.items) && isSchemaNode(next.items)) {
        compareNode(prev.items, next.items, schema, join(path, '[]'), out, inner);
    }
    if (isSchemaNode(prev.additionalProperties) && isSchemaNode(next.additionalProperties)) {
        compareNode(
            prev.additionalProperties,
            next.additionalProperties,
            schema,
            join(path, '{}'),
            out,
            inner,
        );
    }
    comparePositional(prev.prefixItems, next.prefixItems, (i) => join(path, `[${i}]`), schema, out, inner);

    // ── Composition members, positionally, and only on an equal count. ──
    // An unequal count means a member was inserted, removed or reordered;
    // comparing index i against index i would then invent findings for
    // properties that merely MOVED. Skipping is honest under-reporting, and
    // the alternative is noise — noise is what gets a merge gate turned off.
    for (const key of COMPOSITION_KEYS) {
        comparePositional(prev[key], next[key], (i) => join(path, `/${key}[${i}]`), schema, out, inner);
    }
}

function comparePositional(
    prevList: unknown,
    nextList: unknown,
    pathAt: (i: number) => string,
    schema: string,
    out: BreakingChange[],
    ancestors: Set<Json>,
): void {
    if (!Array.isArray(prevList) || !Array.isArray(nextList)) return;
    if (prevList.length !== nextList.length) return;
    prevList.forEach((prevMember, i) => {
        const nextMember = nextList[i];
        if (isSchemaNode(prevMember) && isSchemaNode(nextMember)) {
            compareNode(prevMember, nextMember, schema, pathAt(i), out, ancestors);
        }
    });
}

/** Human-readable report for a CI failure message. */
export function formatBreakingChanges(changes: BreakingChange[]): string {
    return changes
        .map((c) => `  [${c.kind}] ${c.schema}${c.property ? `.${c.property}` : ''} — ${c.detail}`)
        .join('\n');
}

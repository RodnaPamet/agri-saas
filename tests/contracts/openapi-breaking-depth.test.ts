/**
 * DEPTH calibration for the breaking-change classifier (#1214).
 *
 * The sibling file `openapi-breaking-change.test.ts` calibrates the CLASSES.
 * This one calibrates the classifier's FIELD OF VIEW, because that is what was
 * broken: `findBreakingChanges` compared exactly `schema.properties[prop]` and
 * nothing below it, so 293 of 1575 described property sites were outside the
 * gate and NOTHING SAID SO. Deleting `CurrentUser.user.role` reported clean.
 *
 * The old proof could not have caught that. It picked its victim with
 * `Object.keys(props)[0]` — a TOP-LEVEL key by construction — so the healthy
 * world and the broken world produced the same output. A probe with no
 * discriminating power. Every proof below therefore does two things the old one
 * did not:
 *
 *   1. names its victim's DEPTH and asserts it, so the proof cannot drift back
 *      to a top-level key without reddening;
 *   2. sweeps the DERIVED population — every site the committed spec actually
 *      has below depth 0 — rather than one hand-picked example, so the
 *      denominator is printed and a narrowing of the walk fails loudly instead
 *      of shrinking the gate's view quietly.
 *
 * Both directions are measured. Under-reporting was the bug; OVER-reporting is
 * the failure that gets a merge gate switched off, so the silent cases carry
 * the same exhaustive sweep as the loud ones, plus a mutation proof that the
 * sweep machinery can still fire at all — an assertion of emptiness over an
 * empty selection is a pass about nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectComparedPaths, findBreakingChanges } from '../../scripts/openapi-breaking';

/** A JSON-schema node as read off disk. Leaves stay `unknown` and get narrowed. */
type Node = Record<string, unknown>;

const COMMITTED = path.resolve(__dirname, '../../src/generated/openapi.json');
const spec = JSON.parse(fs.readFileSync(COMMITTED, 'utf-8')) as Node;
const schemas = ((spec.components as Node).schemas ?? {}) as Record<string, Node>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const asNode = (value: unknown): Node | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Node) : null;

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

/** The `properties` map, or an empty one. */
const propsOf = (node: Node): Node => asNode(node.properties) ?? {};

/**
 * The `properties` map, or a THROW. Used on the mutation paths: a chain that
 * stopped resolving would otherwise make every "stays silent" assertion pass
 * for the wrong reason.
 */
function requireProps(node: Node): Node {
    const p = asNode(node.properties);
    if (!p) throw new Error('expected a `properties` map at this node');
    return p;
}

/** Follow a chain of object keys / array indices, throwing rather than drifting. */
function at(root: unknown, chain: readonly string[]): Node {
    let current: unknown = root;
    for (const segment of chain) {
        if (Array.isArray(current)) current = current[Number(segment)];
        else {
            const node = asNode(current);
            if (!node) throw new Error(`chain broke before "${segment}" in ${chain.join('/')}`);
            current = node[segment];
        }
    }
    const landed = asNode(current);
    if (!landed) throw new Error(`chain ${chain.join('/')} did not land on an object`);
    return landed;
}

const COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf'] as const;

/**
 * Compare ONE schema in isolation. Sound because a `$ref` is never followed, so
 * a mutation inside schema X can only ever be reported against X — and it makes
 * a 293-site sweep cost milliseconds instead of minutes.
 */
function compareSchema(name: string, previous: Node, next: Node) {
    return findBreakingChanges(
        { components: { schemas: { [name]: previous } } },
        { components: { schemas: { [name]: next } } },
    );
}

const signature = (c: { kind: string; schema: string; property?: string }) =>
    `${c.kind}:${c.schema}.${c.property ?? ''}`;

// ─────────────────────────────────────────────────────────────────────────────
// The `$ref` decision, and the measurement it rests on
// ─────────────────────────────────────────────────────────────────────────────
describe('the $ref decision — OPAQUE, and the measurement that justifies it', () => {
    function everyRef(): string[] {
        const out: string[] = [];
        const walk = (node: unknown): void => {
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            const obj = asNode(node);
            if (!obj) return;
            for (const [key, value] of Object.entries(obj)) {
                if (key === '$ref' && typeof value === 'string') out.push(value);
                else walk(value);
            }
        };
        walk(schemas);
        return out;
    }

    it('every $ref resolves to a NAMED schema — which is why not following one loses nothing', () => {
        // The load-bearing fact. Because each target is itself a member of
        // components.schemas, the outer loop already compares it on its own, so
        // a change to a $ref target IS reported, under the target's own name.
        // If a $ref ever points somewhere else — a path item, an external file,
        // a nested anchor — the opaque treatment starts hiding real breaks, and
        // this assertion is the thing that says so.
        const refs = everyRef();
        const named = new Set(Object.keys(schemas));
        const prefix = '#/components/schemas/';
        const unresolved = [...new Set(refs)].filter(
            (ref) => !ref.startsWith(prefix) || !named.has(ref.slice(prefix.length)),
        );
        console.log(
            `[#1214] $ref sites: ${refs.length} (${new Set(refs).size} distinct), unresolved: ${unresolved.length}`,
        );
        // `refSites` is here so a spec that lost every $ref cannot pass this as
        // "nothing unresolved".
        expect({ refSites: refs.length > 0, unresolved }).toEqual({ refSites: true, unresolved: [] });
    });

    it('reports a change to a $ref TARGET once, under the target — not once per referencing site', () => {
        // The over-reporting this decision buys out of: resolving would turn one
        // removed field into one finding per referencing path and train people
        // to skim the report.
        const serialised = JSON.stringify(schemas);
        const target = Object.keys(schemas).find(
            (name) =>
                serialised.split(`"#/components/schemas/${name}"`).length - 1 >= 2 &&
                Object.keys(propsOf(schemas[name])).length > 0,
        );
        expect(target).toBeDefined();

        const mutated = clone(spec);
        const schema = at(mutated, ['components', 'schemas', target as string]);
        const victim = Object.keys(requireProps(schema))[0];
        delete requireProps(schema)[victim];
        const required = asArray(schema.required);
        if (required) schema.required = required.filter((r) => r !== victim);

        expect(findBreakingChanges(spec, mutated)).toEqual([
            {
                kind: 'property-removed',
                schema: target,
                property: victim,
                detail: expect.stringContaining('was removed'),
            },
        ]);
    });

    it('a REPOINTED $ref is reported — the one class an opaque treatment would otherwise miss', () => {
        const before = {
            components: { schemas: { A: { type: 'object', properties: { x: { $ref: '#/components/schemas/B' } } } } },
        };
        const after = {
            components: { schemas: { A: { type: 'object', properties: { x: { $ref: '#/components/schemas/C' } } } } },
        };
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('ref-retargeted');
        expect(found[0].property).toBe('x');
    });

    it('an inline object EXTRACTED to a $ref stays SILENT — #1214 proposed exactly that refactor', () => {
        // The shape is unchanged; only where it is written moved. A gate that
        // reports twenty removed properties here is a gate someone disables.
        const inline = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } };
        const before = { components: { schemas: { Outer: { type: 'object', properties: { nested: inline } } } } };
        const after = {
            components: {
                schemas: {
                    Outer: { type: 'object', properties: { nested: { $ref: '#/components/schemas/Nested' } } },
                    Nested: inline,
                },
            },
        };
        expect(findBreakingChanges(before, after)).toEqual([]);
        // The REVERSE direction is not symmetric, deliberately: inlining the
        // ref and dropping the now-unused component deletes a NAMED schema,
        // which a generated client has a type for. That is reported — once, as
        // the schema removal it is, and NOT as two removed properties.
        expect(findBreakingChanges(after, before)).toEqual([
            { kind: 'schema-removed', schema: 'Nested', detail: expect.stringContaining('no longer exists') },
        ]);
    });

    it('the real spec, extracted the way #1214 suggested, reports nothing', () => {
        const mutated = clone(spec);
        const target = at(mutated, ['components', 'schemas']);
        target.CurrentUserUser = clone(at(target, ['CurrentUser', 'properties', 'user']));
        requireProps(at(target, ['CurrentUser'])).user = { $ref: '#/components/schemas/CurrentUserUser' };
        expect(findBreakingChanges(spec, mutated)).toEqual([]);
    });

    it('TERMINATES on a self-referential document — executed, not asserted about', () => {
        // Not reachable from a parsed JSON file, which is a tree. It IS
        // reachable from an in-memory document, and "the gate hung" is a worse
        // failure than "the gate stopped early", so the ancestor guard is
        // exercised rather than merely present in source.
        const previous: Node = { type: 'object', properties: {} };
        requireProps(previous).self = previous;
        requireProps(previous).leaf = { type: 'string' };
        const next: Node = { type: 'object', properties: {} };
        requireProps(next).self = next;
        // `leaf` is GONE — the walk must still reach it before it stops.
        expect(
            findBreakingChanges(
                { components: { schemas: { Recursive: previous } } },
                { components: { schemas: { Recursive: next } } },
            ),
        ).toEqual([
            {
                kind: 'property-removed',
                schema: 'Recursive',
                property: 'leaf',
                detail: expect.stringContaining('was removed'),
            },
        ]);
        // And the path collector, which recurses over the same shape.
        expect(collectComparedPaths({ components: { schemas: { Recursive: previous } } }).length).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The denominator — what the gate can SEE
// ─────────────────────────────────────────────────────────────────────────────
describe('what the gate can SEE — and the number printed next to it', () => {
    /** Depth-0 enumeration: exactly what the classifier compared before #1214. */
    function depth0Paths(): Set<string> {
        const out = new Set<string>();
        for (const [name, schema] of Object.entries(schemas)) {
            for (const prop of Object.keys(propsOf(schema))) out.add(`${name}.${prop}`);
        }
        return out;
    }

    /**
     * An INDEPENDENTLY written census. The TRAVERSAL shares no code with
     * `collectComparedPaths` — that is where a narrowing would hide, so that is
     * where the independence has to be. The path SYNTAX is the module's
     * documented one (`[`, `{` and `/` self-delimit; a plain name takes a dot),
     * restated in one line rather than imported, because two walks disagreeing
     * only about punctuation would report phantom gaps and teach nobody
     * anything.
     */
    function census(): Set<string> {
        const out = new Set<string>();
        const join = (prefix: string, segment: string) =>
            prefix === '' ? segment : /^[[{/]/.test(segment) ? `${prefix}${segment}` : `${prefix}.${segment}`;

        const walk = (value: unknown, name: string, where: string, seen: Set<Node>): void => {
            const node = asNode(value);
            if (!node || seen.has(node) || typeof node.$ref === 'string') return;
            const inner = new Set(seen).add(node);

            for (const [prop, child] of Object.entries(propsOf(node))) {
                out.add(`${name}.${join(where, prop)}`);
                walk(child, name, join(where, prop), inner);
            }
            for (const key of COMPOSITION_KEYS) {
                asArray(node[key])?.forEach((member, i) => walk(member, name, join(where, `/${key}[${i}]`), inner));
            }
            if (node.items !== undefined) walk(node.items, name, join(where, '[]'), inner);
            asArray(node.prefixItems)?.forEach((member, i) => walk(member, name, join(where, `[${i}]`), inner));
            if (node.additionalProperties !== undefined) {
                walk(node.additionalProperties, name, join(where, '{}'), inner);
            }
        };
        for (const [name, schema] of Object.entries(schemas)) walk(schema, name, '', new Set());
        return out;
    }

    it('compares every path an independent census of the spec finds', () => {
        const compared = new Set(collectComparedPaths(spec));
        const expected = census();
        const before = depth0Paths();
        const missing = [...expected].filter((p) => !compared.has(p));

        console.log(
            `[#1214] schemas ${Object.keys(schemas).length} | BEFORE (depth-0 only) ${before.size} | ` +
                `AFTER (walked) ${compared.size} | newly visible ${compared.size - before.size} | ` +
                `independent census ${expected.size}`,
        );
        expect({ missing: missing.slice(0, 20), count: missing.length }).toEqual({ missing: [], count: 0 });
    });

    it('sees strictly MORE than the depth-0 view it replaced — the #1214 delta, derived not hardcoded', () => {
        const compared = new Set(collectComparedPaths(spec));
        const before = depth0Paths();
        // Every depth-0 path is still compared — no regression in what worked …
        expect([...before].filter((p) => !compared.has(p))).toEqual([]);
        // … and there is a real nested population on top of it. A spec with no
        // nested objects would make the sweeps below vacuous, so the population
        // is asserted rather than assumed.
        expect(compared.size).toBeGreaterThan(before.size);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The nested mutation proof — a victim chosen for its depth, on purpose
// ─────────────────────────────────────────────────────────────────────────────
describe('MUTATION PROOF at DEPTH — the measured victim from #1214', () => {
    const SCHEMA = 'CurrentUser';
    const PARENT = 'user';
    const VICTIM = 'role';

    it('the victim is genuinely NESTED — the assertion the old proof was missing', () => {
        // The old proof took `Object.keys(props)[0]`, top-level by
        // construction, so it passed in both the healthy and the broken world.
        // This pins the victim's depth so the proof cannot drift back.
        expect(Object.keys(propsOf(schemas[SCHEMA]))).toContain(PARENT);
        expect(Object.keys(propsOf(schemas[SCHEMA]))).not.toContain(VICTIM);
        expect(Object.keys(propsOf(at(schemas[SCHEMA], ['properties', PARENT])))).toContain(VICTIM);
    });

    it('CONTROL A — a DEPTH-0 removal is still reported, exactly once (the positive control)', () => {
        const mutated = clone(spec);
        delete requireProps(at(mutated, ['components', 'schemas', SCHEMA])).tenant;
        expect(findBreakingChanges(spec, mutated).map(signature)).toEqual([`property-removed:${SCHEMA}.tenant`]);
    });

    it('CONTROL B — a DEPTH-1 removal (CurrentUser.user.role) is reported; it used to be silent', () => {
        const mutated = clone(spec);
        const parent = at(mutated, ['components', 'schemas', SCHEMA, 'properties', PARENT]);
        delete requireProps(parent)[VICTIM];
        parent.required = (asArray(parent.required) ?? []).filter((r) => r !== VICTIM);
        expect(findBreakingChanges(spec, mutated).map(signature)).toEqual([
            `property-removed:${SCHEMA}.${PARENT}.${VICTIM}`,
        ]);
    });

    it('CONTROL C — a DEPTH-1 narrowing (role: string -> number) is reported; it used to be silent', () => {
        const mutated = clone(spec);
        requireProps(at(mutated, ['components', 'schemas', SCHEMA, 'properties', PARENT]))[VICTIM] = {
            type: 'number',
        };
        expect(findBreakingChanges(spec, mutated).map(signature)).toEqual([
            `type-changed:${SCHEMA}.${PARENT}.${VICTIM}`,
        ]);
    });

    it('a DEPTH-1 property becoming required is reported, with its path', () => {
        const mutated = clone(spec);
        const parent = at(mutated, ['components', 'schemas', SCHEMA, 'properties', PARENT]);
        requireProps(parent).nickname = { type: 'string' };
        parent.required = [...(asArray(parent.required) ?? []), 'nickname'];
        expect(findBreakingChanges(spec, mutated).map(signature)).toEqual([
            `property-now-required:${SCHEMA}.${PARENT}.nickname`,
        ]);
    });

    it('deleting a nested OBJECT reports ONE finding, not one per field it contained', () => {
        // Volume matters as much as the verdict: `tenant` holds three
        // properties, and three extra findings for one deletion is the start of
        // a report nobody reads.
        expect(Object.keys(propsOf(at(schemas[SCHEMA], ['properties', 'tenant']))).length).toBeGreaterThan(1);
        const mutated = clone(spec);
        delete requireProps(at(mutated, ['components', 'schemas', SCHEMA])).tenant;
        expect(findBreakingChanges(spec, mutated)).toHaveLength(1);
    });

    it('a nested WIDENING (role: string -> string|null) stays silent — the #1190 case', () => {
        // The change that found this bug. It is additive under the module's own
        // directionality rule, and the gate must be able to SAY so rather than
        // be unable to see the field at all.
        const mutated = clone(spec);
        requireProps(at(mutated, ['components', 'schemas', SCHEMA, 'properties', PARENT]))[VICTIM] = {
            type: ['string', 'null'],
        };
        expect(findBreakingChanges(spec, mutated)).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep — every site below depth 0 in the real spec, both directions
// ─────────────────────────────────────────────────────────────────────────────
describe('SWEEP over every site the committed spec has BELOW depth 0', () => {
    /**
     * Each site the depth-0 classifier could not reach, as (schema, chain to the
     * parent node, property name): every property whose parent is not the
     * schema root — nested objects, array element schemas, free-form map
     * values, and the properties inside a composition member
     * (`AssetDetail/allOf[1].parcels`), which `schema.properties` never reached
     * either.
     *
     * DERIVED from the spec, so it grows with the API instead of going stale as
     * a hardcoded list would.
     */
    type Site = { schema: string; chain: string[]; prop: string };

    const sites: Site[] = (() => {
        const out: Site[] = [];
        const walk = (value: unknown, schema: string, chain: string[], seen: Set<Node>): void => {
            const node = asNode(value);
            if (!node || seen.has(node) || typeof node.$ref === 'string') return;
            const inner = new Set(seen).add(node);

            for (const [prop, child] of Object.entries(propsOf(node))) {
                if (chain.length > 0) out.push({ schema, chain, prop });
                walk(child, schema, [...chain, 'properties', prop], inner);
            }
            for (const key of COMPOSITION_KEYS) {
                asArray(node[key])?.forEach((member, i) => walk(member, schema, [...chain, key, String(i)], inner));
            }
            if (node.items !== undefined) walk(node.items, schema, [...chain, 'items'], inner);
            if (node.additionalProperties !== undefined) {
                walk(node.additionalProperties, schema, [...chain, 'additionalProperties'], inner);
            }
        };
        for (const [name, schema] of Object.entries(schemas)) walk(schema, name, [], new Set());
        return out;
    })();

    const label = (site: Site) => `${site.schema}.${site.chain.join('/')}.${site.prop}`;
    const nodeAt = (site: Site) => at(schemas[site.schema], site.chain);

    /** Mutate one site on a private copy of its schema, then classify. */
    function atSite(site: Site, mutate: (parent: Node, prop: string) => void) {
        const next = clone(schemas[site.schema]);
        mutate(at(next, site.chain), site.prop);
        return compareSchema(site.schema, schemas[site.schema], next);
    }

    it('the population is non-empty, and equals the newly-visible count — say the number', () => {
        const compared = collectComparedPaths(spec).length;
        let depth0 = 0;
        for (const schema of Object.values(schemas)) depth0 += Object.keys(propsOf(schema)).length;
        console.log(
            `[#1214] sweep population: ${sites.length} sites across ` +
                `${new Set(sites.map((s) => s.schema)).size} schemas; ` +
                `walked ${compared} - depth-0 ${depth0} = ${compared - depth0}`,
        );
        // An empty selection is a PASS for every specificity assertion below, so
        // the population is asserted first — and against the walk's own
        // arithmetic rather than a constant that would rot.
        expect(sites.length).toBeGreaterThan(100);
        expect(sites.length).toBe(compared - depth0);
    });

    it('SENSITIVITY: removing ANY property below depth 0 is reported — all of them', () => {
        const missed = sites.filter(
            (site) =>
                atSite(site, (parent, prop) => {
                    delete requireProps(parent)[prop];
                    const required = asArray(parent.required);
                    if (required) parent.required = required.filter((r) => r !== prop);
                }).length === 0,
        );
        expect({ missed: missed.slice(0, 10).map(label), count: missed.length }).toEqual({ missed: [], count: 0 });
    });

    it('SPECIFICITY: WIDENING any nested type stays silent — zero false positives', () => {
        const fired = sites.flatMap((site) =>
            atSite(site, (parent, prop) => {
                const target = asNode(requireProps(parent)[prop]);
                if (!target) return;
                const type = target.type;
                if (typeof type === 'string') target.type = [type, 'null'];
                else if (Array.isArray(type) && !type.includes('null')) target.type = [...type, 'null'];
            }).map(signature),
        );
        expect({ fired: fired.slice(0, 10), count: fired.length }).toEqual({ fired: [], count: 0 });
    });

    it('SPECIFICITY: adding an OPTIONAL sibling at any nested site stays silent', () => {
        const fired = sites.flatMap((site) =>
            atSite(site, (parent) => {
                requireProps(parent).zzAddedByTheSweep = { type: 'string' };
            }).map(signature),
        );
        expect({ fired: fired.slice(0, 10), count: fired.length }).toEqual({ fired: [], count: 0 });
    });

    it('SPECIFICITY: a DESCRIPTION-only change at any nested site stays silent', () => {
        const fired = sites.flatMap((site) =>
            atSite(site, (parent, prop) => {
                const target = asNode(requireProps(parent)[prop]);
                if (target) target.description = 'documented by the sweep';
            }).map(signature),
        );
        expect({ fired: fired.slice(0, 10), count: fired.length }).toEqual({ fired: [], count: 0 });
    });

    it('SPECIFICITY: WIDENING any nested enum stays silent', () => {
        const enumSites = sites.filter((site) => asArray(asNode(propsOf(nodeAt(site))[site.prop])?.enum));
        console.log(`[#1214] nested enum sites: ${enumSites.length}`);
        expect(enumSites.length).toBeGreaterThan(0);
        const fired = enumSites.flatMap((site) =>
            atSite(site, (parent, prop) => {
                const target = asNode(requireProps(parent)[prop]);
                const members = target && asArray(target.enum);
                if (target && members) target.enum = [...members, '__added_by_the_sweep__'];
            }).map(signature),
        );
        expect({ fired: fired.slice(0, 10), count: fired.length }).toEqual({ fired: [], count: 0 });
    });

    it('MUTATION PROOF of the sweep itself: a NARROWING at every typed nested site DOES fire', () => {
        // The four specificity sweeps above assert EMPTINESS, and an assertion
        // that passes over an empty selection proves nothing: a sweep whose
        // sites stopped resolving would read as four clean passes. This runs the
        // same `atSite` machinery with a mutation that MUST be reported at every
        // site carrying a concrete `type` — a derived subset, not a guess — so
        // the silence above is silence about something.
        const narrowable = sites.filter((site) => {
            const target = asNode(propsOf(nodeAt(site))[site.prop]);
            if (!target || typeof target.$ref === 'string') return false;
            return typeof target.type === 'string' || Array.isArray(target.type);
        });
        expect(narrowable.length).toBeGreaterThan(100);

        const silent = narrowable.filter(
            (site) =>
                atSite(site, (parent, prop) => {
                    // A type set disjoint from whatever was there, so every
                    // previous member is lost and `type-changed` must fire.
                    requireProps(parent)[prop] = { type: '__never__' };
                }).length === 0,
        );
        expect({ silent: silent.slice(0, 10).map(label), count: silent.length }).toEqual({ silent: [], count: 0 });
    });
});

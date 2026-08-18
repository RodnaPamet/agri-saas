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
 */

export interface BreakingChange {
    /** Machine-readable class, so the report can be grouped and counted. */
    kind:
        | 'schema-removed'
        | 'property-removed'
        | 'property-now-required'
        | 'enum-narrowed'
        | 'type-changed';
    schema: string;
    /** Property path within the schema, when the change is property-scoped. */
    property?: string;
    detail: string;
}

type Json = Record<string, unknown>;

function schemasOf(spec: Json): Record<string, Json> {
    const components = spec.components as Json | undefined;
    return ((components?.schemas as Record<string, Json>) ?? {});
}

function propsOf(schema: Json): Record<string, Json> {
    return ((schema.properties as Record<string, Json>) ?? {});
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
 *     type (string -> string|null) is a superset and is silent.
 *
 * Everything else — new schemas, new optional properties, wider enums,
 * descriptions, examples — returns nothing at all.
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

        const prevProps = propsOf(prevSchema);
        const nextProps = propsOf(nextSchema);

        for (const [prop, prevProp] of Object.entries(prevProps)) {
            const nextProp = nextProps[prop];

            if (!nextProp) {
                out.push({
                    kind: 'property-removed',
                    schema: name,
                    property: prop,
                    detail: `"${prop}" was removed; a client reading it gets undefined`,
                });
                continue;
            }

            // Type change — but WIDENING is not breaking. string -> string|null
            // is a superset, so only report when the previous set is not
            // contained in the next.
            const prevTypes = typeSet(prevProp);
            const nextTypes = typeSet(nextProp);
            if (prevTypes.size > 0 && nextTypes.size > 0) {
                const lost = [...prevTypes].filter((t) => !nextTypes.has(t));
                if (lost.length > 0) {
                    out.push({
                        kind: 'type-changed',
                        schema: name,
                        property: prop,
                        detail: `"${prop}" no longer accepts ${lost.join('|')} (was ${[...prevTypes].join('|')}, now ${[...nextTypes].join('|')})`,
                    });
                }
            }

            // Enum narrowing. Gaining members is additive and silent.
            const prevEnum = enumOf(prevProp);
            const nextEnum = enumOf(nextProp);
            if (prevEnum && nextEnum) {
                const lost = [...prevEnum].filter((v) => !nextEnum.has(v));
                if (lost.length > 0) {
                    out.push({
                        kind: 'enum-narrowed',
                        schema: name,
                        property: prop,
                        detail: `"${prop}" no longer accepts ${lost.join(', ')}; a client still sending it is rejected`,
                    });
                }
            }
        }

        // A property becoming required breaks any client that omits it.
        const prevRequired = new Set(requiredOf(prevSchema));
        for (const req of requiredOf(nextSchema)) {
            if (!prevRequired.has(req)) {
                out.push({
                    kind: 'property-now-required',
                    schema: name,
                    property: req,
                    detail: `"${req}" is now required; a client that omits it is rejected`,
                });
            }
        }
    }

    return out;
}

/** Human-readable report for a CI failure message. */
export function formatBreakingChanges(changes: BreakingChange[]): string {
    return changes
        .map((c) => `  [${c.kind}] ${c.schema}${c.property ? `.${c.property}` : ''} — ${c.detail}`)
        .join('\n');
}

/**
 * Contract: a timestamp a client READS says how it is encoded (#1391).
 *
 * Raised by agrent-ios, which decodes `lastMessageAt`, `createdAt`, `readAt`,
 * `closedAt`, `occurredAt`, `completedAt` and `generatedAt` as ISO 8601 and had
 * to infer that from the values rather than read it from the contract. Measured
 * at the time: **30** properties across 24 schemas typed `string` with no
 * `format`, against 82 that already had one. The convention existed; it was
 * applied to the majority and silently skipped on the rest, which is the worst
 * of the three possible states — a client cannot tell whether an undeclared
 * field is a different encoding or an oversight.
 *
 * ## Why `format` and not prose
 *
 * A description saying "ISO 8601" is read by a human. `format: date-time` is
 * read by a generator, which is the whole point: the client that found this was
 * hand-writing models from the spec, and the next one will not be.
 *
 * Adding it is free. `format` is none of the six classes
 * `scripts/openapi-breaking.ts` scores, so the breaking-change gate stayed
 * green across all 34 additions — verified, not assumed. And every schema
 * touched is consumed only by `src/lib/openapi/paths/*.ts` for registration,
 * never `.parse()`d at runtime, so `.datetime()` adds documentation and no
 * validation.
 *
 * ## The rule is "declares A format", not "declares date-time"
 *
 * Three `…At` properties are deliberately `format: date` — `CalculatorRow.
 * priceObservedAt`, `MarketReference.observedAt`, `TrendSeries.lastObservedAt`
 * are day-resolution observations, not instants. A guard demanding `date-time`
 * everywhere would have reported those three as defects on its first run, which
 * is how a guard earns the contempt that gets it deleted. What a client cannot
 * work with is the ABSENCE of a format; a `date` that says `date` is fine.
 *
 * ## REQUEST schemas are out of scope, and that is a decision
 *
 * Seven `…At` properties live in request bodies — `TaskCreateRequest.dueAt`,
 * `LogEntryCreateRequest.occurredAt` and friends. Declaring those means adding
 * `.datetime()` to a schema the server actually RUNS, which would start
 * refusing input it accepts today. That is a behaviour change with a blast
 * radius on live clients, so it is filed rather than smuggled in beside a
 * documentation sweep. Excluding them here is deliberate and the exclusion is
 * derived — a schema referenced by any `requestBody` — rather than listed, so
 * a new request schema is out of scope automatically and cannot be forgotten
 * INTO scope.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPEC = join(process.cwd(), 'src/generated/openapi.json');

/**
 * Documented in error and never sent.
 *
 * `src/lib/dto/task.dto.ts` says so in terms: "NEVER SENT. There is no
 * `resolvedAt` column on `Task`." The only `resolvedAt` columns in this repo
 * belong to the old `Issue` model in migration SQL. Giving it a format would
 * dress up a field that never arrives, and the honest fix — removing the
 * property — is a `property-removed`, which the breaking-change gate scores
 * and which therefore needs the deprecate-then-delete route #1386 established.
 *
 * Listed rather than silently skipped so that the day it is removed, this entry
 * fails and the exception goes with it.
 */
const DOCUMENTED_IN_ERROR = new Set(['Task.resolvedAt', 'TaskDetail.resolvedAt']);

interface Spec {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
}

/** Component schemas referenced by any operation's `requestBody`. */
function requestSchemas(spec: Spec): Set<string> {
    const names = Object.keys(spec.components.schemas);
    const found = new Set<string>();
    for (const item of Object.values(spec.paths)) {
        for (const op of Object.values(item)) {
            if (typeof op !== 'object' || op === null) continue;
            const body = JSON.stringify((op as { requestBody?: unknown }).requestBody ?? null);
            for (const n of names) {
                if (body.includes(`"#/components/schemas/${n}"`)) found.add(n);
            }
        }
    }
    return found;
}

interface Found {
    /** `Schema.path/to/prop` — the dotted path a reader can grep for. */
    where: string;
    root: string;
    format: string | null;
}

/** Every property whose name ends in `At`, at any depth, with its format. */
function timestampProps(spec: Spec): Found[] {
    const out: Found[] = [];
    const walk = (node: unknown, trail: string[], root: string): void => {
        if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, [...trail, String(i)], root));
            return;
        }
        if (typeof node !== 'object' || node === null) return;
        const rec = node as Record<string, unknown>;
        const props = rec.properties;
        if (props && typeof props === 'object') {
            for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
                if (!name.endsWith('At')) continue;
                if (typeof value !== 'object' || value === null) continue;
                const f = (value as { format?: unknown }).format;
                out.push({
                    where: [...trail, name].join('/'),
                    root,
                    format: typeof f === 'string' ? f : null,
                });
            }
        }
        for (const [k, v] of Object.entries(rec)) walk(v, [...trail, k], root);
    };
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
        walk(schema, [], name);
    }
    return out;
}

describe('a timestamp a client reads declares its format (#1391)', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as Spec;
    const req = requestSchemas(spec);
    const all = timestampProps(spec);
    const responseSide = all.filter((p) => !req.has(p.root) && !p.root.endsWith('Request'));

    it('ranges over a real population — the denominator', () => {
        // An empty or tiny selection satisfies the rule below, and a renamed
        // `components.schemas` or a changed property-walk is exactly how that
        // happens. 134 `…At` properties at the time of writing.
        expect(all.length).toBeGreaterThan(100);
        expect(responseSide.length).toBeGreaterThan(80);
        expect(req.size).toBeGreaterThan(20);
    });

    it('every response-side timestamp declares a format', () => {
        const missing = responseSide
            .filter((p) => p.format === null)
            .filter((p) => !DOCUMENTED_IN_ERROR.has(`${p.root}.${p.where}`));

        if (missing.length) {
            throw new Error(
                `${missing.length} of ${responseSide.length} response-side timestamps are ` +
                    `typed without a \`format\`:\n\n` +
                    missing.map((p) => `    ${p.root}.${p.where}`).join('\n') +
                    `\n\nA client decoding one has to guess the encoding, and a generated ` +
                    `client gets a bare \`string\` where it could have had a date (#1391).\n\n` +
                    `Add \`.datetime()\` to the Zod declaration and run ` +
                    `\`npm run openapi:generate\`. It is free: \`format\` is none of the six ` +
                    `classes scripts/openapi-breaking.ts scores, and these schemas are ` +
                    `registration-only — they are never \`.parse()\`d, so nothing starts ` +
                    `validating.\n\n` +
                    `If the field is genuinely day-resolution, \`format: date\` satisfies this ` +
                    `rule — what a client cannot work with is the absence.`,
            );
        }
    });

    it('the day-resolution exceptions are intact, not accidentally promoted', () => {
        // The other direction, and the reason this guard asks for "a format"
        // rather than "date-time": a sweep that promoted these to `date-time`
        // would be WRONG and would also pass the assertion above. So pin them.
        const dateOnly = all.filter((p) => p.format === 'date').map((p) => `${p.root}.${p.where}`);
        expect(dateOnly.sort()).toEqual([
            'CalculatorRow.priceObservedAt',
            'MarketReference.observedAt',
            'TrendSeries.lastObservedAt',
        ]);
    });

    it('the never-sent exceptions are still never sent', () => {
        // The exception list may only shrink. If `resolvedAt` ever gains a
        // format, somebody has either started sending it or dressed up a
        // phantom — both worth a conversation, and both make this fail.
        for (const entry of DOCUMENTED_IN_ERROR) {
            const [root, ...rest] = entry.split('.');
            const prop = all.find((p) => p.root === root && p.where === rest.join('.'));
            expect(prop).toBeDefined();
            expect(prop?.format).toBeNull();
        }
    });
});

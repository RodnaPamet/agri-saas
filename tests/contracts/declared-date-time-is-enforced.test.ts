/**
 * Contract: a request field that PUBLISHES `format: date-time` must REFUSE
 * the shapes that format excludes (#1443, #1539).
 *
 * ## The failure this prevents, which has now happened in both directions
 *
 * `format: date-time` is RFC 3339. A spec that declares it while the server
 * accepts `2026-10-08` is not documentation, it is a false promise — a client
 * that reads the spec and sends a conforming value is fine, but a client that
 * reads the spec and *validates against it* rejects payloads the server would
 * have taken, and a client sending the looser shape succeeds against this
 * server and fails against any conforming one.
 *
 * That was #1539: the ingest route's `recordedAt` was filed as a declared
 * format the server did not enforce. The filing turned out to be wrong about
 * which line declared what — the `date-time` I found belonged to the GET
 * *response* schema, and the request declared no format at all — but the class
 * is real, and the inverse was real on the same endpoint: the server accepted
 * any 4-40 character string, so garbage was a 500 instead of a 400.
 *
 * ## Why BOTH halves are asserted per field
 *
 * The two assertions below fail for opposite mistakes, and either alone is
 * satisfiable by the defect the other catches:
 *
 *   - **spec declares it** — fails if someone drops `instantTimestamp()` back
 *     to a bare `z.string()`, since the format disappears from the generated
 *     spec.
 *   - **the schema refuses a bare day** — fails if someone keeps the rendered
 *     format but swaps the check for a looser one. A refinement that only
 *     tests parseability (`requestTimestamp()`) renders NO format, so that
 *     substitution is caught here rather than shipping as #1539's defect.
 *
 * Asserting only the spec would pass with no enforcement; asserting only the
 * schema would pass with nothing published. The pair is the contract.
 *
 * ## The one field deliberately absent from this list
 *
 * `BulkTaskDueDateSchema.dueAt` uses the same validator and is exercised in
 * `tests/unit/bulk-schemas.test.ts`, but it is NOT registered in the spec
 * (`grep -c BulkTaskDueDate src/generated/openapi.json` → 0) because it
 * carries no `.openapi()` call. So it has no published format to compare, and
 * including it here would assert against a schema that does not exist. That is
 * also how this issue's original field list came to have seven entries while
 * the spec showed six: a list derived from the spec cannot see it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    CreateTaskSchema,
    UpdateTaskSchema,
    CreateFieldOperationSchema,
    CreateLogEntrySchema,
    UpdateLogEntrySchema,
} from '@/lib/schemas';

interface Node {
    type?: string | string[];
    format?: string;
    properties?: Record<string, Node>;
}

const spec = JSON.parse(
    readFileSync(join(process.cwd(), 'src/generated/openapi.json'), 'utf8'),
) as { components: { schemas: Record<string, Node> } };

/** A value the declared format EXCLUDES but a bare `z.string()` accepts. */
const BARE_DAY = '2026-10-08';
/** A conforming value, so a schema that refuses everything cannot pass. */
const INSTANT = '2026-10-08T14:00:00Z';

type Case = {
    label: string;
    /** Registered spec schema, and the path to the property inside it. */
    registered: string;
    path: string[];
    /** The executing schema, and a payload that is otherwise valid. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: { safeParse: (v: unknown) => { success: boolean } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    valid: Record<string, any>;
    field: string;
};

const CASES: Case[] = [
    {
        label: 'TaskCreateRequest.dueAt',
        registered: 'TaskCreateRequest',
        path: ['dueAt'],
        schema: CreateTaskSchema,
        valid: { title: 'A task' },
        field: 'dueAt',
    },
    {
        label: 'TaskUpdateRequest.dueAt',
        registered: 'TaskUpdateRequest',
        path: ['dueAt'],
        schema: UpdateTaskSchema,
        valid: {},
        field: 'dueAt',
    },
    {
        label: 'FieldOperationCreateRequest.dueAt',
        registered: 'FieldOperationCreateRequest',
        path: ['dueAt'],
        schema: CreateFieldOperationSchema,
        // The superRefine enforces an XOR plus the chosen kind's dose+unit,
        // so a product needs doseValue and doseUnitId to be a valid payload.
        valid: {
            operationType: 'SPRAY',
            parcelIds: ['p1'],
            assigneeUserId: 'u1',
            productName: 'Product X',
            doseValue: 1,
            doseUnitId: 'unit-1',
        },
        field: 'dueAt',
    },
    {
        label: 'LogEntryCreateRequest.occurredAt',
        registered: 'LogEntryCreateRequest',
        path: ['occurredAt'],
        schema: CreateLogEntrySchema,
        valid: { type: 'ACTIVITY', title: 'An entry' },
        field: 'occurredAt',
    },
    {
        label: 'LogEntryUpdateRequest.occurredAt',
        registered: 'LogEntryUpdateRequest',
        path: ['occurredAt'],
        schema: UpdateLogEntrySchema,
        valid: {},
        field: 'occurredAt',
    },
];

function at(root: Node, path: string[]): Node | undefined {
    let n: Node | undefined = root;
    for (const key of path) {
        n = n?.properties?.[key];
        if (!n) return undefined;
    }
    return n;
}

describe('a declared format: date-time is actually enforced (#1443, #1539)', () => {
    it('the registered schemas all exist — the denominator', () => {
        // Without this, a renamed registration makes every `format` assertion
        // below vacuous, and a rename is exactly how a published contract goes
        // missing without anybody noticing.
        for (const c of CASES) {
            expect(Object.keys(spec.components.schemas)).toContain(c.registered);
        }
        expect(CASES.length).toBeGreaterThanOrEqual(5);
    });

    describe.each(CASES.map((c) => [c.label, c] as const))('%s', (_label, c) => {
        it('publishes format: date-time', () => {
            const node = at(spec.components.schemas[c.registered], c.path);
            expect(node).toBeDefined();
            expect(node!.format).toBe('date-time');
        });

        it('and REFUSES a bare day, so the published format is kept', () => {
            // The half that `requestTimestamp()` would fail. A parseability
            // refinement renders no format at all, so a swap is caught by the
            // assertion above — and a `.datetime()` dropped for a bare
            // `z.string()` is caught by this one.
            expect(c.schema.safeParse({ ...c.valid, [c.field]: BARE_DAY }).success).toBe(false);
        });

        it('while ACCEPTING a conforming instant — so it is not refusing everything', () => {
            // The positive control. Without it, a schema broken in some
            // unrelated way (a required field renamed, say) would satisfy the
            // rejection above for the wrong reason and read as enforcement.
            expect(c.schema.safeParse({ ...c.valid, [c.field]: INSTANT }).success).toBe(true);
        });
    });
});

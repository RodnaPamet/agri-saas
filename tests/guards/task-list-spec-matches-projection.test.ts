/**
 * The published `FarmTaskListItem` must not declare a field the server does not
 * send.
 *
 * ## The defect this exists for, found by reading the schema
 *
 * `FarmTaskListItem` is `.passthrough()`. That is correct — the projection
 * carries `priority`, which clients may ignore — but it means the schema and
 * the projection can disagree in either direction with nothing failing:
 *
 *   · **spec declares, server omits.** A client decodes an optional field that
 *     is always absent, and concludes the data is missing rather than that the
 *     contract is wrong. For a non-optional field it is a decode error on the
 *     device, found by whoever owns the client.
 *   · **server sends, spec omits.** Harmless to a decoder, and invisible —
 *     `priority` was in this state, AND the schema's own description named it
 *     among the fields the projection "carries no ... of". The server had been
 *     ordering the list by a field the spec said it did not return.
 *
 * The first direction is the one that breaks a client, so it is the one
 * asserted. The second is reported as information: `.passthrough()` makes it
 * legal, and the fix for `priority` was to stop claiming otherwise rather than
 * to declare it.
 *
 * ## Why it reads the GENERATED spec
 *
 * `src/generated/openapi.json` is what clients are handed. Reading the zod
 * object instead would pass while the committed spec was stale — the two are
 * kept in step by a separate contract test, and a guard that assumes that is a
 * guard that inherits its failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import { taskListSelect } from '@/app-layer/repositories/WorkItemRepository';

const SPEC = path.resolve(__dirname, '../../src/generated/openapi.json');

function declaredProperties(): string[] {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
    const schema = spec?.components?.schemas?.FarmTaskListItem;
    if (!schema?.properties) {
        throw new Error('FarmTaskListItem has no properties in the generated spec');
    }
    return Object.keys(schema.properties).sort();
}

/** Top-level keys the projection asks Prisma for, relations included. */
function projectedFields(): string[] {
    return Object.keys(taskListSelect).sort();
}

describe('FarmTaskListItem declares nothing the task-list projection omits', () => {
    it('every declared property is projected', () => {
        const projected = new Set(projectedFields());
        const undelivered = declaredProperties().filter((p) => !projected.has(p));

        // Names the field rather than comparing counts: "expected 12 to be 13"
        // sends a reader to the wrong half of the problem.
        expect(undelivered).toEqual([]);
    });

    it('control: both sides are non-empty and really were read', () => {
        // Without this, an empty spec object or a renamed export would make the
        // assertion above pass by having nothing to compare. The projection is
        // the one that would fail silently — a bad import gives `{}`, and every
        // declared property would then be "undelivered", so that direction is
        // loud. An empty SPEC is the quiet one.
        expect(declaredProperties().length).toBeGreaterThan(8);
        expect(projectedFields().length).toBeGreaterThan(8);
        expect(declaredProperties()).toContain('id');
        expect(projectedFields()).toContain('id');
    });

    it('completedAt is both declared and projected', () => {
        // The field this guard was written alongside. agrent-ios ships a client
        // that decodes it on list rows, so a spec declaring it while the
        // projection omitted it would have shipped as a permanently-null field
        // and read as "the server never completes tasks".
        expect(declaredProperties()).toContain('completedAt');
        expect(projectedFields()).toContain('completedAt');
    });

    it('reports fields sent but not declared — legal, and worth seeing', () => {
        // `.passthrough()` permits these. `priority` is the standing example and
        // is deliberate: the list is ordered and filtered by it, so it is
        // projected, and the schema's description now says so instead of naming
        // it as an omission. This asserts the SET, so a NEW undeclared field
        // arrives as a failure that asks the author to decide, rather than
        // joining the set unnoticed.
        const declared = new Set(declaredProperties());
        const undeclared = projectedFields().filter((f) => !declared.has(f));

        expect(undeclared).toEqual(['priority']);
    });
});

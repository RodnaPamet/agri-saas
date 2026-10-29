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

/**
 * Field names `withMayDelete` removes before the response, read from the source
 * rather than listed again here (#2395).
 *
 * Derived, because a second hardcoded list is how this guard would come to
 * disagree with the code it checks. `taskListSelect` projects two fields ONLY to
 * compute `mayDelete` from them, so "projected" stopped meaning "sent" and this
 * guard's model had to learn the difference. Adding them to the undeclared
 * allowlist below would have been easier and would have asserted something
 * false: that the server sends an author id it strips.
 */
function strippedBeforeResponse(): string[] {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/app-layer/usecases/task.ts'), 'utf8');
    const m = src.match(/const \{([^}]*)\.\.\.rest\s*\} = row;/);
    // Loud rather than silently empty: if the destructure is reshaped, this
    // guard must fail rather than quietly stop subtracting anything.
    expect(m).not.toBeNull();
    return (m![1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).sort();
}

/**
 * Field names `withMayDelete` ADDS, read from the source for the same reason
 * `strippedBeforeResponse` is (#2395).
 *
 * The mirror of the strip, and the other half of what this guard's model had to
 * learn: a COMPUTED field is declared and legitimately not projected, so
 * "declared ⇒ projected" stopped holding at the same moment "projected ⇒ sent"
 * did. Both directions are derived, so the guard follows the decorator rather
 * than a copy of it.
 */
function computedNotProjected(): string[] {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/app-layer/usecases/task.ts'),
        'utf8',
    );
    const body = src.match(/\.\.\.rest,([\s\S]*?)\n        \};/);
    expect(body).not.toBeNull();
    // Top-level `key:` names in the returned object, beyond the spread.
    const keys = (body![1].match(/^\s{12}([A-Za-z_][A-Za-z0-9_]*):/gm) ?? []).map((k) =>
        k.trim().replace(':', ''),
    );
    expect(keys.length).toBeGreaterThan(0);
    return keys.sort();
}

/**
 * Field names `attachParcelIds` ADDS — the SECOND decorator (#2474).
 *
 * There are now two, and the guard has to follow both for the reason it
 * follows the first: a list of names copied here would go stale the moment a
 * decorator changed, and the failure would be a green guard over a promise the
 * server no longer keeps.
 *
 * Derived separately rather than by widening `computedNotProjected`'s regex
 * because the two decorators have genuinely different shapes —
 * `withMayDelete` destructures and returns a multi-line object after
 * `...rest,`, while this one is a single-line `({ ...r, key: … })` inside a
 * `.map`. One regex loose enough for both would be loose enough to match
 * almost anything.
 *
 * Loud rather than silently empty, like its sibling: if the decorator is
 * reshaped this must fail rather than quietly stop contributing a field.
 */
function computedByParcelDecorator(): string[] {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/app-layer/usecases/task.ts'),
        'utf8',
    );
    const m = src.match(/rows\.map\(\(r\) => \(\{\s*\.\.\.r,\s*([A-Za-z_][A-Za-z0-9_]*):/);
    expect(m).not.toBeNull();
    return [m![1]];
}

/**
 * Top-level keys the response carries: what Prisma is asked for, minus what is
 * stripped on the way out, plus what EITHER decorator computes there.
 */
function projectedFields(): string[] {
    const stripped = new Set(strippedBeforeResponse());
    return [
        ...Object.keys(taskListSelect).filter((f) => !stripped.has(f)),
        ...computedNotProjected(),
        ...computedByParcelDecorator(),
    ].sort();
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

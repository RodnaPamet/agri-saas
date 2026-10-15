/**
 * `ExchangeListing.publishAsFarm` exists and NOTHING writes it — P6.7 (#1816).
 *
 * ## Why a test for an absence
 *
 * The column ships one release ahead of its writer, so that
 * `prisma migrate deploy` has applied it in production before any code depends
 * on it. That is the split `FarmBrand.indexable` used (#1850 added the column,
 * #1873 added the writer), and the reason is the deploy shape described in
 * CLAUDE.md: migrations run from the container at start-up, and a writer
 * shipped in the same image as its migration is live against a schema whose
 * change has not been confirmed.
 *
 * A comment saying "nothing writes this yet" decays the moment somebody adds a
 * writer without reading it. This test is the same claim in a form that fails.
 *
 * ## It is meant to be DELETED
 *
 * The PR that adds the writer deletes this file. That is not a workaround —
 * it is the forcing function: the only way to add a writer is to come here,
 * read why the split exists, and confirm a release now contains the migration:
 *
 *     git tag --contains $(git log -1 --format=%H -- \
 *       prisma/migrations/20261015180000_p6_7_exchange_listing_publish_as_farm)
 *
 * Squash subjects do not carry migration names, so the tag has to be checked
 * against the migration's ADD-commit rather than searched for by name.
 *
 * ## The two halves, and why neither alone is enough
 *
 * A bare "no file mentions it" assertion passes for free if the scan breaks or
 * the column never landed — an empty window satisfies a negated assertion. So
 * the schema half asserts the subject EXISTS, and the scan half runs over a
 * population with a floor.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';
import { parseSchemaModels } from '../helpers/prisma-schema-models';

const FIELD = 'publishAsFarm';
const MODEL = 'ExchangeListing';

describe('ExchangeListing.publishAsFarm ships ahead of its writer', () => {
    it('is declared on the model, as a non-optional boolean defaulting to false', () => {
        const model = parseSchemaModels().find((m) => m.name === MODEL);
        expect(model).toBeDefined();

        const field = model!.fields.find((f) => f.name === FIELD);
        expect(field).toBeDefined();
        expect(field!.type).toBe('Boolean');
        // NOT optional: a three-valued answer would make "no decision" and
        // "chose to stay anonymous" indistinguishable, and the projection has
        // to tell them apart to know whether to fall back to the typed name.
        expect(field!.isOptional).toBe(false);
        expect(field!.isList).toBe(false);
    });

    it('is not written, read, or selected anywhere in src/', () => {
        const files = collectSourceFiles({
            roots: ['src'],
            exclude: (rel) => /\.(test|spec)\.tsx?$/.test(rel),
            // A floor well under the real ~1700, so an exclude predicate or a
            // renamed root cannot turn this into a vacuous pass.
            floor: 500,
        }).map((abs) => path.relative(REPO_ROOT, abs));

        // Comments are blanked: the docblock on the schema field explains the
        // split, and a future comment in `src/` referencing the column is
        // prose, not a writer. Counting prose is how a sibling guard in this
        // repo inflated its own population twice.
        const mentions = files.filter((rel) =>
            new RegExp(`\\b${FIELD}\\b`).test(
                blankNonCode(readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
            ),
        );

        expect(files.length).toBeGreaterThanOrEqual(500);
        expect(mentions).toEqual([]);
    });

    it('the migration that adds it is additive, and carries its own rollback', () => {
        const dir = path.join(
            REPO_ROOT,
            'prisma/migrations/20261015180000_p6_7_exchange_listing_publish_as_farm',
        );
        const up = readFileSync(path.join(dir, 'migration.sql'), 'utf8');
        const down = readFileSync(path.join(dir, 'migration.down.sql'), 'utf8');

        // Additive only. `destructive-migration-has-inverse` derives the
        // destructive set by scanning for DROP/RENAME, and this must not be in
        // it: a plain ADD COLUMN cannot break the previous image, which is what
        // makes shipping it alone safe.
        expect(up).toContain(`ADD COLUMN "${FIELD}" BOOLEAN NOT NULL DEFAULT false`);
        expect(up).not.toMatch(/\bDROP\b|\bRENAME\b/i);

        // The rollback is for the one release in which it is still harmless.
        expect(down).toContain(`DROP COLUMN "${FIELD}"`);
    });
});

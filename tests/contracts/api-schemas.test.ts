/**
 * GAP-10 step 5 — API contract regression gate.
 *
 * Two complementary checks:
 *
 *   1. **Per-schema snapshot**. For every named OpenAPI component
 *      registered by the schema layer, snapshot its JSON-Schema
 *      fragment via Jest's `toMatchSnapshot()`. The snapshot file
 *      (`__snapshots__/api-schemas.test.ts.snap`) is committed,
 *      reviewable in PRs, and gives reviewers a per-schema diff
 *      when the contract changes. Adding/removing a property from
 *      a schema, changing an enum, tightening a min/max, etc. —
 *      all surface as a single named snapshot diff.
 *
 *   2. **Full-spec drift check**. Re-build the spec in-process via
 *      `buildOpenApiDoc()` and compare the serialised output
 *      byte-for-byte against the committed `public/openapi.json`.
 *      Catches the case where someone changed an annotation but
 *      forgot to run `npm run openapi:generate` — the committed
 *      file would lag the schema layer.
 *
 * What this catches in CI:
 *   - Removing a `.openapi(name, ...)` annotation (component
 *     vanishes from the snapshot list).
 *   - Renaming a component ID (snapshot keyed on the old name
 *     disappears, new entry has no committed snapshot).
 *   - Changing field types (e.g. string → number) — per-schema
 *     snapshot diff.
 *   - Adding/removing required fields — per-schema snapshot diff.
 *   - Tightening or loosening a constraint (min/max, enum
 *     values) — per-schema snapshot diff.
 *   - Forgetting to regenerate `public/openapi.json` after a
 *     schema change — full-spec drift check.
 *
 * On legitimate contract changes:
 *   1. Run `npm run openapi:generate` to update `public/openapi.json`.
 *   2. Run `npx jest tests/contracts/ -u` to update the per-schema
 *      snapshots.
 *   3. Commit both. The reviewer sees the diff against the
 *      previous contract and approves explicitly.
 *
 * Each step deliberately requires opt-in human action — there's no
 * "auto-update" path. A breaking API change can't slip through
 * without somebody making the call to update the snapshot.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildOpenApiDoc, serializeDoc } from '../../scripts/openapi-build';

interface OpenApiDoc {
    openapi: string;
    components?: { schemas?: Record<string, unknown> };
}

const COMMITTED_SPEC_PATH = path.resolve(__dirname, '../../public/openapi.json');

// ─── Build once, reuse across every test in this file ───────────────
//
// `buildOpenApiDoc()` is idempotent within a single process (the
// shared registry deduplicates re-registration), but iterating it
// once and stashing the result is cheaper and gives every test a
// stable handle.

const doc: OpenApiDoc = buildOpenApiDoc({ verbose: false }) as OpenApiDoc;
const schemas = doc.components?.schemas ?? {};
const schemaNames = Object.keys(schemas).sort();

describe('API contract — full-spec drift check', () => {
    it('public/openapi.json matches the in-process build (no drift)', () => {
        const generated = serializeDoc(doc as never);

        // UPDATE_OPENAPI=1 flips this test from compare-mode to
        // write-mode. The CLI at `scripts/generate-openapi.ts`
        // invokes this test with the env set; in normal CI it's
        // unset and the test does its drift-detection job. Running
        // the generator INSIDE the test avoids cross-runtime drift
        // (tsx ESM vs Jest CJS produce subtly different output for
        // some Zod constructs — notably `.nullable().optional()`).
        if (process.env.UPDATE_OPENAPI === '1') {
            fs.writeFileSync(COMMITTED_SPEC_PATH, generated, 'utf-8');
            return;
        }

        const committed = fs.readFileSync(COMMITTED_SPEC_PATH, 'utf-8');

        // Normalise the `info.version` field on both sides before
        // comparing. semantic-release bumps package.json::version
        // on every merge to main, which makes the generated spec's
        // version-string differ from the committed one until the
        // next openapi:generate run. That drift is mechanical, not
        // a real contract change — the contract is the schema
        // shape, not the package version. Stripping it here keeps
        // the test focused on what actually matters.
        const stripVersion = (jsonText: string): string =>
            jsonText.replace(
                /("version"\s*:\s*)"[^"]+"/,
                '$1"<package-json>"',
            );
        const generatedNoVersion = stripVersion(generated);
        const committedNoVersion = stripVersion(committed);

        if (generatedNoVersion !== committedNoVersion) {
            // Surface a useful failure message — Jest's default
            // toBe() diff on a 4400-line string is unreadable.
            // The hint at the bottom is the action item.
            const generatedLines = generated.split('\n').length;
            const committedLines = committed.split('\n').length;
            const message = [
                '',
                'public/openapi.json is out of sync with the schema layer.',
                '',
                `  committed file: ${committedLines} lines`,
                `  generated now:  ${generatedLines} lines`,
                '',
                'This usually means a Zod schema changed but `npm run openapi:generate`',
                'was not re-run. To fix:',
                '',
                '  npm run openapi:generate                 # rewrites public/openapi.json',
                '  npx jest tests/contracts/ -u             # updates the per-schema snapshots',
                '  git add public/openapi.json tests/contracts/__snapshots__/',
                '',
                'Then re-run the test suite to confirm both diffs are intentional.',
                '',
            ].join('\n');
            throw new Error(message);
        }
        expect(generatedNoVersion).toBe(committedNoVersion);
    });
});

describe('API contract — per-schema snapshots', () => {
    it('the schema-name set is non-empty (sanity)', () => {
        // Was > 60. The GRC teardown removed 26 orphan zod schemas whose
        // models are gone, so the spec legitimately publishes fewer.
        expect(schemaNames.length).toBeGreaterThan(30);
    });

    // Generate one test per registered component, keyed on the
    // component name. The snapshot identifier becomes the test
    // name, so snapshot files have human-readable section names
    // and a removed component shows up as a removed test (Jest
    // reports the obsolete snapshot).
    for (const name of schemaNames) {
        it(`schema: ${name}`, () => {
            // Stringify with a fixed indent so snapshot diffs are
            // line-oriented. JSON-stringifying a Zod-derived JSON
            // Schema is deterministic given a stable input ordering.
            const fragment = JSON.stringify(schemas[name], null, 2);
            expect(fragment).toMatchSnapshot();
        });
    }
});

/**
 * The breaking-change guard, and the mutation proof that it is calibrated.
 *
 * Two failure modes, and this file exists to rule out BOTH:
 *
 *   1. Too loose — a removed field ships and breaks every installed app. An
 *      App Store binary cannot be rolled back the way a Watchtower-updated
 *      image can, so the only fast remedy is a server revert.
 *   2. Too strict — every new optional field trips the guard, people route
 *      around it, and it protects nothing. Not hypothetical here: the OI-3
 *      auth guard hard-pinned an action version and reddened on routine
 *      Dependabot bumps until #599 relaxed it. A contract guard that cries
 *      wolf earns the same contempt.
 *
 * So the additive cases below are as load-bearing as the breaking ones.
 *
 * A THIRD failure mode was found later and lives in its own file. This one
 * calibrates the CLASSES; it said nothing about the classifier's field of view,
 * and the field of view turned out to be one level deep — 293 of 1575 described
 * property sites outside the gate, reading as green (#1214). See
 * `openapi-breaking-depth.test.ts`. Keep both: classes and depth are
 * independent axes, and neither assertion subsumes the other.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildOpenApiDoc, serializeDoc } from '../../scripts/openapi-build';
import { findBreakingChanges } from '../../scripts/openapi-breaking';
import {
    baseSha,
    blobPresentAt,
    commitPresent,
    readFileAtSha,
    requireBase,
} from '../helpers/ratchet-base';

const COMMITTED = path.resolve(__dirname, '../../src/generated/openapi.json');

function schemaSpec(schemas: Record<string, unknown>) {
    return { components: { schemas } };
}

describe('breaking-change classifier — the BREAKING cases', () => {
    it('flags a REMOVED schema', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({});
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('schema-removed');
    });

    it('flags a REMOVED property — the canonical case from the DONE WHEN', () => {
        const before = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
        });
        const after = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('property-removed');
        expect(found[0].property).toBe('b');
    });

    it('flags a property BECOMING REQUIRED', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('property-now-required');
    });

    it('flags a NARROWED enum', () => {
        const before = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A', 'B', 'C'] } } },
        });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A', 'B'] } } },
        });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('enum-narrowed');
    });

    it('flags a CHANGED type', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { n: { type: 'string' } } } });
        const after = schemaSpec({ Thing: { type: 'object', properties: { n: { type: 'number' } } } });
        const found = findBreakingChanges(before, after);
        expect(found).toHaveLength(1);
        expect(found[0].kind).toBe('type-changed');
    });
});

describe('breaking-change classifier — the ADDITIVE cases must stay SILENT', () => {
    // These matter as much as the ones above. A guard that fires here is a
    // guard people disable.
    it('a NEW schema is not breaking', () => {
        const before = schemaSpec({ A: { type: 'object', properties: {} } });
        const after = schemaSpec({ A: { type: 'object', properties: {} }, B: { type: 'object', properties: {} } });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a NEW OPTIONAL property is not breaking — the DONE WHEN case', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a WIDENED enum is not breaking', () => {
        const before = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A'] } } },
        });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { s: { type: 'string', enum: ['A', 'B'] } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a WIDENED type (string -> string|null) is not breaking', () => {
        // A superset still decodes everything the old client could send.
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: ['string', 'null'] } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a description-only change is not breaking', () => {
        const before = schemaSpec({ Thing: { type: 'object', properties: { a: { type: 'string' } } } });
        const after = schemaSpec({
            Thing: { type: 'object', properties: { a: { type: 'string', description: 'now documented' } } },
        });
        expect(findBreakingChanges(before, after)).toEqual([]);
    });

    it('a property that was ALREADY required staying required is not breaking', () => {
        const s = { Thing: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } };
        expect(findBreakingChanges(schemaSpec(s), schemaSpec(s))).toEqual([]);
    });
});

describe('the guard, against the real committed spec', () => {
    // The committed spec lives in the SAME test runtime as the generator
    // (scripts/generate-openapi.ts delegates to Jest precisely so the writer
    // and verifier share one module-loading path) — so a comparison here
    // cannot drift for reasons unrelated to the API.
    const committed = JSON.parse(fs.readFileSync(COMMITTED, 'utf-8'));
    const generated = JSON.parse(serializeDoc(buildOpenApiDoc({ verbose: false })));

    // ── This pair is a DRIFT check, not the breaking-change gate (#1228) ──
    //
    // `committed` is read from the WORKING TREE, and `generated` is built from
    // that same tree's source. A PR that breaks the contract and regenerates
    // the spec — which is step 1 of the documented procedure in ci.yml, and
    // enforced for schema dirs by `scripts/check-openapi-sync.sh` — makes the
    // two sides equal. The comparison then holds a tree against ITSELF and
    // reports `[]` no matter what the API did.
    //
    // So this `it` keeps its value but not its old NAME: it proves the
    // committed artifact matches what the generator emits, which is a real
    // thing to know and is why a stale commit of the spec is caught. It is
    // not, and never was, evidence that no breaking change shipped. The gate
    // that is lives in the next describe, against the PR's BASE.
    it('the committed spec matches what the generator emits (drift, not breakage)', () => {
        const found = findBreakingChanges(committed, generated);
        expect({ breaking: found }).toEqual({ breaking: [] });
    });

    it('MUTATION PROOF: deleting a real DEPTH-0 field from the real spec IS caught', () => {
        // Proves the gate above is not vacuously passing because the two specs
        // happen to be identical. Removes an actual property from an actual
        // schema and asserts the classifier notices.
        //
        // This used to pick its victim with `Object.keys(props)[0]` — a
        // TOP-LEVEL key by construction — and that is precisely why it passed
        // for months while every NESTED property sat outside the gate (#1214).
        // The victim is now chosen by SEARCHING for a depth-0 leaf and the
        // choice is asserted, so "depth 0" is a stated property of this proof
        // rather than an accident of which key came first. The nested half of
        // the calibration lives in `openapi-breaking-depth.test.ts`; the two
        // files together are the proof, and neither is sufficient alone.
        const name = Object.keys(committed.components.schemas).find((n) => {
            const props = committed.components.schemas[n].properties;
            return props && Object.keys(props).some((p) => typeof props[p]?.type === 'string');
        });
        expect(name).toBeDefined();

        const mutated = JSON.parse(JSON.stringify(committed));
        const props = mutated.components.schemas[name!].properties;
        const victim = Object.keys(props).find((p) => typeof props[p]?.type === 'string')!;
        // The victim is a depth-0 LEAF: directly under `properties`, and not
        // itself an object with properties of its own.
        expect(Object.keys(committed.components.schemas[name!].properties)).toContain(victim);
        expect(props[victim].properties).toBeUndefined();
        delete props[victim];

        const found = findBreakingChanges(committed, mutated);
        expect(found.length).toBeGreaterThan(0);
        expect(found[0].kind).toBe('property-removed');
        expect(found[0].property).toBe(victim);
    });

    it('MUTATION PROOF: adding an optional field to the real spec is NOT caught', () => {
        const mutated = JSON.parse(JSON.stringify(committed));
        const name = Object.keys(mutated.components.schemas)[0];
        mutated.components.schemas[name].properties = {
            ...mutated.components.schemas[name].properties,
            aBrandNewOptionalField: { type: 'string' },
        };
        expect(findBreakingChanges(committed, mutated)).toEqual([]);
    });
});

/**
 * The gate #1228 is about: this PR measured against its OWN BASE.
 *
 * The describe above compares the committed spec with the spec generated from
 * the same tree, which is a drift check. Breakage is a change BETWEEN commits,
 * so the baseline has to come from a different commit — the PR's base, the
 * same anchor `rendered-coverage-floor` and the selector-teeth job already use.
 *
 * ## Where the baseline comes from, in order
 *
 * 1. `OPENAPI_BASE_SPEC` — a path CI materialises before the suite runs. CI
 *    does the fetching because the `test` job checks out at depth 1 and its
 *    base fetch is `--filter=blob:none`: that supplies the base's TREES, which
 *    is all `git ls-tree` ratchets need, and NOT its blobs, which reading a
 *    file's content does need. Doing it in the workflow keeps that problem
 *    where tools to solve it exist, and keeps this file reading a path.
 * 2. `git show <base>:<spec>` — works locally, and in any clone that has the
 *    blob.
 *
 * ## The three absences, which are three different facts
 *
 * - **No base resolvable** — a local run with no `origin/main`. Degrade.
 * - **Base resolved, spec ABSENT from its tree** — the spec is new in this PR.
 *   Nothing to compare, and that is a real pass, not a skip.
 * - **Base resolved, spec PRESENT in its tree, content unreadable** — the
 *   unfetched-blob case. Returning quietly here would be a vacuous pass with
 *   the require-flag ON, which is the hole the flag exists to close, so it is
 *   fatal in CI.
 *
 * `blobPresentAt` is what separates the second from the third. Without it both
 * read as "no baseline", and the lenient reading silently disables the gate —
 * which is how the vacuous comparison survived in the first place.
 */
describe('the real gate: this PR against its BASE (#1228)', () => {
    const SPEC_REL = 'src/generated/openapi.json';
    const sha = baseSha();
    const fromEnv = process.env.OPENAPI_BASE_SPEC?.trim();

    let baseText: string | null = null;
    let origin = 'none';
    let existedAtBase: boolean | null = null;
    let haveCommit = false;

    if (fromEnv && fs.existsSync(fromEnv)) {
        baseText = fs.readFileSync(fromEnv, 'utf-8');
        origin = `OPENAPI_BASE_SPEC=${fromEnv}`;
        existedAtBase = true;
    } else if (sha) {
        // The commit FIRST. `blobPresentAt` cannot tell "not in that tree"
        // from "no such commit here", and conflating them is a vacuous pass.
        haveCommit = commitPresent(sha);
        existedAtBase = haveCommit ? blobPresentAt(sha, SPEC_REL) : null;
        baseText = haveCommit ? readFileAtSha(sha, SPEC_REL) : null;
        origin = `git show ${sha.slice(0, 9)}:${SPEC_REL}`;
    }

    const generatedDoc = JSON.parse(serializeDoc(buildOpenApiDoc({ verbose: false })));

    it('execution status: says out loud whether the gate actually ran', () => {
        // Modelled on `rls-coverage`'s always-running status test: a gate that
        // did not run must not be indistinguishable from one that passed.
        if (baseText) {
            expect(baseText.length).toBeGreaterThan(1000);
            return;
        }

        const detail =
            sha === null
                ? 'no base commit: RATCHET_BASE_SHA is unset and `git merge-base origin/main HEAD` failed'
                : !haveCommit
                  ? `base ${sha.slice(0, 9)} is NOT IN THIS CLONE (git cat-file says no such commit) — ` +
                    'the gate did NOT run. A bogus or unfetched sha lands here.'
                  : existedAtBase
                    ? `base ${sha.slice(0, 9)} HAS ${SPEC_REL} in its tree but the blob is unreadable — ` +
                      'this clone fetched trees only (--filter=blob:none). The gate did NOT run.'
                    : `base ${sha.slice(0, 9)} has no ${SPEC_REL} — the spec is NEW in this PR, so there ` +
                      'is no prior contract to break.';

        // Exactly ONE absence is a real pass: the commit is readable and the
        // spec genuinely was not in it. Everything else is "could not look".
        if (haveCommit && existedAtBase === false) {
            console.warn(`[breaking-change gate] ${detail}`);
            return;
        }
        if (requireBase()) {
            throw new Error(
                `${detail}\n  CI sets OPENAPI_BASE_SPEC (preferred) or RATCHET_BASE_SHA with the ` +
                    `base commit's blobs present. Fix the workflow rather than relaxing this.`,
            );
        }
        console.warn(`[breaking-change gate] ${detail} (source: ${origin})`);
    });

    it('introduces no breaking change against the BASE contract', () => {
        if (!baseText) return; // reported by the status test above
        const found = findBreakingChanges(JSON.parse(baseText), generatedDoc);
        expect({ breaking: found, base: origin }).toEqual({ breaking: [], base: origin });
    });

    it('control: the base and the generated doc are both real, populated specs', () => {
        if (!baseText) return;
        const base = JSON.parse(baseText);
        // Without this, "no breaking changes" is satisfied by comparing two
        // empty objects — and an empty baseline is exactly what a failed fetch
        // that wrote a 0-byte file would produce.
        expect(Object.keys(base.paths ?? {}).length).toBeGreaterThan(100);
        expect(Object.keys(base.components?.schemas ?? {}).length).toBeGreaterThan(100);
        expect(Object.keys(generatedDoc.paths ?? {}).length).toBeGreaterThan(100);
    });

    it('MUTATION PROOF: a removed property is caught against the BASE too', () => {
        if (!baseText) return;
        // The classifier is proven on synthetic pairs above; this proves the
        // WIRING — that the base baseline is actually being compared, rather
        // than the gate holding the generated doc against itself again.
        const base = JSON.parse(baseText);
        const victim = Object.keys(base.components.schemas).find((n) => {
            const props = base.components.schemas[n]?.properties;
            return props && Object.keys(props).length > 1;
        });
        expect(victim).toBeDefined();

        const mutated = JSON.parse(JSON.stringify(generatedDoc));
        const prop = Object.keys(mutated.components.schemas[victim as string].properties)[0];
        delete mutated.components.schemas[victim as string].properties[prop];

        const found = findBreakingChanges(base, mutated);
        expect(found.length).toBeGreaterThan(0);
        expect(JSON.stringify(found)).toContain(prop);
    });
});

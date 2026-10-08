/**
 * Guard: every schema exported from `@/lib/schemas` is either reachable or
 * acknowledged (#1386).
 *
 * ## What this catches, and why nothing caught it before
 *
 * `scripts/openapi-build.ts` registers OpenAPI components by walking the
 * module namespace:
 *
 *     import * as requestSchemas from '@/lib/schemas';
 *     … { ns: requestSchemas, label: '@/lib/schemas' }
 *
 * So **the export IS the registration**. Nothing distinguishes "exported for a
 * live route" from "exported and forgotten", and a schema whose only consumer
 * has been deleted keeps being published in `src/generated/openapi.json`.
 *
 * That is how `AuthRegisterRequest` outlived its route. #1379 retired
 * `POST /api/auth/register` carefully — a `status: "retired"` ledger entry with
 * a reason, six guards retargeted, the rollback proof ported rather than
 * deleted, the undocumented-path ceiling lowered — and still left
 * `AuthRegisterSchema` and `AuthActionSchema` behind, because no check ranged
 * over "exported schema with no consumer".
 *
 * The cost is paid by somebody this repo cannot see. A client generating from
 * the spec gets a type for a request it can never make, and implements a call
 * that 404s. It is the exact inverse of #1370, where a field existed on the
 * wire but not in the spec — same defect class, the spec and the code
 * disagreeing about what exists, and invisible from inside the repo both times
 * because the web client reads neither.
 *
 * ## Why an orphan may be DEPRECATED rather than gone
 *
 * Deleting an orphan is not free. `docs/api-compatibility.md` classes a removed
 * schema as breaking, and it is right to in the general case: a client that
 * generates types from the spec emits one per component whether or not a path
 * `$ref`s it, so a deletion can fail that client's BUILD even though no
 * endpoint changes and the server sends exactly the bytes it sent before.
 * Measured on the committed spec, 23 of 222 schemas are referenced by no `$ref`
 * at all — including live ones like `AssetCreateRequest` — so "unreferenced"
 * does not distinguish dead from live, and the cheap reclassification that
 * would let the gate wave these through is not available.
 *
 * So this guard accepts two resolutions, and demands one of them:
 *
 *   DELETED       the export is gone. Free when it publishes no component at
 *                 all — `AuthActionSchema` carried no `.openapi()` call, and
 *                 the regenerated spec was byte-identical without it.
 *   DEPRECATED    the published component carries `deprecated: true`, which is
 *                 not one of the six classes `scripts/openapi-breaking.ts`
 *                 scores, so marking it is additive and the gate stays green.
 *                 The schema is then deleted once a client build has shipped
 *                 against a spec carrying the marker.
 *
 * An orphan that is neither is what fails.
 *
 * ## Reachability, not a reference count
 *
 * A plain "is this name mentioned outside its own file" test gets the
 * `AuthRegisterSchema` case wrong. It WAS mentioned — by `AuthActionSchema`,
 * one line below it, which was itself orphaned. Counting references would have
 * cleared a dead schema because another dead schema used it.
 *
 * So liveness propagates from real consumers:
 *
 *   ROOTS       any exported name referenced in CODE by a file under `src/`
 *               that is neither this barrel nor the generated spec — letting
 *               the published artifact vouch for its own input would clear
 *               every orphan it publishes
 *   EDGES       a name referenced inside another export's declaration
 *   ORPHANS     exports no root reaches, transitively
 *
 * A base schema extended by a live one therefore stays live, and a chain of
 * dead schemas propping each other up is reported whole.
 *
 * ## Comments are stripped, and that is the whole guard
 *
 * All three schemas are still written out in
 * `tests/helpers/password-schema-graph.ts` and
 * `tests/guardrails/hibp-coverage.test.ts` — in prose, as the historical
 * example the password detector was measured against — and
 * `CreatePracticeSchema` was named in a `use-zod-form` docblock. Several
 * schemas in this barrel also carry docblocks quoting their own field names. A
 * guard that read comments would have found every one of them "referenced" and
 * passed for ever, which is the failure mode `password-schema-graph.ts` already
 * documents for a different detector: a grep over whole files reads prose as
 * code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';

const REPO = process.cwd();
const BARREL = 'src/lib/schemas/index.ts';
const SPEC = 'src/generated/openapi.json';

/**
 * Remove comments so prose cannot vouch for a symbol.
 *
 * Deliberately not an AST pass. The question here is only "does this identifier
 * appear in code", the population is one file plus a scan, and
 * `password-schema-graph.ts` already carries the AST machinery for the harder
 * question of what a declaration is *composed of*. String literals are left in,
 * which can only make a name look MORE live — the safe direction for a check
 * that fails the build, and a schema's const name does not appear in strings
 * (the published name is a separate one: `AuthRegisterSchema` publishes as
 * `AuthRegisterRequest`).
 */
function stripComments(src: string): string {
    return (
        src
            // LINE comments FIRST, and the order is load-bearing. This barrel
            // contains the line
            //     // plus a deploy/rollback/*.down.sql — but nothing can …
            // whose `/*` opens a block comment as far as a regex is concerned;
            // the match then ran 102 lines to the next `*/` and swallowed ten
            // real `export const` declarations. The population silently read 18
            // instead of 28, and the only reason that was visible is that this
            // suite prints its denominator.
            //
            // `([^:])` so `https://…` inside a string is not mistaken for a
            // comment start — truncating that line could hide a real reference
            // and invent an orphan.
            .split('\n')
            .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
            .join('\n')
            // THEN block comments, blanked but keeping their newlines.
            // Collapsing a docblock to a single space joins the lines around
            // it, so a following `export const` is no longer at a line start
            // and `^export` stops matching — the same position-not-content trap
            // as #1395's indented fixtures.
            .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    );
}

describe('@/lib/schemas exports are reachable or acknowledged (#1386)', () => {
    const barrelCode = stripComments(readFileSync(join(REPO, BARREL), 'utf8'));
    const spec = JSON.parse(readFileSync(join(REPO, SPEC), 'utf8')) as {
        components?: { schemas?: Record<string, { deprecated?: boolean }> };
    };

    const starts = [...barrelCode.matchAll(/^export\s+const\s+([A-Za-z0-9_]+)/gm)];
    const names = starts.map((m) => m[1]);

    /** Declaration text per export: from its `export const` to the next one. */
    const segments = new Map<string, string>();
    starts.forEach((m, i) => {
        const to = i + 1 < starts.length ? starts[i + 1].index! : barrelCode.length;
        segments.set(m[1], barrelCode.slice(m.index!, to));
    });
    /** Imports and shared helpers above the first export are always live. */
    const preamble = starts.length ? barrelCode.slice(0, starts[0].index!) : '';

    const live = new Set<string>();

    beforeAll(() => {
        // `collectSourceFiles` rather than a hand-rolled walk, because
        // `tests/guards/file-collection-is-not-silently-empty.test.ts` is right
        // to insist: it measured that 81% of hand-rolled collectors could be
        // gutted to return `[]` with every assertion built on them still green.
        //
        // An empty scan would not hide a defect HERE — no consumers found means
        // every schema reads as orphaned, so the suite screams rather than
        // passes. The floor earns its keep against the subtler failure: an
        // `exclude` predicate that eats too much quietly shrinks the consumer
        // population and MANUFACTURES orphans, which looks exactly like a real
        // finding.
        const files = collectSourceFiles({
            roots: ['src'],
            exclude: (rel) => rel === BARREL || rel.startsWith('src/generated/'),
            // 2110 at the time of writing. A floor near reality, per this
            // module's own note, rather than the default 1.
            floor: 1500,
        });
        for (const file of files) {
            const code = stripComments(readFileSync(file, 'utf8'));
            for (const n of names) {
                if (new RegExp(`\\b${n}\\b`).test(code)) live.add(n);
            }
        }
        for (const n of names) {
            if (new RegExp(`\\b${n}\\b`).test(preamble)) live.add(n);
        }
        for (let changed = true; changed; ) {
            changed = false;
            for (const n of [...live]) {
                const seg = segments.get(n);
                if (!seg) continue;
                for (const other of names) {
                    if (other === n || live.has(other)) continue;
                    if (new RegExp(`\\b${other}\\b`).test(seg)) {
                        live.add(other);
                        changed = true;
                    }
                }
            }
        }
    });

    /** The component name an export publishes, or null when it publishes none. */
    const componentOf = (name: string): string | null =>
        segments.get(name)?.match(/\.openapi\(\s*'([A-Za-z0-9_]+)'/)?.[1] ?? null;

    const orphansOf = () => names.filter((n) => !live.has(n));

    it('ranges over a non-empty population — the denominator', () => {
        // Without this, "no unacknowledged orphans" is satisfied by an empty
        // population — which is exactly what a broken export regex produces,
        // and what the comment-stripping ORDER bug produced on the first run
        // of this very suite (18 of 28 exports silently invisible).
        expect(names.length).toBeGreaterThan(20);
        expect(names).toContain('AuthRegisterStartSchema');
    });

    it('every orphan is acknowledged — deprecated in the PUBLISHED spec', () => {
        const unacknowledged = orphansOf()
            .map((n) => ({ name: n, component: componentOf(n) }))
            .filter(
                ({ component }) =>
                    component === null ||
                    spec.components?.schemas?.[component]?.deprecated !== true,
            );

        if (unacknowledged.length) {
            throw new Error(
                `${unacknowledged.length} of ${names.length} schemas exported from ${BARREL} ` +
                    `have no consumer under src/ and are not acknowledged:\n\n` +
                    unacknowledged
                        .map(({ name, component }) =>
                            component === null
                                ? `    ${name} — publishes NO component, so deleting it is free: ` +
                                  `the regenerated spec is byte-identical without it. Delete it.`
                                : `    ${name} — published as "${component}", without ` +
                                  `deprecated: true in ${SPEC}.`,
                        )
                        .join('\n') +
                    `\n\nAn export here IS an OpenAPI registration — openapi-build walks this ` +
                    `module's namespace — so each of these is published as a request no client ` +
                    `can make (#1386).\n\n` +
                    `Two ways to resolve one, and the cheap one is often available:\n` +
                    `  • publishes no component → just delete it; the contract cannot change.\n` +
                    `  • publishes a component  → add \`deprecated: true\` to its \`.openapi()\`\n` +
                    `    metadata and run \`npm run openapi:generate\`. That is additive, so the\n` +
                    `    breaking-change gate stays green. Delete the schema once a client build\n` +
                    `    has shipped against a spec carrying the marker, per\n` +
                    `    docs/api-compatibility.md — removal needs owner sign-off, deprecation\n` +
                    `    does not.\n\n` +
                    `References in COMMENTS do not count, by design: all three schemas that ` +
                    `motivated this guard are still named in prose under tests/.`,
            );
        }
    });

    it('the removal queue is exactly what we expect', () => {
        // A pinned list, not a count, and deliberately not an open-ended
        // allowlist: each entry is a schema whose deletion is waiting on a
        // client build. Adding a fourth is a visible act in review rather than
        // a silent widening, and striking one when it is finally deleted is the
        // step that stops this becoming a list nobody ever clears.
        expect(orphansOf().sort()).toEqual(['AuthRegisterSchema', 'CreatePracticeSchema']);
    });

    it('a schema reached only through another schema counts as live', () => {
        // The property that makes this reachability rather than a reference
        // count. Anything `AuthRegisterStartSchema` is composed from must come
        // out live even though no route names it directly.
        const seg = segments.get('AuthRegisterStartSchema') ?? '';
        for (const n of names) {
            if (n === 'AuthRegisterStartSchema') continue;
            if (new RegExp(`\\b${n}\\b`).test(seg)) expect(live.has(n)).toBe(true);
        }
    });
});

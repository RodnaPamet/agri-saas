/**
 * Guardrail: HIBP coverage — password-handling routes.
 *
 * Note: the `auth/register` / `AuthActionSchema` / `AuthRegisterSchema` names
 * in the comments below are HISTORICAL. That route was retired in #1379;
 * #1386 then deleted `AuthActionSchema` (which published no OpenAPI component,
 * so its removal could not change the contract) and marked `AuthRegisterSchema`
 * deprecated pending removal. The comments are kept because they record what
 * the detector was measured against, not because the chain still exists.
 *
 * Invariant: every API route that ingests a user-chosen password MUST
 * import AND call `checkPasswordAgainstHIBP` from
 * `@/lib/security/password-check`. Skipping the call would allow a
 * breached password to be accepted by the API, defeating Epic A.3's
 * breach-screening protection.
 *
 * Failure mode: the test prints the exact file and password field that
 * slipped through, so the contributor knows exactly where to wire the
 * call in.
 *
 * How to extend: when a new password-accepting route ships (password
 * change, reset, recovery, admin-set, …):
 *   1. Import `checkPasswordAgainstHIBP` from
 *      `@/lib/security/password-check` in that route file.
 *   2. Await the call before persisting the password hash.
 *   3. Add an entry to `HIBP_REQUIRED_ROUTES` below with the file path
 *      and the Zod field name so failures are self-documenting.
 *
 * The structural half (test 2) finds the route whether its password field
 * is declared in the route file or in a shared schema module — it resolves
 * the route's imports per symbol. Declaring one in `@/lib/schemas` is the
 * right thing to do for a request schema, because that module is the single
 * source of truth for the generated OpenAPI spec; it used to cost the route
 * its visibility to this guard, and no longer does (#1166).
 *
 * It also finds the field however the field is SPELLED. `password:
 * z.string().min(8)` and `password: PasswordFieldSchema` are both reported —
 * the second being this repo's usual idiom for a reusable Zod field, and the
 * one the detector was blind to until the #1166 follow-up. Write the schema
 * whichever way suits the contract; there is no longer a shape this guard
 * requires you to use.
 */

// Migrated to the shared state-aware `blankNonCode` (#1497).
//
// The local copy this replaces removed BLOCK comments before LINE comments, so
// a `//` line containing `/*` opened a block that ran to the next `*/` and
// deleted the code between. Nine files under `src/` carry such a line for
// ordinary reasons, and this guard can reach one of them.
//
// Measured on `src/lib/schemas/index.ts` before the swap: the buggy strip saw
// 36 exported declarations where a correct one sees 38 — `UpdateTaskSchema`
// and `SetTaskStatusSchema` were invisible. No PASSWORD schema was among them,
// so this guard was not blind to anything it polices; the exposure was latent,
// and the next password field declared in that region would have been missed
// silently.
//
// `blankNonCode` also blanks to spaces rather than deleting, so any caller
// indexing forward from a match keeps its offsets.
import { blankNonCode } from '../helpers/blank-non-code';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import {
    findPasswordFields,
    lastWalkSymbolVisits,
    MAX_HOPS,
    namespaceImportSpecs,
    PASSWORD_FIELD_NAMES,
    WALK_BUDGET_PER_ROUTE,
} from '../helpers/password-schema-graph';

/**
 * Every `route.ts` under the API tree.
 *
 * `collectSourceFiles` rather than a hand-rolled walk: the walk this
 * replaced (`walkRouteFiles`) was measured by `selector-teeth` on
 * 2026-09-29 and SURVIVED being gutted to `return []` — the scan below is a
 * `for` over its result, and an empty list produces no violations. The
 * helper refuses to return fewer than `floor` files instead, which is a
 * guarantee rather than a mutation someone has to remember to run.
 *
 * Floor 300 against 369 today: close enough to reality to catch an exclude
 * predicate that ate most of the tree, loose enough for ordinary churn.
 */
function allRouteFiles(): string[] {
    return collectSourceFiles({
        roots: ['src/app/api'],
        extensions: ['.ts'],
        exclude: (rel) => !rel.endsWith('route.ts'),
        floor: 300,
    });
}

const HIBP_REQUIRED_ROUTES: ReadonlyArray<{
    /** Path relative to repo root. */
    file: string;
    /** Which password field this route accepts (for self-documenting failures). */
    field: string;
}> = [
    {
        // The product's ONLY signup route, and it was in neither half of this
        // guard until #1378: it parsed its body with hand-rolled `typeof`
        // checks, so the structural scan below — which looks for a
        // password-shaped ZOD field — scored it zero and the curated list did
        // not name it either. It CALLED checkPasswordAgainstHIBP throughout;
        // what was missing was anything that would notice if it stopped.
        //
        // It could not simply be added here: the positive control requires
        // every curated route to be one the DETECTOR can see, which is the
        // assertion #1166 closed. So the route got a Zod schema in
        // `@/lib/schemas` first — the shape GAP-10 already prescribed — and
        // this entry became addable rather than an exception.
        file: 'src/app/api/auth/register/start/route.ts',
        field: 'password',
    },
    {
        file: 'src/app/api/auth/change-password/route.ts',
        field: 'newPassword',
    },
    {
        file: 'src/app/api/auth/reset-password/route.ts',
        field: 'newPassword',
    },
    // Future password-change / reset / recovery routes add themselves here.
];

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Import-presence regex.
 * Matches a static ES import of `checkPasswordAgainstHIBP` from the
 * canonical module path. A comment that merely mentions the name does NOT
 * match because it won't start with optional-whitespace + `import`.
 */
const IMPORT_RE =
    /^\s*import\s+\{[^}]*\bcheckPasswordAgainstHIBP\b[^}]*\}\s+from\s+['"]@\/lib\/security\/password-check['"]/m;

/**
 * Call-site regex.
 * Matches `checkPasswordAgainstHIBP(` anywhere in the file (after the
 * import line has been stripped), confirming the function is actually
 * invoked rather than dead-imported.
 */
const CALL_RE = /\bcheckPasswordAgainstHIBP\s*\(/;

function hasImport(src: string): boolean {
    return IMPORT_RE.test(src);
}

function hasCall(src: string): boolean {
    // Strip the import line first so the import itself doesn't count as a call.
    const importMatch = src.match(IMPORT_RE);
    const stripped = importMatch ? src.replace(importMatch[0], '') : src;
    return CALL_RE.test(stripped);
}

/**
 * Result-USE regexes.
 *
 * Asking the question is not enforcement. #613 — a CI-only PR about Playwright
 * retries — deleted the `if (hibp.breached) { …400… }` block from
 * change-password and reset-password while leaving
 * `await checkPasswordAgainstHIBP(body.newPassword);` in place. Both routes
 * accepted known-breached passwords in production from v2.3.0, and THIS
 * GUARDRAIL STAYED GREEN the whole time, because a bare discarded `await`
 * satisfies both `IMPORT_RE` and `CALL_RE`.
 *
 * A fail-open helper makes it quieter still: `checkPasswordAgainstHIBP`
 * returns `breached: false` on a HIBP outage by design, so the discarded-result
 * version is indistinguishable at runtime from a permanent outage — no error,
 * no log, nothing to notice.
 *
 * So the invariant is not "the function is called" but "its answer is read":
 * either the result is bound and that binding's `.breached` is consulted, or
 * the call is member-accessed inline.
 */
const BOUND_CALL_RE =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+checkPasswordAgainstHIBP\s*\(/g;
const INLINE_USE_RE =
    /\(\s*await\s+checkPasswordAgainstHIBP\s*\([^)]*\)\s*\)\s*\.\s*breached\b/;

/** Remove comments so prose mentioning `breached` cannot satisfy the check. */

function usesResult(src: string): boolean {
    const code = blankNonCode(src);
    if (INLINE_USE_RE.test(code)) return true;

    BOUND_CALL_RE.lastIndex = 0;
    for (const m of code.matchAll(BOUND_CALL_RE)) {
        const binding = m[1];
        if (new RegExp(`\\b${binding}\\s*\\.\\s*breached\\b`).test(code)) {
            return true;
        }
    }
    return false;
}

// ── Test 1 — curated list integrity ───────────────────────────────────────

describe('HIBP coverage guardrail — curated list integrity', () => {
    it('HIBP_REQUIRED_ROUTES is non-empty (sanity)', () => {
        expect(HIBP_REQUIRED_ROUTES.length).toBeGreaterThan(0);
    });

    it('every registered field name is one the detector looks for', () => {
        // A route registered under a field name outside
        // `PASSWORD_FIELD_NAMES` is a route the structural scan can never
        // find on its own — it would be held by the curated list alone,
        // which is the asymmetry #1166 was about. Adding a field name here
        // means adding it to the detector's vocabulary in the same change.
        const unknown = HIBP_REQUIRED_ROUTES.map((r) => r.field).filter(
            (field) => !(PASSWORD_FIELD_NAMES as readonly string[]).includes(field),
        );
        expect(unknown).toEqual([]);
    });

    test.each(HIBP_REQUIRED_ROUTES.map((r) => [r.file, r] as const))(
        '%s exists, imports, and calls checkPasswordAgainstHIBP',
        (relPath, entry) => {
            const abs = path.join(REPO_ROOT, relPath);
            expect(fs.existsSync(abs)).toBe(true);

            const src = fs.readFileSync(abs, 'utf8');

            if (!hasImport(src)) {
                throw new Error(
                    [
                        `Route missing checkPasswordAgainstHIBP import.`,
                        ``,
                        `  File:  ${relPath}`,
                        `  Field: ${entry.field}`,
                        `  Add:   import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';`,
                    ].join('\n'),
                );
            }

            if (!hasCall(src)) {
                throw new Error(
                    [
                        `Route imports checkPasswordAgainstHIBP but never calls it.`,
                        ``,
                        `  File:  ${relPath}`,
                        `  Field: ${entry.field}`,
                        ``,
                        `A dangling import is a silent bypass. Await the call before`,
                        `hashing the password, then re-run this test.`,
                    ].join('\n'),
                );
            }

            if (!usesResult(src)) {
                throw new Error(
                    [
                        `Route calls checkPasswordAgainstHIBP but discards its result.`,
                        ``,
                        `  File:  ${relPath}`,
                        `  Field: ${entry.field}`,
                        ``,
                        `A bare \`await checkPasswordAgainstHIBP(...)\` screens nothing —`,
                        `the answer is computed and thrown away, so a breached password`,
                        `is accepted. This is exactly how #613 regressed change-password`,
                        `and reset-password into production for a day.`,
                        ``,
                        `Bind the result and reject on it:`,
                        `    const hibp = await checkPasswordAgainstHIBP(<field>);`,
                        `    if (hibp.breached) { return 400; }`,
                    ].join('\n'),
                );
            }
        },
    );
});

/**
 * Ask the REAL detector about a throwaway module.
 *
 * Shape controls need a witness, and the shapes worth controlling for are by
 * definition the ones no file in the tree uses — a detector blind spot
 * survives precisely because the live population does not exercise it, so
 * measuring the live population can never find it. Hence a fixture.
 *
 * It goes through `findPasswordFields` rather than the matcher underneath, so
 * it pins the CALL SITES too: the matcher is used at two of them (the route's
 * own declarations, and declarations reached through an import) and a revert
 * of either one has to fail something.
 */
function detectInSource(
    source: string,
    extraFiles: Record<string, string> = {},
): ReturnType<typeof findPasswordFields> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hibp-shape-'));
    try {
        for (const [name, content] of Object.entries(extraFiles)) {
            fs.writeFileSync(path.join(dir, name), content, 'utf8');
        }
        const file = path.join(dir, 'route.ts');
        fs.writeFileSync(file, source, 'utf8');
        return findPasswordFields(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── Test 2 — structural scan ───────────────────────────────────────────────

describe('HIBP coverage guardrail — structural scan', () => {
    it('detects a password field however the field is spelled', () => {
        // The #1166 follow-up. `PASSWORD_FIELD_RE` requires a literal `z.`
        // after the colon, so the detector read
        //
        //     password: z.string().min(8)                 ✓ seen
        //     password: PasswordFieldSchema               ✗ INVISIBLE
        //
        // and the second is this repo's normal idiom for a reusable Zod
        // field — 23 uses across 12 files in `src/lib/schemas` and
        // `src/app-layer/schemas` (`category: CostCategorySchema`,
        // `geometry: PolygonGeometrySchema`, …). No route happened to use it
        // for a password, so the before/after flagged SET over the live tree
        // is identical (3 of 374 either way) and the live population could
        // not have shown the gap. A probe did: an unregistered route parsing
        // `z.object({ password: PasswordFieldSchema })` left this whole file
        // green at 13/13, while the inline-shaped probe sitting beside it was
        // reported by name.
        const inline = detectInSource(`
            import { z } from 'zod';
            export const S = z.object({ password: z.string().min(8) });
        `);
        expect(inline.map((h) => h.field)).toEqual(['password']);

        const named = detectInSource(`
            import { z } from 'zod';
            const PasswordFieldSchema = z.string().min(8);
            export const S = z.object({ password: PasswordFieldSchema });
        `);
        expect(named.map((h) => h.field)).toEqual(['password']);

        // All four names, in the shape that used to be invisible — a
        // vocabulary entry the matcher does not actually look for would be
        // caught by test 1, but only for a name someone registered.
        for (const field of PASSWORD_FIELD_NAMES) {
            const hit = detectInSource(`
                import { z } from 'zod';
                const Field = z.string().min(8);
                export const S = z.object({ ${field}: Field });
            `);
            expect(hit.map((h) => h.field)).toEqual([field]);
        }

        // The new shape ACROSS a module boundary. Nothing in the tree
        // exercises it — and since #1376 retired `auth/register`, which was
        // the one live route reaching its schema through an import, nothing
        // CAN. That makes this the only assertion standing between the
        // import-reached matcher and a revert to the old route-file-only
        // regex, so it is the one that fails.
        const crossModule = detectInSource(
            `
            import { SignupSchema } from './schema';
            export const S = SignupSchema;
            `,
            {
                'schema.ts': `
                    import { z } from 'zod';
                    const PasswordFieldSchema = z.string().min(8);
                    export const SignupSchema = z.object({ password: PasswordFieldSchema });
                `,
            },
        );
        expect(crossModule.map((h) => h.field)).toEqual(['password']);
        // Declared elsewhere, so the hit must carry more than one hop.
        expect(crossModule[0].via.length).toBeGreaterThan(1);
        expect(crossModule[0].declaredIn).not.toBe('route.ts');
    });

    it('a password-named property outside a schema is NOT a hit (negative control)', () => {
        // The other half of the above, and the reason the field-name matcher
        // is gated on a Zod-shaped declaration. Ungated, name matching flags
        // 4 of 374 routes instead of 3; the extra one is real and in the
        // tree:
        //
        //   src/app/api/staging/seed/route.ts
        //     return jsonResponse({ login: { email, password: 'password123' } })
        //
        // A hardcoded seed credential returned by a handler that 403s in
        // production is not a user-chosen password, so flagging it is a false
        // positive — and a guard with a false positive is a guard someone
        // switches off. Asserted against the real file, so if that route ever
        // does start taking a password this control fails and says so.
        const seed = path.join(REPO_ROOT, 'src/app/api/staging/seed/route.ts');
        expect(fs.existsSync(seed)).toBe(true);
        expect(fs.readFileSync(seed, 'utf8')).toContain("password: 'password123'");
        expect(findPasswordFields(seed)).toEqual([]);

        // Prose cannot register as a declaration either — the matcher runs on
        // the AST, and `AuthRegisterSchema`'s own `.openapi()` description
        // contains the word password.
        const prose = detectInSource(`
            import { z } from 'zod';
            /** Takes a password: z.string() — see the docs. */
            // password: z.string().min(8)
            export const S = z.object({ email: z.string() });
        `);
        expect(prose).toEqual([]);
    });

    it('the scan reaches EVERY route it polices (positive control)', () => {
        // WITHOUT THIS THE STRUCTURAL HALF IS VACUOUS. The scan below is a
        // `for` over a collected list, so an empty list produces no
        // violations and the guard passes having opened nothing —
        // `selector-teeth` measured exactly that against the old
        // `walkRouteFiles` on 2026-09-29. The collector now REFUSES a short
        // list (`collectSourceFiles`, floor 300), and this control asserts
        // on the DETECTOR, which a floor cannot speak for.
        //
        // Tied to HIBP_REQUIRED_ROUTES rather than to a bare count, because
        // a count cannot detect a rotted pattern: if the detector stops
        // matching, these three known routes go quiet and every future one
        // with them.
        const allRoutes = allRouteFiles();
        expect(allRoutes.length).toBeGreaterThan(300);

        // The COLLECTOR must see every registered route.
        for (const r of HIBP_REQUIRED_ROUTES) {
            expect(allRoutes).toContain(path.join(REPO_ROOT, r.file));
        }

        // And the DETECTOR must find a password field in every one of them.
        // This is the assertion #1166 closed. It used to read
        //
        //     expect(blind).toEqual(['src/app/api/auth/register/route.ts'])  // pre-#1376
        //
        // pinning `auth/register` as a route the scan could not see: its
        // password field is declared on `AuthRegisterSchema` in
        // `@/lib/schemas`, and the scan read route files only, so the
        // primary signup route scored 0 matches where the other two scored
        // 2 and 1. Nothing was exposed — the curated list in test 1 names
        // it — but the half of this guard that exists to catch a route
        // NOBODY REGISTERED was blind to the shape the most important
        // password route in the repo already has.
        const blind = HIBP_REQUIRED_ROUTES.filter(
            (r) => findPasswordFields(path.join(REPO_ROOT, r.file)).length === 0,
        ).map((r) => r.file);
        expect(blind).toEqual([]);

        // The exact fields, per route. This is the no-regression half of the
        // #1166 follow-up: the field-name matcher was added as a UNION with
        // the regex so the population could only grow, and a "widening" that
        // quietly stopped reporting one of these would otherwise be invisible
        // — `blind === []` is satisfied by finding any one field per route,
        // and change-password declares two.
        const fieldsByRoute = Object.fromEntries(
            HIBP_REQUIRED_ROUTES.map((r) => [
                r.file,
                [...new Set(findPasswordFields(path.join(REPO_ROOT, r.file)).map((h) => h.field))].sort(),
            ]),
        );
        expect(fieldsByRoute).toEqual({
            // #1378 — newly VISIBLE, not newly screened. The route always
            // called HIBP; it now declares its password field in Zod, so the
            // detector can see it and the curated entry above has teeth.
            'src/app/api/auth/register/start/route.ts': ['password'],
            'src/app/api/auth/change-password/route.ts': ['currentPassword', 'newPassword'],
            'src/app/api/auth/reset-password/route.ts': ['newPassword'],
        });

        // Import-following is the capability that closed it, so assert the
        // capability and not just the outcome. A detector that had quietly
        // reverted to reading route files only would still satisfy
        // `blind === []` the moment someone moved the field inline — this
        // fails instead, naming the route whose field is declared
        // elsewhere.
        const external = HIBP_REQUIRED_ROUTES.flatMap((r) =>
            findPasswordFields(path.join(REPO_ROOT, r.file))
                .filter((hit) => hit.declaredIn !== r.file)
                .map((hit) => `${r.file} -> ${hit.declaredIn}`),
        );
        expect(external).toEqual([
            // #1378 restores what #1379's retirement removed. `auth/register`
            // was the one live route reaching its password field through an
            // import; retiring it emptied this list and left the synthetic
            // cross-module case as the ONLY thing standing between the
            // import-following matcher and a silent revert to the old
            // route-file-only regex.
            //
            // `register/start` now reaches `AuthRegisterStartSchema` in
            // `@/lib/schemas` the same way, so a real route proves the
            // capability again — which is strictly better than a fixture
            // proving it, because this one cannot be deleted without somebody
            // noticing the signup route changed.
            'src/app/api/auth/register/start/route.ts -> src/lib/schemas/index.ts',
        ]);

        // The real-route multi-hop chain this used to assert
        // (`auth/register` → AuthActionSchema → AuthRegisterSchema) went with
        // the route in #1376, and no surviving route reaches a password field
        // through an import: the two password-management routes declare theirs
        // inline, and `register/start` uses manual type checks. So the
        // import-following matcher is proved by the synthetic cross-module
        // case above, which has real teeth — it fails if the matcher is
        // reverted to reading route files only — rather than by a chain that
        // no longer exists.
    });

    it('the namespace-import detector can see one (positive control)', () => {
        // The assertion below it is `expect(offenders).toEqual([])`, which an
        // empty selection satisfies for free: a `namespaceImportSpecs` that
        // always answered `[]` would pass it forever. So prove the detector
        // reports one where one exists.
        //
        // `src/lib/db/rls-middleware.ts` carries
        // `import * as prismaModule from '@/lib/prisma'` as a deliberate
        // pattern. If it ever stops, this control is the thing that says so —
        // repoint it at another witness (`src/lib/audit/audit-writer.ts` and
        // `src/app-layer/usecases/sso.ts` both carry one today) rather than
        // deleting it.
        const witness = path.join(REPO_ROOT, 'src/lib/db/rls-middleware.ts');
        expect(fs.existsSync(witness)).toBe(true);
        expect(namespaceImportSpecs(witness)).toEqual(['@/lib/prisma']);

        // And an external namespace import is NOT reported — there is
        // nothing of ours to follow into a package, so counting one would
        // make the guard below fail on every file that imports `fs`.
        expect(namespaceImportSpecs(__filename)).toEqual([]);
    });

    it('no route reaches its schema through a namespace import', () => {
        // The one shape `findPasswordFields` cannot resolve. `import * as s
        // from '@/lib/schemas'` has no single symbol to follow, and
        // following the whole module would mark all 40 routes that import
        // from that barrel as password-handling to find the 1 that is.
        //
        // So the gap is asserted shut rather than left to be discovered:
        // zero route files use one today, and the first one to appear
        // fails here instead of silently becoming invisible to the scan.
        const offenders = allRouteFiles()
            .filter((abs) => namespaceImportSpecs(abs).length > 0)
            .map((abs) => `${path.relative(REPO_ROOT, abs)}: ${namespaceImportSpecs(abs).join(', ')}`);
        if (offenders.length > 0) {
            throw new Error(
                [
                    'These route files use a repo-internal namespace import:',
                    ...offenders.map((o) => `  ${o}`),
                    '',
                    'The HIBP structural scan resolves imports PER SYMBOL, so a',
                    'namespace import hides whatever schema the route parses. Import',
                    'the schema by name, or register the route in',
                    'HIBP_REQUIRED_ROUTES if it handles a password.',
                ].join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });

    it('every route that parses a password field is registered', () => {
        const allRoutes = allRouteFiles();
        const registeredFiles = new Set(
            HIBP_REQUIRED_ROUTES.map((r) => path.join(REPO_ROOT, r.file)),
        );

        const violations: string[] = [];
        let scanned = 0;
        let detected = 0;

        for (const absFile of allRoutes) {
            scanned++;
            const hits = findPasswordFields(absFile);
            if (hits.length === 0) continue;
            detected++;

            if (!registeredFiles.has(absFile)) {
                const fieldNames = [...new Set(hits.map((h) => h.field))].join(', ');
                const where = [...new Set(hits.map((h) => h.declaredIn))].join(', ');
                const rel = path.relative(REPO_ROOT, absFile);
                violations.push(
                    `Route \`${rel}\` parses a password field \`${fieldNames}\` (declared in` +
                        ` ${where}) but is not registered in HIBP_REQUIRED_ROUTES. Add an entry` +
                        ` so the HIBP check is enforced on this route, or document why it's` +
                        ` exempt.\n  reached via: ${hits[0].via.join(' -> ')}`,
                );
            }
        }

        if (violations.length > 0) {
            throw new Error(
                [
                    ...violations,
                    '',
                    `(scanned ${scanned} route files, ${detected} of them password-handling)`,
                ].join('\n\n'),
            );
        }

        // Print the denominator next to the answer: a scan reporting zero
        // violations over zero detections is the vacuous pass this control
        // exists to rule out.
        expect(scanned).toBeGreaterThan(300);
        expect(detected).toBe(HIBP_REQUIRED_ROUTES.length);
    });

    it('the import walk stays inside its budget', () => {
        // This is what holds `ZOD_SHAPED_RE` in `password-schema-graph.ts`.
        // Deleting that gate does NOT produce false positives — measured, it
        // flags the same three routes — so there was no correctness
        // assertion available to pin it. What it does produce is 38x the
        // work (2,558 symbol visits → 97,443; 0.8s → 4.4s over 369 routes),
        // which is a budget, so a budget is what guards it.
        const routes = allRouteFiles();
        let visits = 0;
        for (const abs of routes) {
            findPasswordFields(abs);
            visits += lastWalkSymbolVisits();
        }
        const perRoute = visits / routes.length;
        if (perRoute >= WALK_BUDGET_PER_ROUTE) {
            throw new Error(
                `HIBP import walk cost ${visits} symbol visits over ${routes.length} routes ` +
                    `(${perRoute.toFixed(1)}/route, budget ${WALK_BUDGET_PER_ROUTE}). ` +
                    `Measured 6.9/route with the Zod composition gate in ` +
                    `password-schema-graph.ts and 264/route without it — check that gate first.`,
            );
        }
        expect(perRoute).toBeLessThan(WALK_BUDGET_PER_ROUTE);
    });
});

// ── Test 3 — regression proof ──────────────────────────────────────────────

describe('HIBP coverage guardrail — regression proof', () => {
    it('guardrail catches a mutated change-password route that lacks the HIBP import/call', () => {
        // Retargeted from `auth/register` when #1376 retired it. Any curated
        // route works — the proof is about the GUARD, not the route — and
        // change-password is the one whose password field the detector can
        // also see, so a single file exercises both halves.
        const entry = HIBP_REQUIRED_ROUTES.find(
            (r) => r.file === 'src/app/api/auth/change-password/route.ts',
        );
        expect(entry).toBeDefined();

        const abs = path.join(REPO_ROOT, entry!.file);
        const realSrc = fs.readFileSync(abs, 'utf8');

        // Strip the import line and any call site — simulate a PR that forgot both.
        const importMatch = realSrc.match(IMPORT_RE);
        const mutated = importMatch
            ? realSrc.replace(importMatch[0], '').replace(CALL_RE, '/* hibp-removed */')
            : realSrc.replace(CALL_RE, '/* hibp-removed */');

        // The helpers MUST flag the mutated copy.
        expect(hasImport(mutated)).toBe(false);
        expect(hasCall(mutated)).toBe(false);

        // And confirm the real file still passes (self-check).
        expect(hasImport(realSrc)).toBe(true);
        expect(hasCall(realSrc)).toBe(true);
    });

    it('guardrail catches the #613 mutation — the call kept, the rejection deleted', () => {
        // The regression this guard did NOT catch, reproduced exactly. #613
        // replaced the bound call + `if (hibp.breached)` block with a bare
        // discarded await. Import and call both survive, which is why the
        // pre-existing checks stayed green for a day in production.
        const entry = HIBP_REQUIRED_ROUTES.find(
            (r) => r.file === 'src/app/api/auth/change-password/route.ts',
        );
        expect(entry).toBeDefined();

        const realSrc = fs.readFileSync(path.join(REPO_ROOT, entry!.file), 'utf8');

        const mutated = realSrc.replace(
            /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(await\s+checkPasswordAgainstHIBP\s*\()/,
            '$2',
        );
        // Sanity: the mutation actually applied, and did not touch the reject
        // block's own text — this test is worthless if the replace silently
        // no-ops, which is how a mutation proof rots into a tautology.
        expect(mutated).not.toBe(realSrc);

        // The OLD checks cannot tell the difference — this is the blindness.
        expect(hasImport(mutated)).toBe(true);
        expect(hasCall(mutated)).toBe(true);

        // The new one can.
        expect(usesResult(mutated)).toBe(false);
        expect(usesResult(realSrc)).toBe(true);
    });

    it('prose mentioning `breached` does not satisfy the check', () => {
        // reset-password's real comment says "the helper returns breached:false".
        // If comments counted, a discarded-result route would pass on its own
        // documentation.
        const commentOnly = `
            import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';
            // Breached-password screening. The helper returns breached:false on outage.
            /* hibp.breached is handled elsewhere */
            await checkPasswordAgainstHIBP(body.newPassword);
        `;
        expect(hasCall(commentOnly)).toBe(true);
        expect(usesResult(commentOnly)).toBe(false);
    });
});

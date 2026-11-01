/**
 * Every assistant tool reads through a USECASE, never a repository — #2578.
 *
 * ## This guard is the thing the route's permission carve-out depends on
 *
 * `api-permission-coverage` exempts `assistant/stream/route.ts` from
 * `requirePermission`, and the reason is that a single route-level permission
 * would have to be the UNION of every tool's — too WIDE rather than too
 * narrow, granting through one gate what four gates refuse separately.
 *
 * That reason is only honest while the per-tool checks exist. A usecase
 * asserts its own policy on entry (`listTasks` opens with
 * `assertCanReadTasks(ctx)`), so a role the policy refuses is refused by the
 * same code path an HTTP route would have used. A repository call would skip
 * it and read the farm's rows for a role that may not see them —
 * `tenantId`-scoped, so not a cross-tenant leak, and still a policy bypass.
 *
 * The carve-out carries a revisit trigger saying the first-tool PR must touch
 * it. This guard is what that PR pointed it at.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

const TOOLS = 'src/app-layer/ai/assistant/tools.ts';

/**
 * The subject's CODE, comments blanked so prose is not read as an import.
 *
 * A named function rather than a bare `const`, and that is not style:
 * `selector-teeth` counts a selector as a named FUNCTION at module or
 * describe level, so a guard whose selection is an inline const expression is
 * one nothing can mutation-audit. This file was the 201st such against a
 * ceiling of 200 until the selection was extracted here.
 */
function toolsCode(): string {
    return blankNonCode(readFileSync(path.join(REPO_ROOT, TOOLS), 'utf8'));
}

/** Module specifiers the subject imports. */
function importsIn(code: string): string[] {
    return [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
}

const CODE = toolsCode();
const IMPORTS = importsIn(CODE);

describe('assistant tools go through usecases (#2578)', () => {
    it('control: the file was read and imports something', () => {
        // Without this, a renamed file makes every assertion below pass over
        // an empty string with perfect confidence.
        expect(CODE.length).toBeGreaterThan(500);
        expect(IMPORTS.length).toBeGreaterThan(0);
        console.log(`[assistant-tools] ${IMPORTS.length} import(s): ${IMPORTS.join(', ')}`);
    });

    it('imports at least one USECASE — which is where the policy assertion lives', () => {
        const usecases = IMPORTS.filter((i) => i.includes('app-layer/usecases/'));
        expect(usecases.length).toBeGreaterThanOrEqual(1);
    });

    it('imports NO repository and NO prisma CLIENT — a vocabulary is not an access path', () => {
        // The bypass this guard exists for: a repository read is tenantId-
        // scoped and still skips the policy the usecase asserts.
        //
        // The distinction below is measured rather than tidy. The first
        // version banned `@prisma/client` outright, and then failed on
        // `import { WorkItemStatus }` — the schema's own status enum, imported
        // so the valid values are DERIVED rather than retyped. That is not a
        // data read; it is a vocabulary, and banning it pushed me back toward
        // hand-writing enum members, which is exactly the mistake this file's
        // header records (three of five guessed values were wrong).
        //
        // So the check is on what is IMPORTED, not merely from where:
        // `PrismaClient` and the extended singleton at `@/lib/prisma` are
        // access paths; a generated enum or type is not.
        const repos = IMPORTS.filter((i) => i.includes('app-layer/repositories/'));
        const singleton = IMPORTS.filter((i) => /(^|\/)lib\/prisma$/.test(i));
        const clientNames = [...CODE.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@prisma\/client'/g)]
            .flatMap((m) => m[1].split(','))
            .map((n) => n.trim())
            .filter(Boolean);
        const accessPaths = clientNames.filter((n) => /^(PrismaClient|Prisma)$/.test(n));
        expect({ repos, singleton, accessPaths }).toEqual({
            repos: [],
            singleton: [],
            accessPaths: [],
        });
        // And a control: if nothing is imported from `@prisma/client` at all,
        // the `accessPaths` assertion above passes for free. Printed so the
        // reading shows which world we are in.
        console.log(`[assistant-tools] @prisma/client names: ${clientNames.join(', ') || 'none'}`);
    });

    it('every tool def closes its JSON-Schema to the model', () => {
        // `additionalProperties: false` in the schema the MODEL sees, once per
        // tool. A hallucinated argument should be refused rather than ignored.
        //
        // This used to also count `.strict()` here and require the two counts
        // to MATCH — which broke the moment a tool's args schema moved to its
        // own module (`propose.ts`), because the `.strict()` was no longer in
        // this file. The count was never the property; "each schema rejects an
        // unknown key" is, and that is asserted BEHAVIOURALLY in
        // `tests/unit/ai/assistant-tools.test.ts`, where the schemas can be
        // loaded and handed a bad key. Text-matching a strictness marker
        // across module boundaries is the wrong tool for it.
        const closed = (CODE.match(/additionalProperties:\s*false/g) ?? []).length;
        const defs = (CODE.match(/^\s{8}def:\s*\{/gm) ?? []).length;
        console.log(`[assistant-tools] ${defs} def(s), ${closed} closed schema(s)`);
        expect(defs).toBeGreaterThanOrEqual(1);
        expect(closed).toBe(defs);
    });

    it('does not expose a free-text query parameter to the model', () => {
        // `TaskFilters.q` is real and deliberately unexposed: it is the one
        // argument whose content cannot be bounded by a charset. Asserted
        // rather than merely commented, because adding it back would be a
        // one-word diff.
        expect(CODE).not.toMatch(/\bq:\s*z\.string/);
    });
});

/**
 * Guard: `npm run typecheck` does not trust the incremental cache (#1829).
 *
 * ## The measurement
 *
 * `tsconfig.json` sets `incremental: true`. With a `tsconfig.tsbuildinfo`
 * present, `tsc --noEmit` reported **0 errors for a newly added file that
 * contained 12** — wrong props on a shared `FormField`, a `string` where a
 * `DatePicker` wanted a `Date`, and a `RequestInit` passed in the argument
 * slot that takes a Zod schema, so an `Idempotency-Key` was silently never
 * sent. On that route a missing key means the server mints a UUID, so every
 * retry would have written another treatment into a regulated register.
 *
 * Deleting the cache, or passing `--incremental false`, reported all twelve.
 *
 * The only observation that separates "this file is clean" from "this file is
 * not being read" is a deliberate error — `const __probe: number = 'x';` —
 * which still reported zero. Nothing else distinguishes the two.
 *
 * ## Why a guard, when the subject is the toolchain
 *
 * A guard cannot catch the stale cache itself: it would run under the same
 * cache. What it can hold is the DECISION — that the default command pays the
 * cold cost — because the obvious future edit is to delete `--incremental
 * false` to make a slow script fast again, and nothing would notice. CI runs
 * `tsc` directly from a fresh checkout, so it is cold either way; the flag is
 * what makes a LOCAL run mean the same thing as the CI one.
 *
 * Owner ruling 2026-10-15: cold by default, with the warm path kept under a
 * name rather than removed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../helpers/collect-files';

interface PackageJson {
    scripts?: Record<string, string>;
}

const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
) as PackageJson;

describe('the default typecheck is cold (#1829)', () => {
    it('`typecheck` passes --incremental false', () => {
        const cmd = pkg.scripts?.typecheck;
        expect(typeof cmd).toBe('string');
        // Named so the failure says what to restore rather than just failing.
        expect(`typecheck: ${cmd}`).toContain('--incremental false');
    });

    it('`typecheck:fast` exists, so the warm path has a name', () => {
        // Without it the cold default is a tax with no escape, and the next
        // person removes the flag instead of using the other script.
        const fast = pkg.scripts?.['typecheck:fast'];
        expect(typeof fast).toBe('string');
        expect(`typecheck:fast: ${fast}`).toContain('tsc --noEmit');
        expect(`typecheck:fast: ${fast}`).not.toContain('--incremental false');
    });

    it('both invoke tsc through node with the heap flag, or they OOM', () => {
        // MEASURED, not precautionary: `npm run typecheck:fast` exited 134
        // after 315s on this tree — a V8 heap abort, not a type error. tsc's
        // peak heap grows with the codebase plus the generated Prisma client,
        // and the runner's default ceiling is no longer enough.
        //
        // Through `node … tsc` rather than `NODE_OPTIONS`, because CI's own
        // comment records that NODE_OPTIONS does not reliably reach the tsc
        // process. A local script that cannot finish is worse than a slow
        // one: 134 is not a type error, and a reader who sees it may conclude
        // the toolchain is broken rather than that the flag is missing.
        for (const name of ['typecheck', 'typecheck:fast'] as const) {
            const cmd = `${name}: ${pkg.scripts?.[name]}`;
            expect(cmd).toContain('--max-old-space-size=8192');
            expect(cmd).toContain('node_modules/typescript/bin/tsc');
        }
    });

    it('both still cover the scripts program, which the root config excludes', () => {
        // `tsconfig.json` excludes `scripts/`, so `worker.ts` and
        // `scheduler.ts` — the two processes that run the queue in production
        // — are typechecked by nothing unless each command runs the second
        // program too. A cold-by-default change that dropped it would trade
        // one blind spot for another.
        for (const name of ['typecheck', 'typecheck:fast'] as const) {
            expect(`${name}: ${pkg.scripts?.[name]}`).toContain('tsconfig.scripts.json');
        }
    });

    it('CLAUDE.md tells the reader which one lies, and when', () => {
        // The scripts are only half the fix: someone reaching for a typecheck
        // reads the command block, and a warm run on a NEW file is the case
        // that silently reports nothing.
        const claude = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
        expect(claude).toContain('typecheck:fast');
        expect(claude).toMatch(/incremental/i);
    });
});

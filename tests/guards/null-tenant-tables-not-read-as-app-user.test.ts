/**
 * P1.4's safety argument, kept from going stale.
 *
 * The migration narrows the NULL-tenant arm on `UserSession`,
 * `NativeRefreshToken` and `NativeAuthCode` from "visible to any `app_user`" to
 * "visible to its own user", and makes the two org policies `FOR SELECT`. All
 * of that is written to fail CLOSED: with `app.user_id` unset,
 * `"userId" = current_setting('app.user_id', true)` is NULL, so a null-tenant
 * row is INVISIBLE under `app_user`.
 *
 * That is safe for exactly one measured reason: **nothing reads these tables
 * under `app_user` today.** Every access uses the global Prisma client or an
 * explicit `asSystem(...)` — which is `runWithAuditContext({source:'system'})`,
 * an audit marker and NOT a role switch — so `superuser_bypass` fires. Measured
 * 2026-10-02 by reading every call site, and confirmed from inside a test:
 * `withTenantDb` does enter `app_user`, and `app.user_id` comes back NULL.
 *
 * A future path that enters `app_user` to touch one of these tables, before
 * P1.5 sets `app.user_id`, would see ZERO rows — fail-closed, so not a leak,
 * but a silent and confusing one. This is the tripwire for that.
 *
 * ── what this guard is NOT ──
 *
 * It is not a reachability proof. It cannot follow a call graph, so a file that
 * touches one of these tables and a file that enters `app_user` could cooperate
 * at a distance and this would not see it. What it does see is the common
 * shape — one module doing both — which is how the change would actually
 * arrive. Treat a failure as "read the file", not as "you broke it".
 */
import fs from 'fs';
import path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** Prisma accessors for the tables whose NULL arm P1.4 scoped to one user. */
const GUARDED_ACCESSORS = [
    'userSession',
    'nativeRefreshToken',
    'nativeAuthCode',
    'orgMembership',
    'organization',
] as const;

/** Entering `app_user` is what makes the policies apply at all. */
const APP_USER_ENTRY = /\b(runInTenantContext|withTenantDb)\s*\(/;

/**
 * Files allowed to do both, each with the reason.
 *
 * Empty today, and that is the measurement. An entry here is a statement that
 * someone read the file and confirmed the access is either not under
 * `app_user`, or is and correctly sets `app.user_id`.
 */
const ALLOWED: Readonly<Record<string, string>> = {};

/** Mask comments — `refresh-tokens.ts` MENTIONS runInTenantContext in prose to
 * say it deliberately runs outside it, and a naive grep counted that as a use. */
function codeOf(source: string): string {
    return blankNonCode(source);
}

export function touchesGuardedTable(source: string): string[] {
    const code = codeOf(source);
    return GUARDED_ACCESSORS.filter((a) =>
        new RegExp(`\\b(?:prisma|tx|db|client)\\s*\\.\\s*${a}\\b`).test(code),
    );
}

export function entersAppUser(source: string): boolean {
    return APP_USER_ENTRY.test(codeOf(source));
}

const FILES = collectSourceFiles({ roots: ['src'], floor: 500 }).map((abs) => ({
    rel: path.relative(REPO_ROOT, abs).split(path.sep).join('/'),
    src: fs.readFileSync(abs, 'utf8'),
}));

describe('no module both enters app_user and touches a user-scoped table', () => {
    it('the detector finds the tables it is about', () => {
        // Without this, a renamed accessor would make the sweep below range
        // over nothing and pass forever.
        const touching = FILES.filter((f) => touchesGuardedTable(f.src).length > 0);
        expect(FILES.length).toBeGreaterThan(500);
        expect(touching.length).toBeGreaterThan(3);
    });

    it('and it finds the modules that DO enter app_user', () => {
        // The other half of the same concern: if this were zero, the
        // intersection below would be empty for the wrong reason.
        expect(FILES.filter((f) => entersAppUser(f.src)).length).toBeGreaterThan(3);
    });

    it('the intersection is empty', () => {
        const both = FILES.filter(
            (f) =>
                !(f.rel in ALLOWED) && entersAppUser(f.src) && touchesGuardedTable(f.src).length > 0,
        ).map((f) => `${f.rel} -> ${touchesGuardedTable(f.src).join(', ')}`);

        if (both.length > 0) {
            throw new Error(
                `${both.length} module(s) enter app_user AND touch a table whose NULL-tenant ` +
                    `rows are user-scoped since P1.4:\n  ` +
                    both.join('\n  ') +
                    `\n\nUnder app_user with app.user_id UNSET, a null-tenant row is INVISIBLE — ` +
                    `the read returns zero rows and nothing errors. Either set app.user_id ` +
                    `(P1.5's runInUserContext), or confirm the access is not under app_user and ` +
                    `add the file to ALLOWED with the reason.`,
            );
        }
    });

    it('no stale ALLOWED entry', () => {
        for (const [rel, reason] of Object.entries(ALLOWED)) {
            expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
            expect(reason.length).toBeGreaterThan(25);
        }
    });
});

describe('the detector has teeth', () => {
    it('sees an accessor and an app_user entry', () => {
        expect(touchesGuardedTable('await prisma.userSession.findMany({})')).toEqual(['userSession']);
        expect(touchesGuardedTable('await tx.nativeAuthCode.delete({})')).toEqual(['nativeAuthCode']);
        expect(entersAppUser('return withTenantDb(id, async (tx) => {})')).toBe(true);
        expect(entersAppUser('await runInTenantContext(ctx, fn)')).toBe(true);
    });

    it('is not fooled by PROSE, which is how the measurement first went wrong', () => {
        // `src/lib/auth/native/refresh-tokens.ts` has a docblock saying token
        // refresh runs OUTSIDE runInTenantContext by construction. A plain
        // `grep -c` counted that sentence as a use and reported the file as a
        // violation — the comment-masking lesson, applied to my own grep.
        expect(
            entersAppUser('/**\n * Runs OUTSIDE `runInTenantContext` by construction.\n */'),
        ).toBe(false);
        expect(entersAppUser('// withTenantDb(x) would be wrong here')).toBe(false);
        expect(touchesGuardedTable('// prisma.userSession.findMany is deliberately avoided')).toEqual([]);
    });

    it('does not match a different table with a shared prefix', () => {
        expect(touchesGuardedTable('await prisma.userSessionArchive.findMany({})')).toEqual([]);
        expect(touchesGuardedTable('await prisma.organizationInvite.findMany({})')).toEqual([]);
    });
});

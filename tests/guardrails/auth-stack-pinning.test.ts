/**
 * GAP-04 — Structural ratchet for the NextAuth v4 stable stack.
 *
 * The audit's GAP-04 finding was that the production auth layer was
 * running on `next-auth@5.0.0-beta.30` and the auth path carried
 * `as any` casts driven by v5-beta type drift. The fix landed in
 * commit `4de1988` (v5-beta → v4.24.14 migration). This guardrail
 * locks the post-migration invariants so a future PR cannot quietly
 * regress the codebase back to a beta build, leak `as any` casts
 * back into the middleware/auth surface, or detach the type
 * augmentation that made the migration type-safe.
 *
 * Each assertion has a one-line note explaining the regression
 * class it protects.
 */

import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

function readJson(rel: string): Record<string, unknown> {
    return JSON.parse(readRepoFile(rel));
}

describe('GAP-04 ratchet — dependency pinning', () => {
    it('package.json pins next-auth to v4 stable, no caret, no beta', () => {
        const pkg = readJson('package.json') as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const version = deps['next-auth'];
        expect(version).toBeDefined();
        // No caret/tilde — silent drift is blocked at lockfile resolution.
        // Regression: switching to `^4.24.x` would let `npm install` pick
        // up a v4 patch that hasn't been verified against the codebase.
        expect(version).not.toMatch(/^[\^~]/);
        // Must be a v4 release; reject any beta / next / canary suffix.
        // Regression: a slip back to `5.0.0-beta.x` is the exact state
        // the audit closed. A slip to `4.x.x-beta.x` would also be
        // unstable.
        expect(version).toMatch(/^4\.\d+\.\d+$/);
        expect(version).not.toMatch(/beta|alpha|rc|next|canary/i);
    });

    it('package.json uses @next-auth/prisma-adapter (v4-era), not @auth/prisma-adapter (v5)', () => {
        const pkg = readJson('package.json') as {
            dependencies?: Record<string, string>;
        };
        const deps = pkg.dependencies ?? {};
        // Regression: a "modernise" PR that swaps to `@auth/prisma-adapter`
        // re-couples to the v5 ecosystem and breaks the migration.
        expect(deps['@next-auth/prisma-adapter']).toBeDefined();
        expect(deps['@auth/prisma-adapter']).toBeUndefined();
        // Pin shape — same rules as next-auth itself.
        const adapterVersion = deps['@next-auth/prisma-adapter'];
        expect(adapterVersion).not.toMatch(/^[\^~]/);
    });

    it('the deleted v5-only auth.config.ts is not reintroduced', () => {
        // v4 doesn't need the edge/node config split. A future PR that
        // adds auth.config.ts back is almost certainly attempting to
        // restore the v5 pattern.
        const fullPath = path.join(REPO_ROOT, 'src/auth.config.ts');
        expect(fs.existsSync(fullPath)).toBe(false);
    });
});

describe('GAP-04 ratchet — auth-critical type safety', () => {
    const AUTH_CRITICAL_FILES = [
        'src/auth.ts',
        'src/middleware.ts',
        'src/app/api/auth/[...nextauth]/route.ts',
    ];

    it.each(AUTH_CRITICAL_FILES)(
        '%s contains zero `as any` casts (excluding comments)',
        (rel) => {
            const src = readRepoFile(rel);
            // Strip line comments, block comments, and JSDoc — the
            // migration commit deliberately mentions "as any" in
            // historical comments; what we forbid is a real cast in
            // executable code.
            const stripped = blankNonCode(src);
            // Regression: a TS-trick PR that adds `(token as any).newField`
            // would re-introduce the v5-beta-era type instability the
            // audit flagged. The augmentation in auth.ts declares every
            // token field — there's no legitimate reason to cast.
            expect(stripped).not.toMatch(/\bas\s+any\b/);
        },
    );

    it.each(AUTH_CRITICAL_FILES)(
        '%s has no @ts-ignore / @ts-expect-error / @ts-nocheck suppressions',
        (rel) => {
            const src = readRepoFile(rel);
            // Regression: type suppressions in auth-critical code mean
            // a runtime field access doesn't match its declared shape.
            // For the migration to "stick", every token / session
            // access must be typed — not silenced.
            expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|@ts-nocheck/);
        },
    );
});

describe('GAP-04 ratchet — module augmentation present', () => {
    it('src/auth.ts declares both Session and JWT augmentations', () => {
        const src = readRepoFile('src/auth.ts');
        // Regression: dropping either augmentation leaves the auth-
        // critical reads untyped. Middleware would lose `token.role`
        // type safety; server components would lose `session.user.tenantId`.
        expect(src).toMatch(/declare module ['"]next-auth['"]/);
        expect(src).toMatch(/declare module ['"]next-auth\/jwt['"]/);
        // Sanity-check the JWT augmentation actually declares the fields
        // middleware reads. If a refactor renames any of these, the
        // middleware breaks at the read site (and one of the auth tests
        // fails) — but the guardrail surfaces the schema breakage at
        // the structural level.
        expect(src).toMatch(/role\??:\s*Role/);
        expect(src).toMatch(/memberships\??:\s*MembershipEntry\[\]/);
    });
});

describe('GAP-04 ratchet — provider import surface', () => {
    it('src/auth.ts uses v4 provider paths, not v5 paths', () => {
        const src = readRepoFile('src/auth.ts');
        // v5 renamed `azure-ad` → `microsoft-entra-id`. v4 ships under
        // the original name. A PR that imports from `microsoft-entra-id`
        // is almost certainly reintroducing v5 dependencies.
        expect(src).not.toMatch(/from ['"]next-auth\/providers\/microsoft-entra-id['"]/);
        expect(src).toMatch(/from ['"]next-auth\/providers\/azure-ad['"]/);
        expect(src).toMatch(/from ['"]next-auth\/providers\/google['"]/);
        expect(src).toMatch(/from ['"]next-auth\/providers\/credentials['"]/);
    });

    it('src/middleware.ts reads JWT via getToken (v4), not auth() async wrapper (v5)', () => {
        const src = readRepoFile('src/middleware.ts');
        // Regression: a refactor that pulls `auth` back from `@/auth`
        // and wraps with `auth(async (req) => …)` is reintroducing the
        // v5 middleware pattern that bundled the full config into the
        // Edge runtime and required `req.auth as any` casts.
        expect(src).toMatch(/from ['"]next-auth\/jwt['"]/);
        expect(src).toMatch(/getToken\(/);
        expect(src).not.toMatch(/^const\s+\{\s*auth\s*\}\s*=\s*NextAuth\(/m);
    });
});

describe('GAP-04 ratchet — route handler shape', () => {
    it('the catch-all route uses v4 NextAuth(authOptions), not v5 destructured handlers', () => {
        const src = readRepoFile('src/app/api/auth/[...nextauth]/route.ts');
        // Regression: a refactor to `import { handlers } from '@/auth';
        // export const { GET, POST } = handlers` is the v5 pattern,
        // and `@/auth` no longer exports `handlers`.
        expect(src).toMatch(/NextAuth\(authOptions\)/);
        expect(src).not.toMatch(/import\s*\{\s*handlers\s*\}\s*from\s*['"]@\/auth['"]/);
    });
});

/**
 * Guardrail: HIBP coverage — password-handling routes.
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
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const HIBP_REQUIRED_ROUTES: ReadonlyArray<{
    /** Path relative to repo root. */
    file: string;
    /** Which password field this route accepts (for self-documenting failures). */
    field: string;
}> = [
    {
        file: 'src/app/api/auth/register/route.ts',
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

/**
 * Password-field heuristic.
 * Detects Zod schema fields whose name looks like a password input.
 * Captures the field name for diagnostic messages.
 */
const PASSWORD_FIELD_RE =
    /\b(password|newPassword|currentPassword|confirmPassword)\s*:\s*z\./g;

function walkRouteFiles(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkRouteFiles(full));
        } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
            out.push(full);
        }
    }
    return out;
}

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
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function usesResult(src: string): boolean {
    const code = stripComments(src);
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

// ── Test 2 — structural scan ───────────────────────────────────────────────

describe('HIBP coverage guardrail — structural scan', () => {
    it('every route.ts that parses a password field is registered', () => {
        const apiDir = path.join(REPO_ROOT, 'src/app/api');
        const allRoutes = walkRouteFiles(apiDir);
        const registeredFiles = new Set(
            HIBP_REQUIRED_ROUTES.map((r) => path.join(REPO_ROOT, r.file)),
        );

        const violations: string[] = [];

        for (const absFile of allRoutes) {
            const src = fs.readFileSync(absFile, 'utf8');
            const matches = [...src.matchAll(PASSWORD_FIELD_RE)];
            if (matches.length === 0) continue;

            if (!registeredFiles.has(absFile)) {
                const fieldNames = [...new Set(matches.map((m) => m[1]))].join(', ');
                const rel = path.relative(REPO_ROOT, absFile);
                violations.push(
                    `Route \`${rel}\` parses a password field \`${fieldNames}\` but is not` +
                        ` registered in HIBP_REQUIRED_ROUTES. Add an entry so the HIBP check is` +
                        ` enforced on this route, or document why it's exempt.`,
                );
            }
        }

        if (violations.length > 0) {
            throw new Error(violations.join('\n\n'));
        }
    });
});

// ── Test 3 — regression proof ──────────────────────────────────────────────

describe('HIBP coverage guardrail — regression proof', () => {
    it('guardrail catches a mutated register/route.ts that lacks the HIBP import/call', () => {
        const entry = HIBP_REQUIRED_ROUTES.find(
            (r) => r.file === 'src/app/api/auth/register/route.ts',
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
            (r) => r.file === 'src/app/api/auth/register/route.ts',
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

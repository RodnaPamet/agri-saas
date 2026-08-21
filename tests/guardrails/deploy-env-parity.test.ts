/**
 * Guardrail: deploy/env.prod.example stays in parity with src/env.ts.
 *
 * The deploy doc (deploy/env.prod.example) is the keys-only companion an
 * operator fills in on the VM. If a new REQUIRED-in-production env var lands in
 * src/env.ts but never reaches the example, the first anyone learns of it is a
 * prod boot crash. This test derives the required set straight from the live
 * schema source and fails CI if the example is missing any of them.
 *
 * "Required in production" =
 *   • a server var with neither `.optional()` nor `.default(...)` (always
 *     required), OR
 *   • one of the vars that is optional-shaped in the schema but enforced in
 *     production by a `NODE_ENV`-gated superRefine / a non-Vercel ternary
 *     (`ALSO_REQUIRED_IN_PROD` — a small, reviewed list).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const ENV_TS = fs.readFileSync(path.join(ROOT, 'src/env.ts'), 'utf8');
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'deploy/env.prod.example'), 'utf8');

// Optional-shaped in the schema but prod-required via a NODE_ENV superRefine
// (REDIS_URL, DATA_ENCRYPTION_KEY) or a non-Vercel ternary (NEXTAUTH_URL,
// AUTH_URL). A new prod-conditional var must be added here in the same PR.
const ALSO_REQUIRED_IN_PROD = ['REDIS_URL', 'DATA_ENCRYPTION_KEY', 'NEXTAUTH_URL', 'AUTH_URL'];

/**
 * A THIRD category the "required" rule cannot see: vars whose schema DEFAULT
 * silently switches a feature OFF.
 *
 * `requiredServerVars` treats `.default(...)` as "safe to omit", and for most
 * vars it is — the default is a working value. But a default can also be a
 * fail-closed sentinel, and then omitting the key from the example produces no
 * boot error, no log line, and a feature that simply does not work.
 *
 * `NATIVE_AUTH_REDIRECT_ALLOWLIST` is the measured case. It is
 * `z.string().default("")` in src/env.ts; `isAllowedRedirect` returns false on
 * an empty allowlist by design; and on 2026-08-21 the key was absent from
 * /opt/agrent/.env entirely, so every native sign-in redirect was refused in
 * production while CI, the schema and this guard were all green.
 *
 * Each entry must be listed in deploy/env.prod.example WITH a comment saying
 * what the default disables — the key alone is not enough, because an operator
 * reading `NATIVE_AUTH_REDIRECT_ALLOWLIST=` learns nothing from it.
 */
const FEATURE_DISABLING_DEFAULTS = ['NATIVE_AUTH_REDIRECT_ALLOWLIST'];

function serverBlock(src: string): string {
    const start = src.indexOf('server: {');
    if (start < 0) throw new Error('could not locate server block in src/env.ts');
    // Bound at whichever section follows the server block first.
    const candidates = ['\n    client:', '\n    runtimeEnv', 'experimental__runtimeEnv']
        .map((m) => src.indexOf(m, start))
        .filter((i) => i > 0);
    const end = candidates.length ? Math.min(...candidates) : src.length;
    return src.slice(start, end);
}

function requiredServerVars(src: string): string[] {
    const block = serverBlock(src);
    // Server vars are declared at an 8-space indent as `NAME: z...`.
    const re = /\n {8}([A-Z][A-Z0-9_]*):\s*z/g;
    const matches = [...block.matchAll(re)];
    const required = new Set<string>();
    for (let i = 0; i < matches.length; i++) {
        const name = matches[i][1];
        const from = matches[i].index ?? 0;
        const to = i + 1 < matches.length ? (matches[i + 1].index ?? block.length) : block.length;
        const text = block.slice(from, to);
        const isOptional = text.includes('.optional()');
        const hasDefault = text.includes('.default(');
        if ((!isOptional && !hasDefault) || ALSO_REQUIRED_IN_PROD.includes(name)) {
            required.add(name);
        }
    }
    return [...required].sort();
}

function exampleKeys(src: string): Set<string> {
    const keys = new Set<string>();
    for (const line of src.split(/\r?\n/)) {
        const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
        if (m) keys.add(m[1]);
    }
    return keys;
}

describe('deploy/env.prod.example parity with src/env.ts', () => {
    const required = requiredServerVars(ENV_TS);
    const keys = exampleKeys(EXAMPLE);

    it('derives a non-trivial required set (sanity)', () => {
        expect(required.length).toBeGreaterThanOrEqual(8);
        // Anchor a few load-bearing ones so a parse regression is caught.
        expect(required).toEqual(
            expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'DATA_ENCRYPTION_KEY', 'AUTH_SECRET']),
        );
    });

    it.each(required)('deploy/env.prod.example lists prod-required var %s', (name) => {
        expect(keys.has(name)).toBe(true);
    });

    it.each(FEATURE_DISABLING_DEFAULTS)(
        'deploy/env.prod.example lists %s, whose default disables a feature',
        (name) => {
            expect(keys.has(name)).toBe(true);
        },
    );

    it.each(FEATURE_DISABLING_DEFAULTS)('%s is EXPLAINED, not just listed', (name) => {
        // The key on its own teaches an operator nothing. What they need is the
        // sentence saying an empty value turns the feature off — that is the
        // whole reason this category exists.
        const lines = EXAMPLE.split(/\r?\n/);
        const at = lines.findIndex((l) => l.startsWith(`${name}=`));
        expect(at).toBeGreaterThan(-1);

        // Walk UP from the key and count only the CONTIGUOUS comment block that
        // belongs to it. A windowed search ("any # lines within N chars") passes
        // on the strength of the PREVIOUS var's comments — measured: stripping
        // this var's entire explanation left such a check green.
        let n = 0;
        for (let i = at - 1; i >= 0 && lines[i].startsWith('#'); i--) n++;
        if (n < 3) {
            throw new Error(
                `${name} is listed in deploy/env.prod.example with ${n} comment line(s) ` +
                    `directly above it. It needs an explanation of what its DEFAULT disables — ` +
                    `the bare key teaches an operator nothing, which is the whole reason this ` +
                    `category exists.`,
            );
        }
    });

    it('every FEATURE_DISABLING_DEFAULTS entry really has a default in src/env.ts', () => {
        // No stale entries: if a var is promoted to required, or deleted, this
        // list must shrink in the same diff rather than quietly guarding nothing.
        const block = serverBlock(ENV_TS);
        for (const name of FEATURE_DISABLING_DEFAULTS) {
            const re = new RegExp(`\\n {8}${name}:\\s*z[^\\n]*`, 'g');
            const decl = block.match(re)?.[0];
            if (decl === undefined) {
                throw new Error(
                    `${name} is in FEATURE_DISABLING_DEFAULTS but is not declared in ` +
                        `src/env.ts's server block. Remove the stale entry, or fix the name.`,
                );
            }
            // If it lost its default it is now genuinely required, and belongs
            // in the derived set rather than this list.
            expect(decl).toContain('.default(');
        }
    });
});

describe('deploy shell scripts parse cleanly (bash -n)', () => {
    it.each(['deploy/apply.sh', 'deploy/check-drift.sh'])('%s has no syntax errors', (rel) => {
        const res = spawnSync('bash', ['-n', path.join(ROOT, rel)], { encoding: 'utf8' });
        expect(res.stderr || '').toBe('');
        expect(res.status).toBe(0);
    });
});

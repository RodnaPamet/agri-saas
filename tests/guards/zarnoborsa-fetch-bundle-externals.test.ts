/**
 * #3081 — the ZarnoBorsa fetch bundle may import ONLY `playwright`.
 *
 * ## Why a guard rather than a comment
 *
 * `dist/zarnoborsa-fetch.mjs` runs in the official Playwright image, not in
 * this product's runtime image — Playwright cannot be in ours, because
 * `verify-image-deps.mjs` forbids it and exists for the reason that `npm
 * prune --omit=dev` CANNOT remove it.
 *
 * So the bundle's externals ARE its image contract. esbuild keeps
 * node_modules external, which means every package it imports must exist in
 * the fetch image — and that image has Playwright and node, and nothing of
 * ours. Adding a Prisma import, or anything else from `@/lib` that transitively
 * reaches one, typechecks fine, bundles fine, passes every test, and then
 * throws `Cannot find module` inside a container that runs three times a day
 * with nobody watching. The symptom would be no new prices and a `failed` log
 * line in a place nobody reads.
 *
 * ## It reads the SOURCE, not the built artefact
 *
 * The bundle is a build output and is not committed, so a guard reading
 * `dist/` would pass by finding nothing on a clean checkout — the
 * empty-population failure. It parses the ENTRYPOINT's import statements and
 * walks its first-party imports transitively, which is the same question
 * asked where the answer is version-controlled.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const ENTRY = 'scripts/zarnoborsa-fetch.ts';

/** Packages the fetch IMAGE provides. Node builtins are allowed implicitly. */
const ALLOWED_EXTERNALS = new Set(['playwright']);

const NODE_BUILTINS = new Set([
    'fs', 'path', 'url', 'util', 'os', 'crypto', 'stream', 'events', 'assert',
    'buffer', 'child_process', 'http', 'https', 'net', 'zlib', 'timers',
]);

function importsOf(rel: string): string[] {
    const file = join(ROOT, rel);
    if (!existsSync(file)) return [];
    const src = readFileSync(file, 'utf8');
    const out: string[] = [];
    const re = /^\s*import\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
}

/** `../src/lib/x` or `@/lib/x` → a repo-relative .ts path, else null. */
function resolveFirstParty(spec: string, fromRel: string): string | null {
    if (spec.startsWith('@/')) return `src/${spec.slice(2)}.ts`;
    if (!spec.startsWith('.')) return null;
    const fromDir = fromRel.split('/').slice(0, -1);
    const parts = spec.split('/');
    const stack = [...fromDir];
    for (const p of parts) {
        if (p === '.') continue;
        else if (p === '..') stack.pop();
        else stack.push(p);
    }
    return `${stack.join('/')}.ts`;
}

describe('#3081 — the fetch bundle imports only what its image has', () => {
    it('EXTRACTION CONTROL — the entrypoint parses and has imports', () => {
        // Without this the whole guard passes over nothing: a renamed
        // entrypoint or a changed import style empties the scan and every
        // assertion below is then true of an empty set.
        const direct = importsOf(ENTRY);
        expect(existsSync(join(ROOT, ENTRY))).toBe(true);
        expect(direct.length).toBeGreaterThan(3);
        // And it really does reach our own code, or the transitive walk below
        // is grading nothing.
        expect(direct.some((s) => s.startsWith('.') || s.startsWith('@/'))).toBe(true);
    });

    it('every external is one the fetch image provides', () => {
        const seen = new Set<string>([ENTRY]);
        const queue = [ENTRY];
        const externals = new Set<string>();

        while (queue.length > 0) {
            const rel = queue.shift() as string;
            for (const spec of importsOf(rel)) {
                const fp = resolveFirstParty(spec, rel);
                if (fp === null) {
                    // A bare specifier: an external, unless it is a builtin.
                    const root = spec.startsWith('@')
                        ? spec.split('/').slice(0, 2).join('/')
                        : spec.split('/')[0];
                    if (!NODE_BUILTINS.has(root.replace(/^node:/, ''))) externals.add(root);
                    continue;
                }
                if (!seen.has(fp)) { seen.add(fp); queue.push(fp); }
            }
        }

        const unexpected = [...externals].filter((e) => !ALLOWED_EXTERNALS.has(e)).sort();
        // The denominator, so a shrinking walk is visible rather than silently
        // passing.
        // eslint-disable-next-line no-console -- [zarnoborsa-fetch-externals] a reading, collected by denominator-summary.cjs
        console.log(
            `[zarnoborsa-fetch-externals] walked ${seen.size} first-party file(s), `
            + `found ${externals.size} external(s): ${[...externals].sort().join(', ') || '(none)'}`,
        );
        expect(seen.size).toBeGreaterThan(2);
        expect(unexpected).toEqual([]);
    });

    it('does NOT reach Prisma, which the fetch image does not have', () => {
        // Named explicitly as well as caught by the general rule above,
        // because this is the import somebody would add: the obvious way to
        // "simplify" the handoff is to write straight to the database from
        // the fetch process, and it would fail only at runtime in a container
        // that runs unattended.
        const seen = new Set<string>([ENTRY]);
        const queue = [ENTRY];
        let reachesPrisma = false;
        while (queue.length > 0) {
            const rel = queue.shift() as string;
            for (const spec of importsOf(rel)) {
                if (spec.includes('prisma') || spec.includes('@prisma')) reachesPrisma = true;
                const fp = resolveFirstParty(spec, rel);
                if (fp && !seen.has(fp)) { seen.add(fp); queue.push(fp); }
            }
        }
        expect(reachesPrisma).toBe(false);
    });
});

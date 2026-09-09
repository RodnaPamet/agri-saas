import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `scripts/worker.ts` and `scripts/scheduler.ts` ARE production: the compose
 * worker runs `node dist/scheduler.mjs && node dist/worker.mjs`. Yet
 * `tsconfig.json` excludes `scripts`, CI's typecheck passes no `-p` (so it uses
 * that root config), and nothing imports either file — every reference to them
 * is a string inside a guard test, so they cannot arrive transitively either.
 * They were typechecked by nothing at all (#806).
 *
 * `tsconfig.scripts.json` covers exactly them. This guard pins the three links
 * that make it real, because each one fails SILENTLY when severed: a config
 * that lists no entrypoints still exits 0, and a CI job that never invokes it
 * is still green.
 */

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// tsconfig.scripts.json is JSONC. Every comment in it is a whole-line comment,
// so a line-wise strip is sufficient and cannot eat a `//` inside a string.
const stripJsonc = (s: string) =>
    s
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

const ENTRYPOINTS = ['scripts/worker.ts', 'scripts/scheduler.ts'];

describe('the production entrypoints are typechecked by something', () => {
    it('the root config still excludes `scripts` — the reason this exists', () => {
        const rootCfg = JSON.parse(read('tsconfig.json'));
        // If this ever becomes false, the scoped program may be redundant —
        // check before deleting it, do not assume.
        expect(rootCfg.exclude).toContain('scripts');
    });

    it('tsconfig.scripts.json includes BOTH entrypoints', () => {
        const cfg = JSON.parse(stripJsonc(read('tsconfig.scripts.json')));
        // Positive control: a typo in the path would leave `include` non-empty
        // but cover nothing, and tsc would still exit 0.
        expect(cfg.include.length).toBeGreaterThan(0);
        for (const entry of ENTRYPOINTS) {
            expect(cfg.include).toContain(entry);
        }
    });

    it('it also pulls in the repo ambient globals, or it fails on EdgeRuntime', () => {
        const cfg = JSON.parse(stripJsonc(read('tsconfig.scripts.json')));
        // `src/lib/prisma.ts` branches on the `EdgeRuntime` global declared in
        // src/types/globals.d.ts. The root config picks it up incidentally via
        // its blanket `**/*.ts`; a scoped program must ask for it, or the
        // typecheck fails with two TS2304s unrelated to the scripts.
        expect(
            cfg.include.some((p: string) => p.startsWith('src/types/')),
        ).toBe(true);
    });

    it('`npm run typecheck` runs the scoped program too', () => {
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.scripts.typecheck).toContain('tsconfig.scripts.json');
    });

    it('CI invokes it as its own step', () => {
        const ci = read('.github/workflows/ci.yml');
        expect(ci).toContain('-p tsconfig.scripts.json --noEmit');
    });
});

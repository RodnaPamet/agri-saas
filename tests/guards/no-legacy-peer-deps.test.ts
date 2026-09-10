/**
 * No `--legacy-peer-deps` ratchet.
 *
 * `--legacy-peer-deps` disables npm's peer-dependency validation —
 * it installs whatever and silently masks incompatible package
 * combinations. It had been on every install step (Dockerfile, CI
 * workflows), hiding three genuine peer mismatches accumulated
 * through the Next 14 -> 16 / React 18 -> 19 migrations:
 *
 *   - `@visx/*@3.x` peers `react ^16 || ^17 || ^18` (the repo runs
 *     react 19);
 *   - `eslint-config-next@16` peers `eslint >=9` (the repo was on
 *     eslint 8 — now bumped to 9);
 *   - `next-auth@4` peers `next ^12 || ^13 || ^14` and `nodemailer
 *     ^6` (the repo runs next 16 / nodemailer 8).
 *
 * All three are now resolved explicitly: eslint bumped to 9, and a
 * targeted `overrides` block in package.json pins the visx and
 * next-auth peers to the real tree. The blanket flag is gone, so
 * peer resolution is strict again — a NEW incompatible dependency
 * now fails the install instead of being silently absorbed.
 *
 * This ratchet fails CI if the flag re-enters any install path, so
 * a future "make the install pass" shortcut cannot quietly restore
 * the blanket bypass.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Dockerfile(s), every CI workflow, and npm config — the install surface. */
function installPathFiles(): string[] {
    const files: string[] = [];
    for (const f of fs.readdirSync(ROOT)) {
        if (/^Dockerfile/.test(f)) files.push(f);
    }
    const wfDir = path.join(ROOT, '.github/workflows');
    if (fs.existsSync(wfDir)) {
        for (const f of fs.readdirSync(wfDir)) {
            if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
        }
    }
    return files;
}

/**
 * The install-surface files whose CONTENT carries the banned flag.
 *
 * `contents` is a parameter, defaulted to the real reader, so the positive
 * control below can hand it the real files with the defect spliced into the
 * real install command. The FILE LIST is never synthesised — a control that
 * fed its own list would keep passing with `installPathFiles()` gutted, which
 * is exactly the failure this pair of tests exists to catch.
 */
function offendingFiles(
    files: string[],
    contents: (rel: string) => string = read,
): string[] {
    return files.filter((rel) => contents(rel).includes('legacy-peer-deps'));
}

describe('no --legacy-peer-deps in install paths', () => {
    it('Dockerfiles and CI workflows never pass --legacy-peer-deps', () => {
        expect(offendingFiles(installPathFiles())).toEqual([]);
    });

    it('the install surface actually invokes `npm ci` (guard is not vacuous)', () => {
        // Same control shape as deterministic-install.test.ts. `toEqual([])`
        // above is satisfied by an empty file list, so the list has to be shown
        // to hold the real install surface: a Dockerfile, several workflows,
        // and at least one file that genuinely installs dependencies.
        const files = installPathFiles();
        expect(files.some((f) => /^Dockerfile/.test(f))).toBe(true);
        expect(
            files.filter((f) => f.startsWith('.github/workflows/')).length,
        ).toBeGreaterThan(1);
        expect(files.some((rel) => /\bnpm\s+ci\b/.test(read(rel)))).toBe(true);
    });

    it('the flag injected into the REAL install command is selected', () => {
        // Derived from the production tree: the file list the guard itself
        // returns, and the Dockerfile's own bytes with `--legacy-peer-deps`
        // appended to its actual `npm ci` line — the shape the regression
        // arrives as when someone is making a failing install pass.
        const files = installPathFiles();
        const target = files.find((f) => /^Dockerfile/.test(f));
        expect(target).toBeDefined();

        const lines = read(target as string).split('\n');
        const idx = lines.findIndex(
            (l) => /\bnpm\s+ci\b/.test(l) && !/^\s*#/.test(l),
        );
        expect(idx).toBeGreaterThanOrEqual(0);
        lines[idx] = `${lines[idx]} --legacy-peer-deps`;
        const mutated = lines.join('\n');

        expect(
            offendingFiles(files, (rel) => (rel === target ? mutated : read(rel))),
        ).toEqual([target]);
    });

    it('no .npmrc silently re-enables legacy-peer-deps', () => {
        const npmrc = path.join(ROOT, '.npmrc');
        if (!fs.existsSync(npmrc)) return; // absent — strict is the npm default
        expect(fs.readFileSync(npmrc, 'utf8')).not.toMatch(
            /legacy-peer-deps\s*=\s*true/,
        );
    });

    it('the masked peer conflicts stay resolved via explicit overrides', () => {
        // If these are deleted, strict `npm install` ERESOLVE-fails in
        // CI — but the ratchet states the contract up front.
        const pkg = JSON.parse(read('package.json'));
        expect(pkg.overrides).toBeDefined();
        expect(
            Object.keys(pkg.overrides).some((k) => k.startsWith('@visx/')),
        ).toBe(true);
        expect(pkg.overrides['next-auth']).toBeDefined();
    });
});

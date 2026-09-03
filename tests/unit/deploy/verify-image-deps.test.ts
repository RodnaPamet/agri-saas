/**
 * Executes `scripts/verify-image-deps.mjs` against real fixture trees.
 *
 * This is deliberately NOT a guard test. The script's whole purpose is to run
 * inside the built image and report what actually shipped; a test that read
 * its source text would reproduce the defect it exists to prevent — the
 * Dockerfile comment that claimed `npm prune` removed playwright was itself a
 * source-text assertion that nobody could falsify, and it was wrong for two
 * releases.
 *
 * The third case is the important one. "Banned package absent" and "I am
 * looking at the wrong directory" are the same observation, and the second
 * fails toward green. So the script asserts a positive control first, and
 * this file proves that control actually fires — otherwise a verifier
 * pointed at an empty path would certify every image forever.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/verify-image-deps.mjs');
const REQUIRED = ['next', 'react', 'react-dom', '@prisma/client'];

function makeTree(pkgs: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-image-deps-'));
    // Always create node_modules, even for the empty case: an EMPTY tree is
    // the realistic "verifier pointed at the wrong stage" shape, and it must
    // reach the positive control rather than short-circuit on a missing dir.
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    for (const p of pkgs) {
        const dir = path.join(root, 'node_modules', p);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: p }));
    }
    return root;
}

function run(root: string): { code: number; out: string } {
    try {
        const out = execFileSync('node', [SCRIPT, root], { encoding: 'utf8' });
        return { code: 0, out };
    } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
}

const trees: string[] = [];
afterAll(() => {
    for (const t of trees) fs.rmSync(t, { recursive: true, force: true });
});
function tree(pkgs: string[]): string {
    const t = makeTree(pkgs);
    trees.push(t);
    return t;
}

describe('verify-image-deps — what actually shipped in the image', () => {
    it('PASSES on a clean production tree', () => {
        const { code, out } = run(tree(REQUIRED));
        expect(out).toContain('control OK');
        expect(code).toBe(0);
    });

    it.each([
        ['playwright-core', 'playwright-core'],
        ['playwright', 'playwright'],
        ['@playwright/test', '@playwright/test'],
        ['@axe-core/playwright', '@axe-core/playwright'],
    ])('FAILS when %s survives into the runtime tree', (_label, pkg) => {
        const { code, out } = run(tree([...REQUIRED, pkg]));
        expect(code).toBe(1);
        expect(out).toContain('test tooling shipped in the runtime image');
        expect(out).toContain(pkg);
    });

    it('FAILS on an empty node_modules instead of certifying it — the positive control', () => {
        // The whole point: without this, a verifier resolving the wrong path
        // reports a clean image forever, and does so in the reassuring
        // direction. An absence is only evidence once the tree is proven real.
        const { code, out } = run(tree([]));
        expect(code).toBe(1);
        expect(out).toContain('positive control missing');
        expect(out).not.toContain('OK — none of');
    });

    it('FAILS when the tree is real but incomplete — control is per-package', () => {
        const { code, out } = run(tree(['next', 'react']));
        expect(code).toBe(1);
        expect(out).toContain('positive control missing');
        expect(out).toContain('@prisma/client');
    });

    it('FAILS when node_modules is missing entirely', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-image-deps-bare-'));
        trees.push(root);
        const { code, out } = run(root);
        expect(code).toBe(1);
        expect(out).toContain('no node_modules');
    });

    it('tolerates an empty @playwright scope directory but not a populated one', () => {
        const ok = tree(REQUIRED);
        fs.mkdirSync(path.join(ok, 'node_modules', '@playwright'), { recursive: true });
        expect(run(ok).code).toBe(0);

        const bad = tree(REQUIRED);
        fs.mkdirSync(path.join(bad, 'node_modules', '@playwright', 'leftover'), {
            recursive: true,
        });
        const r = run(bad);
        expect(r.code).toBe(1);
        expect(r.out).toContain('@playwright scope is non-empty');
    });
});

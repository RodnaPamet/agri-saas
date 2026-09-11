/**
 * No mutation may be left lying in the tree.
 *
 * `scripts/selector-teeth.mjs` writes a mutation into a real source file and
 * restores it afterwards. A SIGKILL — a CI timeout, a `pkill`, an OOM — skips
 * `finally`, leaving the file MUTATED and a `.teeth-bak` beside it. That
 * happened while the script was being written: a two-minute command timeout
 * killed it mid-run and left `no-legacy-peer-deps.test.ts` gutted in the
 * working tree. Nothing would have stopped that being committed.
 *
 * The script self-heals on its next run, and catches every signal it can. This
 * is the backstop for the one it cannot catch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        // A throw, not a silent return: a renamed root would empty this
        // selection and the assertion below would pass over nothing.
        throw new Error(`scan root does not exist: ${dir}`);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

describe('selector-teeth leaves no mutation behind', () => {
    const files = walk(path.join(ROOT, 'tests')).concat(walk(path.join(ROOT, 'scripts')));

    it('the scan actually read files — a control on the emptiness below', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('no .teeth-bak is left in the tree', () => {
        const stray = files.filter((f) => f.endsWith('.teeth-bak')).map((f) => path.relative(ROOT, f));
        expect({
            hint: 'a killed selector-teeth run left a MUTATED source file here; restore it from its .teeth-bak',
            stray,
        }).toEqual({
            hint: 'a killed selector-teeth run left a MUTATED source file here; restore it from its .teeth-bak',
            stray: [],
        });
    });
});

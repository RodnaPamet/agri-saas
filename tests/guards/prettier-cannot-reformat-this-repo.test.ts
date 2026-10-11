/**
 * The prettier guardrail stays in place (#1615).
 *
 * Prettier is not this repo's formatter and running it is destructive: there
 * is no config of any kind, prettier is not installed and not in the
 * lockfile, so `npx prettier` downloads the newest release and applies its
 * own defaults — 2-space indent, double quotes — over a tree written with
 * 4-space indent and single quotes.
 *
 * Every automated check passes while it does so. `tsc` is happy, eslint is
 * happy (it sets no stylistic rules at all), the generated OpenAPI artefact
 * comes out byte-identical, and the pre-commit hook looks only at secrets and
 * spec sync. On #1611 that turned an ~80-line spec edit into a 1560-line
 * commit which had to be reverted.
 *
 * `.prettierignore` with `*` is the gate. This test exists because deleting a
 * dotfile is easy and nothing else would notice — the guardrail would be gone
 * and the first symptom would be another unreviewable diff.
 *
 * What this does NOT assert: that prettier is absent from the tree. It is a
 * transitive dependency of nothing today, but `npx` fetches from the registry
 * regardless, so absence was never the protection.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../helpers/collect-files';

const IGNORE_FILE = path.join(REPO_ROOT, '.prettierignore');

describe('prettier cannot reformat this repo (#1615)', () => {
    it('.prettierignore exists', () => {
        expect(fs.existsSync(IGNORE_FILE)).toBe(true);
    });

    it('it ignores EVERYTHING, via a bare `*` pattern', () => {
        const lines = fs
            .readFileSync(IGNORE_FILE, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#'));

        // A bare `*` and nothing else. A narrower set of patterns would leave
        // whichever paths it omits reformattable, and the omission would be
        // invisible — the same shape as a gate narrowed until it always passes.
        expect(lines).toEqual(['*']);
    });

    it('no prettier CONFIG has appeared without the reformat it implies', () => {
        // A config plus this ignore file is incoherent: the config would say
        // "format like this" and the ignore file would say "format nothing".
        // Adopting prettier means deleting `.prettierignore` in the same
        // change that adds a config and lands the ~1000-file reformat (60% of
        // a 40-file sample differed from the house-style config, measured on
        // #1615). So if a config ever appears, this test is the prompt to
        // check that decision was made deliberately rather than by habit.
        const configs = [
            '.prettierrc',
            '.prettierrc.json',
            '.prettierrc.js',
            '.prettierrc.cjs',
            '.prettierrc.mjs',
            '.prettierrc.yaml',
            '.prettierrc.yml',
            '.prettierrc.toml',
            'prettier.config.js',
            'prettier.config.cjs',
            'prettier.config.mjs',
        ].filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
        expect(configs).toEqual([]);

        const pkg = JSON.parse(
            fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(pkg.prettier).toBeUndefined();
    });

    it('the file SAYS why, not just what', () => {
        // A bare `*` with no explanation invites deletion by someone who reads
        // it as leftover noise. The reason has to travel with the rule.
        const text = fs.readFileSync(IGNORE_FILE, 'utf8');
        expect(text).toMatch(/#1615/);
        expect(text).toMatch(/not this repo's formatter/i);
    });

    it('control: the `*` assertion REJECTS a narrowed ignore list', () => {
        // Teeth. The parse above is satisfied by any file whose only live line
        // is `*`, so prove it rejects the plausible weakening — someone
        // "fixing" this by listing directories instead.
        const narrowed = ['# comment', 'src/**', 'tests/**', '']
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#'));
        expect(narrowed).not.toEqual(['*']);
    });
});

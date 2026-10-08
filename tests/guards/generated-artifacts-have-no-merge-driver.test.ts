/**
 * Guard: no git merge driver regenerates a committed generated artifact
 * (#1401).
 *
 * This is a guard against a FIX, which is unusual, so the reason has to carry
 * it. The fix is appealing, was formally proposed, and is worse than doing
 * nothing — and the only way to find that out is to build it and measure, which
 * somebody will not do a second time.
 *
 * ## What was proposed
 *
 * `src/generated/*.json` is derived but committed, so every concurrent
 * spec-touching PR has to merge a file no human edits. #1401 proposed
 * `.gitattributes` plus a custom driver that regenerates instead of merging
 * text:
 *
 *     src/generated/openapi.json merge=openapi-regen
 *     git config merge.openapi-regen.driver 'npm run openapi:generate && cp … %A'
 *
 * ## What it actually does
 *
 * Measured on two branches, each changing a different route summary and
 * regenerating the spec:
 *
 *                                  spec has A   spec has B   == regeneration
 *     plain git text merge              1            1            YES
 *     with the regenerating driver      0            1            NO
 *
 * **A merge driver runs DURING the merge, and git has not yet written the
 * merged sources to the working tree.** Traced from inside the driver at the
 * moment of invocation:
 *
 *     INVOKED path=src/generated/openapi.json
 *       working-tree source has BRANCH-A: 0
 *
 * So it regenerates from the PRE-MERGE sources and silently drops a change,
 * while plain git's three-way text merge produces exactly the right file. The
 * driver converts a correct clean merge into a quiet contradiction between the
 * artifact and its own sources — the failure #1401 set out to prevent.
 *
 * No ordering trick fixes it from inside a driver: the driver's whole contract
 * is to produce one path's content, at a point where other paths are still
 * unresolved.
 *
 * ## What to do instead
 *
 * `scripts/merge-main-regenerating.sh` — merge FIRST, regenerate AFTERWARDS,
 * when the sources are final. The ordering is the design.
 *
 * ## The half-configured case fails loud, and that is worth keeping
 *
 * If `.gitattributes` names a driver whose `.driver` command is unset, git
 * refuses the merge outright:
 *
 *     fatal: custom merge driver generated-regen lacks command line.
 *
 * Measured. So the hazard is not a half-install — it is a WORKING install.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const ATTRS = join(REPO, '.gitattributes');

/** The committed derived artifacts, by the generator that owns each. */
const GENERATED = ['src/generated/openapi.json', 'src/generated/route-inventory.json'];

describe('no merge driver regenerates a committed artifact (#1401)', () => {
    it('the artifacts this is about still exist — the denominator', () => {
        // If these are renamed or stop being committed, the rule below is
        // vacuous and should be revisited rather than quietly passing.
        for (const f of GENERATED) {
            expect(existsSync(join(REPO, f))).toBe(true);
        }
    });

    it('.gitattributes does not route a generated artifact to a merge driver', () => {
        if (!existsSync(ATTRS)) return; // no .gitattributes at all — nothing to check

        const lines = readFileSync(ATTRS, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'));

        const offending = lines.filter((line) => {
            if (!/\bmerge=/.test(line)) return false;
            const pattern = line.split(/\s+/)[0];
            // Match the literal paths, and the globs that would capture them.
            return (
                GENERATED.includes(pattern) ||
                /^src\/generated\//.test(pattern) ||
                pattern === '*.json'
            );
        });

        if (offending.length) {
            throw new Error(
                `.gitattributes routes a generated artifact to a merge driver:\n\n` +
                    offending.map((l) => `    ${l}`).join('\n') +
                    `\n\nThis was built and MEASURED on #1401, and it is worse than doing ` +
                    `nothing. A merge driver runs DURING the merge, before git has written ` +
                    `the merged sources to the working tree, so it regenerates from ` +
                    `pre-merge inputs and silently drops the other branch's change — where ` +
                    `plain git's text merge produced exactly the right file:\n\n` +
                    `                                 spec has A   spec has B   == regen\n` +
                    `    plain git text merge              1            1          YES\n` +
                    `    with the regenerating driver      0            1          NO\n\n` +
                    `Use scripts/merge-main-regenerating.sh instead: it merges FIRST and ` +
                    `regenerates AFTERWARDS, when the sources are final. That ordering is ` +
                    `the whole point, and it is not available to a merge driver.\n\n` +
                    `If you are adding a driver for something that is NOT derived from ` +
                    `other tracked files, add that path to this guard's exception rather ` +
                    `than widening the pattern.`,
            );
        }
    });
});

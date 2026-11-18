/**
 * #3189 — a third-party action is referenced by commit SHA, never by tag.
 *
 * A tag can be moved by whoever controls the action's repository. Several of
 * these run inside the job holding `packages: write` whose output Watchtower
 * deploys unattended (`docker/build-push-action`, `docker/login-action`), so a
 * moved tag there is a route to the production image. A SHA cannot be moved.
 *
 * The version stays readable as a trailing comment (`@<sha> # v4`), which is
 * also the form Dependabot's `github-actions` ecosystem (`.github/dependabot.yml`)
 * keeps current, so pinning costs no freshness.
 *
 * GitHub's own namespaces (`actions/*`, `github/*`) and repo-local actions
 * (`./…`) are exempt: the first two are published by the platform that runs
 * the workflow, so trusting their tags trusts nothing new, and a local action
 * is reviewed in this repository.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectTrackedFiles } from '../helpers/collect-files';

const FIRST_PARTY = /^(actions|github)\//;
const SHA_PIN = /^[^@\s]+@[0-9a-f]{40}(\s+#\s*\S+)?$/;

interface Ref {
    file: string;
    line: number;
    ref: string;
}

/** Every `uses:` reference in a source, with its line. Exported shape kept
 *  local so the detector can be proved against crafted text below. */
function usesRefs(file: string, src: string): Ref[] {
    const out: Ref[] = [];
    src.split('\n').forEach((text, i) => {
        const m = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/.exec(text);
        if (!m) return;
        // Strip surrounding quotes, keep a trailing version comment.
        const ref = m[1].replace(/^['"]|['"](?=\s|$)/g, '');
        out.push({ file, line: i + 1, ref });
    });
    return out;
}

function unpinned(refs: Ref[]): Ref[] {
    return refs.filter(({ ref }) => {
        if (ref.startsWith('./')) return false;
        if (FIRST_PARTY.test(ref)) return false;
        return !SHA_PIN.test(ref);
    });
}

const files = collectTrackedFiles({
    roots: ['.github/workflows', '.github/actions'],
    extensions: ['.yml', '.yaml'],
});

const allRefs = files.flatMap((abs) =>
    usesRefs(path.relative(process.cwd(), abs), fs.readFileSync(abs, 'utf8')),
);
const thirdParty = allRefs.filter(
    ({ ref }) => !ref.startsWith('./') && !FIRST_PARTY.test(ref),
);

describe('third-party GitHub Actions are pinned to a commit SHA (#3189)', () => {
    it('reports its population', () => {
        console.log(
            `[actions-sha-pinned] ${files.length} file(s), ${allRefs.length} uses, ` +
                `${thirdParty.length} third-party`,
        );
        // Floor, so a selector that stopped matching fails rather than
        // passing over nothing. The repo held 22 third-party refs at #3189.
        expect(thirdParty.length).toBeGreaterThanOrEqual(10);
    });

    it('every third-party reference is a full SHA', () => {
        const bad = unpinned(allRefs).map((r) => `${r.file}:${r.line} ${r.ref}`);
        expect(bad).toEqual([]);
    });

    describe('the detector (positive controls)', () => {
        const crafted = (body: string) => unpinned(usesRefs('x.yml', body));

        it('flags a tag reference', () => {
            expect(crafted('      - uses: docker/login-action@v4')).toHaveLength(1);
        });

        it('flags a branch reference and a short SHA', () => {
            expect(crafted('uses: dorny/paths-filter@main')).toHaveLength(1);
            expect(crafted('uses: dorny/paths-filter@ceb8a2b')).toHaveLength(1);
        });

        it('accepts a full SHA with and without a version comment', () => {
            const sha = 'ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d';
            expect(crafted(`uses: dorny/paths-filter@${sha} # v4`)).toEqual([]);
            expect(crafted(`uses: "dorny/paths-filter@${sha}"`)).toEqual([]);
        });

        it('exempts first-party and local actions', () => {
            expect(crafted('uses: actions/checkout@v7')).toEqual([]);
            expect(crafted('uses: github/codeql-action/init@v4.39.1')).toEqual([]);
            expect(crafted('uses: ./.github/actions/setup-node-prisma')).toEqual([]);
        });
    });
});

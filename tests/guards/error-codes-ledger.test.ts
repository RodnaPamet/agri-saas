/**
 * The per-route error-code ledger is current, and nothing retired silently.
 *
 * The server half of #1662. `scripts/generate-error-codes.ts` is the generator
 * and carries the full reasoning; this fails when the committed artifact and
 * the tree disagree.
 *
 * ## Why a ledger and not just a regenerate-on-build
 *
 * The client's half of the control (agrent-ios) asserts it has copy for every
 * code on every route its build touches. That only works if a code LEAVING is
 * visible: if the generator retired codes on its own, a removal would land as
 * a green diff and the client would keep translations for codes that no longer
 * exist while losing the signal for one that silently changed. Same reasoning
 * as `route-inventory-ledger`, and the same remedy — the generator adds and
 * never retires, and this test is what makes a disappearance cost a sentence.
 *
 * ## What it does NOT check
 *
 * That the codes are right. They are an over-approximation by construction —
 * every code reachable through a route's transitive local imports — so this
 * test cannot tell an over-credited code from a correct one. It checks that
 * the artifact matches what the generator produces from the current tree, and
 * that the population is real.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const LEDGER = join(REPO, 'src/generated/error-codes.json');

interface Entry {
    path: string;
    codes: string[];
    retiredCodes?: Array<{ code: string; reason: string }>;
}

const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as {
    _README: string[];
    routes: Entry[];
};

describe('the per-route error-code ledger (#1662)', () => {
    it('ranges over a real population — the denominator', () => {
        // Without this, every assertion below is satisfied by an empty or
        // truncated artifact, which is what a broken walker produces and what
        // would read as "nothing to translate" on the client.
        expect(ledger.routes.length).toBeGreaterThan(300);
        const distinct = new Set(ledger.routes.flatMap((r) => r.codes));
        expect(distinct.size).toBeGreaterThan(60);
    });

    it('is CURRENT — regenerating changes nothing', () => {
        // The generator is append-only, so a stale artifact shows up as a diff
        // only in the ADD direction. That is the direction that matters: a new
        // code the client has never been told about.
        //
        // Generated to a TEMP path, not over the committed file. The first
        // version of this test ran the generator plainly and compared the
        // ledger to itself afterwards — which rewrote a tracked file as a side
        // effect of asking a question about it, and made the failure message
        // tell the reader to run the generator it had already run.
        const before = readFileSync(LEDGER, 'utf8');
        const tmp = join(mkdtempSync(join(tmpdir(), 'error-codes-')), 'candidate.json');
        execFileSync('npx', ['tsx', 'scripts/generate-error-codes.ts', '--out', tmp], {
            cwd: REPO,
            stdio: 'pipe',
        });
        const after = readFileSync(tmp, 'utf8');
        if (before !== after) {
            throw new Error(
                [
                    'src/generated/error-codes.json is out of date.',
                    '',
                    'Run `npm run errors:inventory` and commit the result. The client',
                    '(agrent-ios) asserts it has copy for every code listed here, so a',
                    'code added to the server and not to this file is a code that reaches',
                    'a Bulgarian farmer in English — which is the regression #1645 nearly',
                    'shipped and the reason this ledger exists.',
                ].join('\n'),
            );
        }
    });

    it('every retired code says what happened to it', () => {
        // The whole point of append-only: a disappearance costs a sentence.
        const bad: string[] = [];
        for (const r of ledger.routes) {
            for (const t of r.retiredCodes ?? []) {
                if (!t.reason || t.reason.trim().length < 10) {
                    bad.push(`${r.path} → ${t.code}: ${JSON.stringify(t.reason)}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it('carries the over-approximation warning where a client will read it', () => {
        // The artifact travels to another repository. A caveat that lives only
        // in this repo's docblock is a caveat the reader never sees, and the
        // consequence is someone treating the list as "what this route
        // returns" rather than "what it might".
        const readme = ledger._README.join(' ');
        expect(readme).toMatch(/OVER-APPROXIMATION/);
        expect(readme).toMatch(/APPEND-ONLY/);
        // An empty list means "not this envelope", not "cannot fail".
        expect(readme).toMatch(/not read \[\] as/);
    });

    it('no entry lists a code twice, and all are sorted', () => {
        for (const r of ledger.routes) {
            expect(r.codes).toEqual([...new Set(r.codes)].sort());
        }
    });
});

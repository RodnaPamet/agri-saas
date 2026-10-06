/**
 * `mammoth` must not come back without a consumer, and `source-map-js` must
 * not drift back below its patched floor.
 *
 * ─── What #1315 actually was ────────────────────────────────────────
 *
 * The `Security` gate went red on every branch at once, with no PR having
 * touched a dependency. `npm audit` is a live registry query, so the same
 * lockfile audits differently on different days: two advisories entered npm's
 * feed after `main`'s last green run.
 *
 *   GHSA-68fv-2mgg-jv7q  high      source-map-js  event-loop DoS
 *   GHSA-hp3w-g68c-fv3c  moderate  sprintf-js     unbounded-allocation DoS
 *
 * Neither needed an exemption in the end, which is the point of this guard.
 *
 * ─── source-map-js: a real fix existed ──────────────────────────────
 *
 * Vulnerable range `>=1.0.0 <1.2.2`; the tree held 1.2.1 and **1.2.2 was
 * published**. So this is an `overrides` floor, not a reachability argument.
 * The floor is the whole fix, and dropping it silently returns the tree to a
 * HIGH advisory — hence the assertion below.
 *
 * ─── sprintf-js: removal beat arguing it unreachable ────────────────
 *
 * `sprintf-js` has NO patched version — `<=1.1.3` is vulnerable and 1.1.3 is
 * latest — so an upgrade was never available, and `npm audit`'s suggested fix
 * was a semver-MAJOR *downgrade* of `ioredis-mock` that did not even touch the
 * path that mattered.
 *
 * The gate audits production only (`npm audit --omit=dev`), and in the
 * production tree `sprintf-js` had exactly ONE node:
 * `node_modules/mammoth/node_modules/sprintf-js`, via `mammoth -> argparse`.
 * The `ioredis-mock -> fengari` and `ts-jest -> … -> argparse` paths are
 * devDependencies and were never in scope.
 *
 * And `mammoth` was dead. It arrived in #948 for SharePoint DOCX policy sync;
 * its only two consumers (`integrations/providers/sharepoint/docx.ts`,
 * `usecases/policy-sharepoint-sync.ts`) were deleted by the GRC teardown
 * (#547). It was imported nowhere in the repo — only `package.json` named it.
 *
 * So it was dropped rather than exempted, per the rule
 * `scripts/audit-exemptions.mjs` states in its own comments: **"Removing a
 * vulnerable package beats arguing it unreachable."** That is strictly
 * stronger than an exemption — an absent parser cannot be reached by any code
 * path — and strictly more fragile to silent reversal, which is why this file
 * exists. Re-adding `mammoth` for a .docx feature would quietly reintroduce a
 * moderate advisory, and the temptation then is to write an exemption rather
 * than re-argue the case.
 *
 * ─── If you need DOCX again ─────────────────────────────────────────
 *
 * Fine — but do it deliberately: add the dependency AND its consumer in the
 * same PR, re-run `node scripts/audit-exemptions.mjs`, and either find a
 * `sprintf-js` that is finally patched or write the reachability argument
 * (note the three `argparse` call sites pass LITERAL format strings, so an
 * attacker controls the argument, not the precision specifier). Then update
 * this guard with what you concluded. Do not delete it silently.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function pkg(): {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, unknown>;
} {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

/** Every tracked source file — the population a "nothing imports it" claim ranges over. */
function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) return;
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const r = path.join(rel, e.name);
            if (e.isDirectory()) walk(r);
            else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(r);
        }
    };
    for (const d of ['src', 'scripts', 'tests', 'prisma']) walk(d);
    return out;
}

describe('#1315 — the two advisories stay fixed', () => {
    it('mammoth is not a dependency', () => {
        const p = pkg();
        expect(p.dependencies ?? {}).not.toHaveProperty('mammoth');
        expect(p.devDependencies ?? {}).not.toHaveProperty('mammoth');
    });

    it('and nothing imports it — the claim that made removal safe', () => {
        // Asserted over a DERIVED population rather than asserted in prose, and
        // the floor below is what stops an empty walk reading as "clean".
        const files = sourceFiles();
        expect(files.length).toBeGreaterThan(500);

        const importers = files.filter((f) =>
            /\bmammoth\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
        );
        expect(importers.filter((f) => f !== __filename.replace(ROOT + path.sep, ''))).toEqual([]);
    });

    it('source-map-js is pinned at or above the patched 1.2.2', () => {
        // Vulnerable range is `>=1.0.0 <1.2.2`, so the floor IS the fix.
        const ov = (pkg().overrides ?? {}) as Record<string, unknown>;
        const pin = ov['source-map-js'];
        expect(typeof pin).toBe('string');
        const m = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(String(pin));
        expect(m).not.toBeNull();
        const [maj, min, pat] = m!.slice(1).map(Number);
        expect(maj).toBe(1);
        expect(min * 1000 + pat).toBeGreaterThanOrEqual(2 * 1000 + 2);
    });

    it('the lockfile actually resolved it — package.json alone proves nothing', () => {
        // An override that the tree never applied is a declaration, not a fix.
        const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
        const versions = Object.entries(lock.packages as Record<string, { version?: string }>)
            .filter(([k]) => k.endsWith('node_modules/source-map-js'))
            .map(([, v]) => v.version);
        expect(versions.length).toBeGreaterThan(0);
        for (const v of versions) {
            const [maj, min, pat] = String(v).split('.').map(Number);
            expect(maj * 1e6 + min * 1e3 + pat).toBeGreaterThanOrEqual(1e6 + 2 * 1e3 + 2);
        }
    });

    it('no sprintf-js reaches the PRODUCTION tree', () => {
        // The gate runs `--omit=dev`, so dev paths are out of scope by design.
        // This asserts the one production node (mammoth's) is gone, without
        // claiming the dev copies are absent — they are not, and need not be.
        const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
        const prodSprintf = Object.entries(
            lock.packages as Record<string, { dev?: boolean }>,
        ).filter(([k, v]) => k.endsWith('node_modules/sprintf-js') && !v.dev);
        expect(prodSprintf.map(([k]) => k)).toEqual([]);
    });
});

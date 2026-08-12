/**
 * k6 load scripts may only drive routes that still exist.
 *
 * `tests/load/*.js` builds every request as
 * `${cfg.baseUrl}/api/t/${cfg.tenant}/<path>`. Those are plain strings:
 * no import resolves them, no type checks them, and the Jest suite never
 * loads these files at all. The only thing that executes them is the
 * `Load Smoke (k6)` CI job — which is deliberately **push-to-main only**
 * ("a k6 smoke check is redundant per-PR; the merge to main exercises
 * it", ci.yml). So a script pointed at a deleted route is invisible on
 * the PR and red only after merge, on main.
 *
 * That is not hypothetical. It has happened twice:
 *
 *   • The Control → Practice rename moved `/controls` to `/practices`
 *     and `tests/load/` was outside the sweep. Every check on the PR was
 *     green; main went red on
 *     `thresholds on metrics 'http_req_failed{op:create_control}' have
 *     been crossed` — a 404 storm, after the merge had already shipped.
 *   • Earlier, the risk-register uproot deleted `/risks` and left
 *     `lists.js` driving it. That one never went red at all, because
 *     `lists.js` is not in the smoke job's script list — it belongs to
 *     the on-demand `load-test.yml` workflow, so it simply sat broken.
 *
 * This guard is the cheap PR-time check the smoke job cannot be: it
 * resolves every `${base}/…` path against `src/app/api/t/[tenantSlug]/`
 * and fails if the route directory is gone. Structural by necessity —
 * running k6 needs a built app and a database, which is exactly why the
 * real job was moved off PRs in the first place.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const LOAD_DIR = path.join(ROOT, 'tests/load');
const API_ROOT = path.join(ROOT, 'src/app/api/t/[tenantSlug]');

/** Load scripts, excluding the vendored k6 summary helper. */
function loadScripts(): string[] {
    return fs
        .readdirSync(LOAD_DIR)
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join(LOAD_DIR, f));
}

interface Ref {
    file: string;
    line: number;
    /** First static path segment, e.g. `practices` from `/practices?x=1`. */
    segment: string;
    raw: string;
}

/**
 * Every `${base}/<path>` occurrence, reduced to its first static
 * segment. Deeper segments are usually interpolated ids (`${id}`), which
 * map to `[param]` directories — resolving those adds failure modes
 * without adding signal, so the first segment is where the check bites.
 */
function parseRefs(): Ref[] {
    const out: Ref[] = [];
    for (const file of loadScripts()) {
        const rel = path.relative(ROOT, file);
        fs.readFileSync(file, 'utf8')
            .split('\n')
            .forEach((line, i) => {
                for (const m of line.matchAll(/\$\{base\}\/([A-Za-z0-9_-]+)/g)) {
                    out.push({
                        file: rel,
                        line: i + 1,
                        segment: m[1],
                        raw: m[0],
                    });
                }
            });
    }
    return out;
}

const REFS = parseRefs();

describe('k6 load scripts drive routes that exist', () => {
    it('parses a real population of route references', () => {
        // If the `${base}/…` convention ever changes, this guard would
        // silently check nothing. Fail loudly instead.
        expect(REFS.length).toBeGreaterThan(3);
        expect(fs.existsSync(API_ROOT)).toBe(true);
    });

    it('every referenced route segment resolves to an API directory', () => {
        const seen = new Map<string, Ref>();
        for (const r of REFS) if (!seen.has(r.segment)) seen.set(r.segment, r);

        const missing = [...seen.values()].filter(
            (r) => !fs.existsSync(path.join(API_ROOT, r.segment)),
        );

        if (missing.length > 0) {
            throw new Error(
                `${missing.length} load-script route(s) no longer exist under ` +
                    `src/app/api/t/[tenantSlug]/. k6 would 404 and breach its ` +
                    `error-rate threshold — but only on the push-to-main run, ` +
                    `after the change has already shipped:\n` +
                    missing
                        .map((r) => `  ${r.file}:${r.line}  ${r.raw}`)
                        .join('\n'),
            );
        }
        expect(missing).toEqual([]);
    });

    it('the detector resolves a real route and rejects a deleted one', () => {
        // Mutation proof. `evidence` is live; `controls`, `risks` and
        // `practices` are deleted -- the first two caused the incidents
        // above, the third went with the GRC teardown, which is exactly the
        // class of change this guard exists to catch.
        expect(fs.existsSync(path.join(API_ROOT, 'evidence'))).toBe(true);
        expect(fs.existsSync(path.join(API_ROOT, 'controls'))).toBe(false);
        expect(fs.existsSync(path.join(API_ROOT, 'risks'))).toBe(false);
        expect(fs.existsSync(path.join(API_ROOT, 'practices'))).toBe(false);
    });
});

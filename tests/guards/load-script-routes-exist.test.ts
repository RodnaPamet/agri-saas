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

/**
 * ── person-scoped routes (#1999) ──
 *
 * `realtime-streams.js` is the first load script to drive a path that is not
 * tenant-scoped: `/api/me/stream` has no `/t/<slug>/` segment, because a stream
 * belongs to a PERSON. So it writes `${BASE}/api/me/stream` rather than
 * `${base}/<segment>`, and the parser above — which resolves against
 * `src/app/api/t/[tenantSlug]/` — could not have seen it either way: matched,
 * it would have looked for a `t/[tenantSlug]/api` directory and failed.
 *
 * Which would have left this script outside the only check that catches a
 * renamed route before the run, and this file's docblock is the record of what
 * that costs. Hence a second pattern, resolving the full path under
 * `src/app/api/` instead.
 */
const APP_DIR = path.join(ROOT, 'src/app');

interface AbsRef {
    file: string;
    line: number;
    /** Path after the origin, e.g. `api/me/stream`. */
    route: string;
}

function parseAbsoluteRefs(): AbsRef[] {
    const out: AbsRef[] = [];
    for (const file of loadScripts()) {
        const rel = path.relative(ROOT, file);
        fs.readFileSync(file, 'utf8')
            .split('\n')
            .forEach((line, i) => {
                for (const m of line.matchAll(/\$\{BASE\}\/(api\/[A-Za-z0-9_\-/]+)/g)) {
                    out.push({ file: rel, line: i + 1, route: m[1] });
                }
            });
    }
    return out;
}

/**
 * Does `src/app/<route>` resolve to a handler, allowing for App Router
 * segment syntax?
 *
 * The naive `existsSync(join(APP_DIR, route))` answers NO for two of the three
 * paths these scripts actually use, and both for the same reason — the
 * directory name is not the URL segment:
 *
 *   - `api/auth/csrf` and `api/auth/callback/credentials` are served by
 *     `api/auth/[...nextauth]`, a CATCH-ALL that swallows everything below it.
 *     No `csrf` directory exists and none should.
 *   - A single dynamic segment (`[tenantSlug]`, `[id]`) matches one URL segment
 *     the same way.
 *
 * So: descend literally where the directory exists, stop happy at a catch-all,
 * and otherwise accept a single dynamic segment. A level with several `[x]`
 * siblings is ambiguous and treated as unresolved — there is no such level on
 * any path these scripts drive, and guessing would be the failure mode this
 * guard exists to prevent.
 */
function resolveAppRoute(route: string): boolean {
    let dir = APP_DIR;
    const segments = route.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
        const literal = path.join(dir, segments[i]);
        if (fs.existsSync(literal) && fs.statSync(literal).isDirectory()) {
            dir = literal;
            continue;
        }
        let siblings: string[];
        try {
            siblings = fs.readdirSync(dir);
        } catch {
            return false;
        }
        // `[...slug]` / `[[...slug]]` — matches this segment and every one
        // after it, so the walk is done.
        if (siblings.some((d) => d.startsWith('[...') || d.startsWith('[[...'))) return true;
        const dynamic = siblings.filter((d) => /^\[[^.].*\]$/.test(d));
        if (dynamic.length !== 1) return false;
        dir = path.join(dir, dynamic[0]);
    }
    // A directory is only a route if it actually has a handler.
    return ['route.ts', 'route.tsx', 'route.js'].some((f) => fs.existsSync(path.join(dir, f)));
}

const ABS_REFS = parseAbsoluteRefs();

describe('person-scoped load-script routes exist', () => {
    it('finds the population it is meant to check', () => {
        // `realtime-streams.js` drives three: csrf, the credentials callback
        // and the stream itself. An empty selection would pass the assertion
        // below for ever.
        expect(ABS_REFS.length).toBeGreaterThanOrEqual(3);
        expect(fs.existsSync(APP_DIR)).toBe(true);
    });

    it('every absolute route resolves to a handler under src/app', () => {
        const missing = ABS_REFS.filter((r) => !resolveAppRoute(r.route));
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} load-script route(s) do not resolve under src/app/:\n` +
                    missing.map((r) => `  ${r.file}:${r.line}  /${r.route}`).join('\n'),
            );
        }
        expect(missing).toEqual([]);
    });

    it('the resolver accepts live routes and rejects plausible renames', () => {
        // Mutation proof on the resolver, one case per branch it has.
        expect(resolveAppRoute('api/me/stream')).toBe(true); // literal walk
        expect(resolveAppRoute('api/auth/csrf')).toBe(true); // catch-all
        expect(resolveAppRoute('api/auth/callback/credentials')).toBe(true); // catch-all, deeper
        expect(resolveAppRoute('api/me/streams')).toBe(false); // the rename
        expect(resolveAppRoute('api/me')).toBe(false); // a directory with no handler
        expect(resolveAppRoute('api/nothing/here')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
//  …and every script is actually INVOKED by a workflow (P3.10)
// ═══════════════════════════════════════════════════════════════════
//
//  The half this file was missing. The docblock above already records the
//  precedent: `lists.js` "is not in the smoke job's script list … so it
//  simply sat broken" — a script pointed at a deleted route, never executed,
//  never red. Checking that its ROUTES exist does not help if nothing runs it.
//
//  So: every `tests/load/*.js` must be named by `ci.yml` (the push-to-main
//  smoke job) or by `load-test.yml` (the on-demand workflow), or carry a
//  written exemption. A k6 script nobody runs is a test that cannot fail,
//  which is the most expensive kind to keep.

describe('every k6 load script is invoked by a workflow', () => {
    const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/load-test.yml'];

    /** Scripts deliberately not wired to any workflow, each with a reason. */
    const NOT_INVOKED: Record<string, string> = {
        // Empty today. An entry here is a claim that a script is worth
        // keeping while never running, which is a hard case to make.
    };

    const scripts = fs
        .readdirSync(LOAD_DIR)
        .filter((f) => f.endsWith('.js'))
        .sort();

    const invocations = WORKFLOWS.filter((w) => fs.existsSync(path.join(ROOT, w)))
        .map((w) => fs.readFileSync(path.join(ROOT, w), 'utf8'))
        .join('\n');

    it('finds a real population of scripts and a real population of workflows', () => {
        // An empty selection on either side passes the assertion below.
        expect(scripts.length).toBeGreaterThanOrEqual(5);
        expect(invocations.length).toBeGreaterThan(1000);
    });

    it('each script is named by ci.yml or load-test.yml', () => {
        const orphans = scripts.filter(
            (f) => !(f in NOT_INVOKED) && !invocations.includes(`tests/load/${f}`),
        );
        if (orphans.length > 0) {
            throw new Error(
                `${orphans.length} k6 load script(s) are invoked by no workflow:\n` +
                    orphans.map((f) => `  tests/load/${f}`).join('\n') +
                    `\n\nAdd a \`k6 run\` step to .github/workflows/ci.yml (push-to-main\n` +
                    `smoke) or load-test.yml (on-demand), or add an entry to\n` +
                    `NOT_INVOKED in this file with a written reason. A script nothing\n` +
                    `runs cannot fail, and \`lists.js\` sat broken for exactly this\n` +
                    `reason — see this file's docblock.`,
            );
        }
        expect(orphans).toEqual([]);
    });

    it('CONTROL: the detector would notice an orphan', () => {
        // Without this, a bug in the `includes` check would make the
        // assertion above pass for every script forever.
        expect(invocations.includes('tests/load/definitely-not-a-real-script.js')).toBe(false);
        // And it DOES find a known-wired one, so the needle is not inert.
        expect(invocations.includes('tests/load/auth.js')).toBe(true);
    });

    it('every exemption names a script that exists', () => {
        // A stale exemption silently stops exempting — or worse, hides that
        // the real script is an orphan.
        for (const f of Object.keys(NOT_INVOKED)) {
            expect(scripts).toContain(f);
            expect(NOT_INVOKED[f].length).toBeGreaterThan(40);
        }
    });
});

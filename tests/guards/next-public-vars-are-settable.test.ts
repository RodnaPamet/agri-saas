/**
 * Every `NEXT_PUBLIC_*` the app reads can actually be SET — #2009.
 *
 * ## The failure this exists for is not "unset", it is "unsettable"
 *
 * `next build` inlines `NEXT_PUBLIC_*` into the client bundle, so a variable
 * that reaches no Dockerfile `ARG` and no `ghcr-publish.yml` build-arg is baked
 * `undefined` into **every image ever built**. Setting it on the VM, in
 * `/opt/agrent/.env`, or in `deploy/env.prod.example` does nothing whatsoever.
 *
 * #1982 is the worked example: `NEXT_PUBLIC_NOTIFICATIONS_SSE` gated the
 * notifications stream from the client, reached no ARG, and the channel was
 * therefore **unreachable rather than off** — for months, with a comment above
 * it claiming "future opt-in is one env-var flip". Measured in production:
 * zero requests to `/api/notifications/stream` with a live tab.
 *
 * Found again on 2026-10-23 while building this guard, and this one was live:
 * `SENTRY_DSN` is PRESENT on the VM, so server-side error reporting works,
 * while `NEXT_PUBLIC_SENTRY_DSN` reached no ARG. Browser errors went nowhere
 * and no amount of configuration could change it. `NEXT_PUBLIC_PRIVACY_URL`
 * and `NEXT_PUBLIC_SENTRY_RELEASE` were in the same state.
 *
 * ## Why a guard can answer this one, when it cannot answer the sibling
 *
 * #2009 lists three checks. The flag-row check needs PRODUCTION (a missing
 * `FeatureFlag` row is invisible to the repo) and the reachability check needs
 * a deployed URL. This one is entirely a repo-internal comparison — the code
 * that reads the variable and the build that inlines it are both committed
 * here — which is why it is the half that fits in CI.
 *
 * ## Comments are stripped, and that is load-bearing
 *
 * Three `NEXT_PUBLIC_*` names appear in this tree ONLY inside prose recording
 * their own removal: `NEXT_PUBLIC_NOTIFICATIONS_SSE` (replaced by a flag row in
 * #1982), `NEXT_PUBLIC_VAPID_PUBLIC_KEY` ("was HERE and is deliberately gone"),
 * and `NEXT_PUBLIC_TURNSTILE_SITEKEY` (served by an API route instead). A
 * text-matching population would demand ARGs for all three and the honest fix
 * would be three exemptions explaining that the variables do not exist — a
 * guard arguing with its own documentation. `a-scar-is-not-a-wound`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Block and line comments removed, so prose cannot create a requirement. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const p = path.join(dir, entry);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(p);
    }
    return out;
}

const SRC_FILES = walk(path.join(ROOT, 'src'));

/**
 * Declared in the typed env — the keys `src/env.ts` promises the app.
 * Taken from the `runtimeEnv` map and the client schema alike by matching the
 * whole file after comment-stripping, because either half alone misses one.
 */
const ENV_TS = stripComments(readFileSync(path.join(ROOT, 'src/env.ts'), 'utf8'));
const DECLARED = new Set(ENV_TS.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? []);

/**
 * Read directly off `process.env`, bypassing the typed env. CLAUDE.md forbids
 * this ("add the var to `env.ts` first") and it happens anyway, so the
 * population covers it rather than trusting the rule.
 */
const RAW_READS = new Map<string, string[]>();
for (const file of SRC_FILES) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
        RAW_READS.set(m[1], [...(RAW_READS.get(m[1]) ?? []), path.relative(ROOT, file)]);
    }
}

const POPULATION = [...new Set([...DECLARED, ...RAW_READS.keys()])].sort();

const DOCKERFILE = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const PUBLISH = readFileSync(path.join(ROOT, '.github/workflows/ghcr-publish.yml'), 'utf8');

const dockerArgs = new Set(
    [...DOCKERFILE.matchAll(/^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)/gm)].map((m) => m[1]),
);
/** Build-args in the PUBLISH workflow — the build that becomes production. */
const buildArgs = new Set(
    [...PUBLISH.matchAll(/^\s+(NEXT_PUBLIC_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

/**
 * Variables that must NOT be settable in a production image, each with the
 * reason. Shrink-only: an entry here is a claim that the variable is a
 * test-harness switch, not configuration.
 */
const DELIBERATELY_CI_ONLY: Record<string, string> = {
    NEXT_PUBLIC_MAP_BASEMAP_FIXTURE:
        'Makes resolveBasemapStyle return an inline sources-free style so the E2E '
        + 'suite is network-hermetic (#764). CLAUDE.md: it is checked FIRST precisely '
        + 'so a runner carrying a MapTiler key stays hermetic — shipping it in an '
        + 'image would serve production a blank basemap.',
    NEXT_PUBLIC_TEST_MODE:
        'Suppresses the PWA install prompt and the SWR devtools during E2E. Set on '
        + "ci.yml's build step only; an image carrying it would hide the install "
        + 'prompt from every real visitor.',
};

describe('every NEXT_PUBLIC_* the app reads is settable at build time (#2009)', () => {
    it('[next-public] ranges over a real population', () => {
        console.log(
            `[next-public] ${POPULATION.length} variable(s): `
                + `${DECLARED.size} declared in env.ts, ${RAW_READS.size} read raw; `
                + `${dockerArgs.size} Dockerfile ARG(s), ${buildArgs.size} publish build-arg(s), `
                + `${Object.keys(DELIBERATELY_CI_ONLY).length} CI-only`,
        );
        // A derivation that stopped matching would make every case below pass
        // over nothing — the shape this issue is about, one level up.
        expect(POPULATION.length).toBeGreaterThanOrEqual(6);
        expect(dockerArgs.size).toBeGreaterThanOrEqual(2);
        expect(buildArgs.size).toBeGreaterThanOrEqual(2);
    });

    it.each(POPULATION.map((v) => [v] as const))('%s is settable, or CI-only with a reason', (v) => {
        if (v in DELIBERATELY_CI_ONLY) {
            expect({ v, inDockerfile: dockerArgs.has(v), inPublish: buildArgs.has(v) }).toEqual({
                v,
                inDockerfile: false,
                inPublish: false,
            });
            return;
        }
        // Both halves, because either alone is useless: an ARG with no
        // build-arg is never supplied, and a build-arg with no ARG is
        // silently discarded by docker build.
        expect({ v, inDockerfile: dockerArgs.has(v), inPublish: buildArgs.has(v) }).toEqual({
            v,
            inDockerfile: true,
            inPublish: true,
        });
    });

    it('every CI-only entry carries a reason and still names a live variable', () => {
        for (const [v, why] of Object.entries(DELIBERATELY_CI_ONLY)) {
            expect({ v, long: why.length > 80 }).toEqual({ v, long: true });
            // A stale entry keeps a deleted variable's name pre-approved for
            // whatever is created there next — the #1285 defect.
            expect({ v, inPopulation: POPULATION.includes(v) }).toEqual({ v, inPopulation: true });
        }
    });

    it('CONTROL: a variable that reaches no ARG is detected', () => {
        // The assertions above are satisfied by a parser that finds every
        // variable in the Dockerfile, including ones that are not there.
        expect(dockerArgs.has('NEXT_PUBLIC_DEFINITELY_NOT_DECLARED')).toBe(false);
        expect(buildArgs.has('NEXT_PUBLIC_DEFINITELY_NOT_DECLARED')).toBe(false);
        // And the parsers must find the ones that ARE, or everything above is
        // vacuously failing-open on an empty set.
        expect(dockerArgs.has('NEXT_PUBLIC_MAPTILER_KEY')).toBe(true);
        expect(buildArgs.has('NEXT_PUBLIC_MAPTILER_KEY')).toBe(true);
    });

    it('CONTROL: a name appearing ONLY in prose is not in the population', () => {
        // The three scars. If comment-stripping regressed, each would demand
        // an ARG for a variable that no longer exists.
        for (const scar of [
            'NEXT_PUBLIC_NOTIFICATIONS_SSE',
            'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
            'NEXT_PUBLIC_TURNSTILE_SITEKEY',
        ]) {
            expect({ scar, inPopulation: POPULATION.includes(scar) }).toEqual({
                scar,
                inPopulation: false,
            });
        }
        // Not vacuous: those names must still be PRESENT in the tree as prose,
        // or this control is passing because they were deleted outright.
        const allText = SRC_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
        for (const scar of [
            'NEXT_PUBLIC_NOTIFICATIONS_SSE',
            'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
            'NEXT_PUBLIC_TURNSTILE_SITEKEY',
        ]) {
            expect({ scar, mentioned: allText.includes(scar) }).toEqual({ scar, mentioned: true });
        }
    });

    it('CONTROL: stripComments removes prose but keeps code', () => {
        expect(stripComments('// NEXT_PUBLIC_A\nconst x = 1;')).not.toContain('NEXT_PUBLIC_A');
        expect(stripComments('/* NEXT_PUBLIC_B */\nconst y = 2;')).not.toContain('NEXT_PUBLIC_B');
        expect(stripComments('const z = process.env.NEXT_PUBLIC_C;')).toContain('NEXT_PUBLIC_C');
    });
});

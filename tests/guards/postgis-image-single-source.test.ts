/**
 * The Postgres/PostGIS service image is pinned in ONE place.
 *
 * `.github/postgis-image` owns the string. TEN sites consume it, and only
 * one of them is able to READ a file — the other nine are literals by
 * necessity: GitHub Actions gives `jobs.<id>.services.<id>.image` no `env`
 * context and no way to call an action, and `FROM` takes no runtime lookup.
 * So the invariant cannot be "there is only one copy"; it has to be "every
 * copy is mechanically checked against the owner".
 *
 * WHY THIS SHAPE AND NOT A CHEAPER ONE. A guard that merely asserted the
 * literals agree with EACH OTHER would have a hole exactly where the damage
 * is: `.github/actions/enable-pgvector/action.yml` selects the service
 * container with `docker ps --filter ancestor=<image>`, which is not an
 * `image:` line and would not be in the population. Move the six workflow
 * pins together and a self-consistency check stays green while the action
 * filters for an image nothing is running. That is why the action DERIVES
 * its value from the owner file instead, and why this guard asserts it holds
 * no literal of its own (Direction C) — a site with nothing to drift cannot
 * drift.
 *
 * The four assertions:
 *
 *   A. Every `postgis/postgis:<tag>` reference in the tracked tree equals
 *      the owner file's line. Derived by scanning, not from a list, so a
 *      NEW site is covered the moment it exists — and the owner file's
 *      enumeration of those literals is checked against the count.
 *   B. Each site that runs `apt-get update` against this image carries
 *      `Acquire::Check-Valid-Until=false`. #833 shipped that flag to the CI
 *      action and missed the two Dockerfile copies, so the dev stack, the
 *      VM's `agrent-db:local` build and the monthly restore drill all failed
 *      to build from 2026-09-07 while CI stayed green. One patched site out
 *      of three is precisely the shape a per-site literal produces. B's
 *      population is DERIVED by scanning, exactly as A's is — see the long
 *      note in that block for why a list there was a defect, not a shortcut.
 *   C. The action derives (references the owner file) and restates nothing.
 *   D. A local build tag that ENCODES the pinned version encodes the CURRENT
 *      one. `agri-saas-postgres:16-3.4-pgvector` is the pin spelled a second
 *      way, inside a name A's `postgis/postgis:` regex cannot see. Its
 *      population comes from PARSING the compose files, so no key order can
 *      hide a service, and the local names it finds are what lets B recognise
 *      a Dockerfile built `FROM` one of them.
 *
 * This is a SOURCE-TEXT guard (CLAUDE.md, "Green is not the same as
 * executed"): it proves the strings agree and never starts a container.
 * Every assertion is paired with a POSITIVE CONTROL on its own population,
 * because an empty scan satisfies "no site disagrees" perfectly.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const PIN_FILE = '.github/postgis-image';
const PIN_BASENAME = path.basename(PIN_FILE);
const ACTION = '.github/actions/enable-pgvector/action.yml';

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Tracked content, or null for a deleted-but-tracked entry or a binary we cannot decode. */
function tryRead(rel: string): string | null {
    try {
        return read(rel);
    } catch {
        return null;
    }
}

/** A full `repo/name:tag` reference. Bare `postgis:16-3.4` prose does not match. */
const IMAGE_REF = /postgis\/postgis:[A-Za-z0-9._-]+/g;

/**
 * The same pattern without `g`. A global regex carries `lastIndex` between
 * `.test()` calls, so a shared one alternates true/false on identical input.
 * A membership predicate must not be built on that.
 */
const HAS_IMAGE_REF = new RegExp(IMAGE_REF.source);

/**
 * Sites that MUST carry the pin. This list is not the population Direction A
 * scans — it is the positive control PROVING that scan reached the files that
 * matter. A workflow renamed out from under a filesystem walk is otherwise
 * indistinguishable from a workflow with no pin in it.
 *
 * The counts add to NINE, which is the number `.github/postgis-image`
 * enumerates in prose: six `image:` lines, two `FROM`s, one doc table row.
 */
const REQUIRED_SITES: ReadonlyArray<{ file: string; count: number; why: string }> = [
    { file: '.github/workflows/ci.yml', count: 3, why: 'test + e2e-shard + docker service containers' },
    { file: '.github/workflows/lighthouse.yml', count: 1, why: 'lighthouse service container' },
    { file: '.github/workflows/coverage-reference.yml', count: 1, why: 'must mirror ci.yml `test` exactly' },
    { file: '.github/workflows/load-test.yml', count: 1, why: 'k6 service container' },
    { file: 'deploy/postgres/Dockerfile', count: 1, why: 'dev stack + the VM agrent-db:local build' },
    { file: 'infra/scripts/restore-test-gcp.sh', count: 1, why: 'restore drill builds the same two layers on a bare VM' },
    { file: 'docs/dev-setup-macos.md', count: 1, why: 'arm64 manifest table names the image' },
];

/** What the owner file's prose claims, spelled the way the prose spells it. */
const DECLARED_LITERALS = { count: 9, word: 'nine' } as const;

/**
 * Number words indexed by value, so `DECLARED_LITERALS` cannot say
 * `{ count: 9, word: 'eight' }` and be believed by the two halves separately.
 */
const NUMBER_WORDS = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six',
    'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
] as const;

/**
 * How many sentences of the owner file state the count today. A FLOOR, so
 * adding another is free and deleting one is a deliberate edit here.
 */
const MIN_COUNT_CLAIMS = 3;

/**
 * Every "<count> literals" / "<count> live references" claim in the owner
 * file's prose, read ACROSS line breaks and `#` comment markers.
 *
 * WHY NOT `toContain('nine literals')`. The owner file makes the claim more
 * than once, and in the first sentence the number ends one line while the noun
 * begins the next behind a `# `. A substring match therefore reached the LAST
 * sentence only — "eight" could be reinstated in the first one, four lines
 * apart from a "nine", with the guard green. That is the exact off-by-one this
 * assertion exists to have caught, so it must read every sentence: strip the
 * comment markers, flatten the whitespace, then collect them all.
 */
const COUNT_CLAIM = new RegExp(
    String.raw`\b(${NUMBER_WORDS.join('|')}|\d+)\s+(?:literals|live references)\b`,
    'g',
);

function countClaims(src: string): string[] {
    const prose = src.replace(/^[ \t]*#[ \t]?/gm, '').replace(/\s+/g, ' ');
    return [...prose.matchAll(COUNT_CLAIM)].map((m) => m[1]);
}

/**
 * The three sites that today run `apt-get` inside the image. Like
 * REQUIRED_SITES this is the POSITIVE CONTROL for Direction B's scan, and
 * emphatically NOT its population — see the derivation in that block.
 */
const REQUIRED_APT_SITES: readonly string[] = [
    ACTION,
    'deploy/postgres/Dockerfile',
    'infra/scripts/restore-test-gcp.sh',
];

const STOPGAP_FLAG = 'Acquire::Check-Valid-Until=false';

/**
 * Paths whose image references are HISTORICAL RECORD, not a live pin.
 *
 * `docs/implementation-notes/<date>-*.md` are dated write-ups of what was
 * true on the day they landed — the same status `prisma/migrations/*.sql`
 * has, and for the same reason: rewriting one to match a later value
 * destroys the record it exists to keep. A note that says "we measured
 * the `16-3.4` image and it exited 100" must keep saying that after the pin
 * moves, and one that quotes the unflagged command #833 left behind must
 * keep quoting it.
 *
 * Kept as a PREFIX list rather than a per-file list so the exemption cannot
 * be quietly stretched to cover a live consumer; the test below asserts
 * every entry is a dated-notes path.
 */
const HISTORICAL_PREFIXES: readonly string[] = ['docs/implementation-notes/'];

const isHistorical = (rel: string) => HISTORICAL_PREFIXES.some((p) => rel.startsWith(p));

/** The pin, parsed the way every consumer parses it: first non-comment line. */
function ownerPin(): string {
    for (const line of read(PIN_FILE).split('\n')) {
        const t = line.trim();
        if (t !== '' && !t.startsWith('#')) return t;
    }
    return '';
}

/** Tracked files only — never node_modules, never a stale build artifact. */
function trackedFiles(): string[] {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
}

/* ── The compose side of the pin, derived once ─────────────────────────────
 *
 * Two directions need it. D needs the LOCAL image names that compose publishes
 * for builds of the pinned Dockerfile; B needs those same names to decide
 * whether a file works against the pinned image, because `FROM
 * agri-saas-postgres:<tag>-pgvector` is that image just as surely as
 * `FROM postgis/postgis:<tag>` is.
 *
 * PARSED, NOT PATTERN-MATCHED — and that is a correction, not a preference.
 * An earlier revision found the `build:` key by regex and then scanned FORWARD
 * for a sibling `image:`. `image:` written ABOVE `build:` is YAML-identical and
 * entirely idiomatic Compose, and it dropped the service out of the population
 * with every assertion still green: the emptiness hole this guard exists to
 * refuse, reintroduced by key ORDER. js-yaml hands back a mapping, in which
 * order does not exist. It also picks up the `build: <dir>` shorthand and
 * resolves `dockerfile:` relative to `context:` the way Compose does, neither
 * of which a line regex was doing.
 */

const PIN_DOCKERFILE = 'deploy/postgres/Dockerfile';
/** The directory a bare `context:` has to name to build the pin. */
const PIN_BUILD_DIR = PIN_DOCKERFILE.slice(0, PIN_DOCKERFILE.lastIndexOf('/'));

interface ComposeService {
    build?: unknown;
    image?: unknown;
}
interface ComposeFile {
    services?: unknown;
}

/** `./deploy/postgres/` -> `deploy/postgres`; `.` and `./` -> ``. */
const normPath = (p: string) =>
    p.trim().replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/^\.$/, '');

/**
 * Repo-relative path of the Dockerfile a `build:` value names, or null when the
 * value is not a build spec at all. Compose resolves `dockerfile:` RELATIVE to
 * `context:`, so both live shapes land on the same string: `context: .` plus
 * `dockerfile: deploy/postgres/Dockerfile` (the dev and test stacks) and a bare
 * `context: ./deploy/postgres` (the VM stack).
 */
function builtDockerfile(build: unknown): string | null {
    let context: string | undefined;
    let dockerfile: string | undefined;
    if (typeof build === 'string') {
        context = build;
    } else if (build !== null && typeof build === 'object') {
        const b = build as Record<string, unknown>;
        if (typeof b.context === 'string') context = b.context;
        if (typeof b.dockerfile === 'string') dockerfile = b.dockerfile;
    }
    if (context === undefined && dockerfile === undefined) return null;
    const dir = normPath(context ?? '.');
    const file = normPath(dockerfile ?? 'Dockerfile');
    return dir === '' ? file : `${dir}/${file}`;
}

const YAML_FILE = /\.ya?ml$/;

/** Every tracked YAML, loaded once. A file that will not parse is REPORTED. */
const composeDocs = (() => {
    const parsed: Array<{ rel: string; doc: ComposeFile }> = [];
    const unparsable: string[] = [];
    for (const rel of trackedFiles()) {
        if (!YAML_FILE.test(rel)) continue;
        const src = tryRead(rel);
        if (src === null) continue;
        try {
            const doc: unknown = yaml.load(src);
            if (doc !== null && typeof doc === 'object') parsed.push({ rel, doc: doc as ComposeFile });
        } catch {
            unparsable.push(rel);
        }
    }
    return { parsed, unparsable };
})();

/** Per compose file: the `image:` values its pin-building services publish. */
const buildSiteTags: ReadonlyArray<{ rel: string; tags: string[] }> = composeDocs.parsed
    .map(({ rel, doc }) => {
        const services = doc.services;
        const list =
            services !== null && typeof services === 'object'
                ? (Object.values(services as Record<string, unknown>) as unknown[])
                : [];
        const building = list.filter(
            (svc): svc is ComposeService =>
                svc !== null &&
                typeof svc === 'object' &&
                builtDockerfile((svc as ComposeService).build) === PIN_DOCKERFILE,
        );
        const tags = building
            .map((svc) => svc.image)
            .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
            .map((v) => v.trim());
        return { rel, buildingCount: building.length, tags: [...new Set(tags)] };
    })
    .filter((e) => e.buildingCount > 0)
    .map(({ rel, tags }) => ({ rel, tags }));

const buildSites: readonly string[] = buildSiteTags.map((e) => e.rel);

/**
 * The pin spelled as a LOCAL image name — derived from the compose files above
 * rather than written down, so renaming a tag carries B along with it.
 */
const LOCAL_PINNED_TAGS: readonly string[] = [...new Set(buildSiteTags.flatMap((e) => e.tags))];

/**
 * Compose files that MUST be in D's population, with how many tags each
 * publishes and how many of those ENCODE a version. Positive control, NOT the
 * population — the same relationship REQUIRED_SITES has to Direction A's scan.
 *
 * The per-site `encoded` counts are the whole point. A global
 * "at least one tag encodes a version" floor is satisfied by the OTHER site
 * when one drops out of view, which is exactly how a site goes missing
 * unnoticed; that floor was this block's second defect. `agrent-db:local`
 * encodes no version and is registered at zero — correct, and still SEEN.
 */
const REQUIRED_BUILD_SITES: ReadonlyArray<{
    file: string;
    tags: number;
    encoded: number;
    why: string;
}> = [
    { file: 'docker-compose.yml', tags: 1, encoded: 1, why: 'dev stack, publishes agri-saas-postgres:<tag>-pgvector' },
    { file: 'docker-compose.test.yml', tags: 1, encoded: 1, why: 'local CI stack, same versioned local name' },
    { file: 'deploy/docker-compose.vm.yml', tags: 1, encoded: 0, why: 'agrent-db:local encodes no version, and must still be seen' },
];

describe('.github/postgis-image is the single source of the service image', () => {
    const pin = ownerPin();

    it('the owner file yields exactly one image reference', () => {
        // Without this, an emptied or comment-only pin file would make
        // Direction A compare every site against '' and pass nothing —
        // or, worse, make the action filter on an empty ancestor.
        expect(pin).toMatch(/^postgis\/postgis:[A-Za-z0-9._-]+$/);
        const body = read(PIN_FILE);
        expect(body.match(IMAGE_REF) ?? []).toEqual([pin]);
    });

    it('the Postgres major is 16 — a major bump is a separate, deliberate change', () => {
        // A PostGIS minor may move (16-3.4 -> 16-3.5). The Postgres major may
        // not move by accident: the `18-3.6` tag is the only one on a
        // maintained Debian, and reaching for it to fix #832 would silently
        // take the cluster from PG16 to PG18. Migrating the major is fine —
        // it just has to break this line first.
        //
        // (Bare tags, not full references, in this file's prose on purpose:
        // Direction A scans the tracked tree and this file is IN it. That is
        // deliberate — a guard should not exempt itself — but it means an
        // example spelled as a full reference is a real drift finding. It
        // caught exactly that here, and only once the file was committed:
        // while untracked, `git ls-files` did not list it and the guard was
        // passing for the wrong reason.)
        expect(pin.split(':')[1]).toMatch(/^16(?:[.-]|$)/);
    });

    describe('A. every literal in the tree equals the owner', () => {
        const files = trackedFiles();
        const occurrences = files.flatMap((rel) => {
            if (rel === PIN_FILE) return [];
            const src = tryRead(rel);
            if (src === null) return [];
            return (src.match(IMAGE_REF) ?? []).map((ref) => ({ rel, ref }));
        });

        it('the scan reached a real population (positive control)', () => {
            // `git ls-files` returning nothing, or the regex silently failing
            // to compile against real content, would make the next assertion
            // vacuously true — the classic empty-selection pass.
            expect(files.length).toBeGreaterThan(100);
            expect(occurrences.length).toBeGreaterThanOrEqual(
                REQUIRED_SITES.reduce((n, s) => n + s.count, 0),
            );
        });

        it.each(REQUIRED_SITES)('$file carries $count pin(s) — $why', ({ file, count }) => {
            // The other half of the control: proves the scan SAW each site
            // that matters, so a renamed or deleted consumer fails loudly
            // instead of quietly leaving the population.
            expect(occurrences.filter((o) => o.rel === file)).toHaveLength(count);
        });

        it('the owner file enumerates the literals that actually exist', () => {
            // The owner file's header is an EXACT enumeration — "those nine
            // literals (six `image:` lines, two `FROM`s, one doc table row)"
            // — and prose that counts is prose that can drift off by one.
            // (It did: the file simultaneously claimed nine and eight.) Tie
            // the number to the tree so the claim cannot rot silently, and
            // so a genuinely new literal has to be registered rather than
            // quietly enlarging a sentence nobody re-reads.
            const live = occurrences.filter((o) => !isHistorical(o.rel));
            expect(NUMBER_WORDS[DECLARED_LITERALS.count]).toBe(DECLARED_LITERALS.word);
            expect(REQUIRED_SITES.reduce((n, s) => n + s.count, 0)).toBe(DECLARED_LITERALS.count);
            expect(live).toHaveLength(DECLARED_LITERALS.count);

            // EVERY sentence that states the count, not just the one a
            // substring match happened to land on. `toContain('nine
            // literals')` covered the last of them only, because the first
            // splits the number from the noun across a line and a `# ` — so
            // the eight-vs-nine contradiction could be reinstated in the
            // sibling sentence with this test green.
            const claims = countClaims(read(PIN_FILE));
            expect(claims.length).toBeGreaterThanOrEqual(MIN_COUNT_CLAIMS);
            expect(claims.filter((c) => c !== DECLARED_LITERALS.word)).toEqual([]);
        });

        it('no LIVE site disagrees with the owner', () => {
            const drifted = occurrences
                .filter((o) => !isHistorical(o.rel))
                .filter((o) => o.ref !== pin)
                .map((o) => `${o.rel}: ${o.ref}`);
            expect(drifted).toEqual([]);
        });

        it('the historical carve-out covers only dated notes', () => {
            // An exemption is a hole. This keeps it the shape it was argued
            // for: if someone adds `deploy/` or `.github/` to that list to
            // silence a real drift, this fails instead.
            for (const p of HISTORICAL_PREFIXES) {
                expect(p).toMatch(/^docs\/implementation-notes\/$/);
            }
            // And no REQUIRED site of either direction may hide behind it.
            for (const { file } of REQUIRED_SITES) expect(isHistorical(file)).toBe(false);
            for (const file of REQUIRED_APT_SITES) expect(isHistorical(file)).toBe(false);
        });
    });

    describe('B. every site that runs apt-get inside the image keeps the stopgap', () => {
        /**
         * `apt-get update` lines that run INSIDE the bullseye image: a
         * Dockerfile `RUN`, or an exec into the running service container.
         *
         * The narrowing is load-bearing rather than cosmetic.
         * `infra/scripts/restore-test-gcp.sh` also updates the package index
         * to install docker.io on the restore VM's own HOST, which is a
         * different, unfrozen suite and must NOT carry the flag — requiring
         * it there would be a false positive that teaches the next reader to
         * relax an index that is perfectly healthy.
         */
        const inImage = (line: string) =>
            /apt-get\b[^\n]*\bupdate\b/.test(line) &&
            (/^\s*RUN\b/.test(line) || line.includes('docker exec')) &&
            !line.trim().startsWith('#');

        const aptLines = (rel: string) => (tryRead(rel) ?? '').split('\n').filter(inImage);

        /**
         * B'S POPULATION IS DERIVED, NOT LISTED — and that is the whole point.
         *
         * A hardcoded three-item list here would have exactly the defect this
         * guard exists to attack. A reviewer proved it on the first draft:
         * adding `deploy/postgres-replica/Dockerfile` with the pinned `FROM`
         * and an unflagged package-index update passed every test, because
         * the new file was not on the list. That is the #833 recurrence shape
         * verbatim — a real site, running against the frozen index, invisible
         * to the check that claimed to cover it — so B now scans the way A
         * does.
         *
         * A file is IN the population when it BOTH
         *   (a) works against the pinned image — it carries the literal, or
         *       it derives the pin from the owner file (the action holds no
         *       literal at all, by Direction C, so matching the literal alone
         *       would miss the one site #833 did patch), or it names one of
         *       the LOCAL tags compose publishes for a build of the pinned
         *       Dockerfile, AND
         *   (b) runs the index update inside that image, by `inImage` above.
         *
         * That third recogniser is a review finding, not decoration. Direction
         * D establishes `agri-saas-postgres:<tag>-pgvector` as the pin spelled
         * a second way; until B knew the name too, a Dockerfile that began
         * `FROM agri-saas-postgres:16-3.4-pgvector` and refreshed the package
         * index unflagged was invisible to B — the frozen bullseye index one
         * layer down, and no literal anywhere for the scan to catch. The names
         * come from D's parse rather than a list, so they cannot fall behind a
         * rename.
         *
         * Like Direction A, this scan does not exempt the guard's own file.
         * It simply does not match: no line here is a Dockerfile `RUN`, and
         * no single line pairs a container-exec with an index update. An
         * earlier draft of THIS comment did pair them, and the scan duly
         * reported this file as an unflagged site — the derivation working
         * exactly as intended. Keep the two spellings on separate lines.
         */
        const usesPinnedImage = (src: string) =>
            HAS_IMAGE_REF.test(src) ||
            src.includes(PIN_BASENAME) ||
            LOCAL_PINNED_TAGS.some((tag) => src.includes(tag));

        const aptSites = trackedFiles()
            .filter((rel) => rel !== PIN_FILE && !isHistorical(rel))
            .filter((rel) => {
                const src = tryRead(rel);
                return src !== null && usesPinnedImage(src) && src.split('\n').some(inImage);
            });

        it('the derived population is non-empty and holds every known site (positive control)', () => {
            // Narrowing a selector is the standard way a guard goes vacuous:
            // an over-tight `inImage`, or a `usesPinnedImage` that stopped
            // recognising the derivation, would select nothing and the flag
            // assertion below would pass by examining zero lines. Prove the
            // selection is non-empty before trusting its verdict.
            expect(aptSites.length).toBeGreaterThanOrEqual(REQUIRED_APT_SITES.length);
            expect(aptSites).toEqual(expect.arrayContaining([...REQUIRED_APT_SITES]));

            // And the local-name recogniser specifically: it is DERIVED from
            // the compose parse, so if that returned nothing B would quietly
            // stop seeing a whole class of site while still passing the two
            // assertions above on the strength of its other two recognisers.
            expect(LOCAL_PINNED_TAGS.length).toBeGreaterThanOrEqual(2);
            for (const tag of LOCAL_PINNED_TAGS) expect(usesPinnedImage(`FROM ${tag}`)).toBe(true);
        });

        it.each(REQUIRED_APT_SITES)('%s updates the package index inside the image (positive control)', (rel) => {
            expect(aptLines(rel).length).toBeGreaterThanOrEqual(1);
        });

        it('every derived site carries the expired-Release flag on every such line', () => {
            // Reported as a LIST rather than per-site, so a brand-new site
            // nobody thought to register still names itself in the failure.
            const unflagged = aptSites.flatMap((rel) =>
                aptLines(rel)
                    .filter((line) => !line.includes(STOPGAP_FLAG))
                    .map((line) => `${rel}: ${line.trim()}`),
            );
            expect(unflagged).toEqual([]);
        });

        it('the flag is labelled a stopgap and names the tracking issue', () => {
            // The flag reads as a security relaxation. Its justification is
            // the only thing stopping a future reader from "cleaning it up"
            // and re-breaking every job that touches the action.
            const src = read(ACTION);
            expect(src).toMatch(/stopgap/i);
            expect(src).toMatch(/#832/);
        });
    });

    describe('C. the ancestor lookup derives instead of restating', () => {
        const src = read(ACTION);

        it('actually READS the owner file', () => {
            // Positive control for the absence check below: an action that
            // had dropped the derivation entirely would also hold no literal,
            // and would pass "no site disagrees" by having nothing to compare.
            //
            // A `toContain('postgis-image')` is NOT enough, and that is not a
            // hypothetical — it was this guard's first draft, and pointing
            // `pin_file` at /dev/null left every test green, because the
            // word survives in the comments and the error strings that
            // explain the derivation. Match the ASSIGNMENT and the READ.
            expect(src).toMatch(
                /pin_file="\$\{GITHUB_ACTION_PATH\}\/\.\.\/\.\.\/postgis-image"/,
            );
            expect(src).toMatch(/image="\$\(grep[^\n]*"\$pin_file"/);
            expect(src).toMatch(/docker ps --filter "ancestor=\$\{image\}"/);
        });

        it('holds no image literal of its own', () => {
            // The trap this guard exists for. A literal here is a copy that
            // no `image:` line drags along when the pin moves, and its
            // failure mode is a filter that matches nothing.
            expect(src.match(IMAGE_REF) ?? []).toEqual([]);
        });

        it('does not take the first of several matches', () => {
            // `head -1` collapsed "no container" and "one container" into the
            // same variable. Counting keeps zero and two distinguishable.
            expect(src).not.toMatch(/ancestor=[^\n]*\|\s*head\s+-1/);
            expect(src).toContain('mapfile -t cids');
        });
    });

    describe('D. a local tag that encodes the pin encodes the CURRENT pin', () => {
        /**
         * `docker-compose.yml` and `docker-compose.test.yml` build
         * `deploy/postgres/Dockerfile` and publish the result as
         * `agri-saas-postgres:16-3.4-pgvector`. That `16-3.4` IS the pin,
         * spelled a second way — but the name is local, so Direction A's
         * `postgis/postgis:<tag>` regex cannot see it. Bump the owner and
         * those two lines keep claiming 16-3.4 with CI green: the exact
         * drift the rest of this guard exists to stop, in the one shape it
         * was blind to.
         *
         * Derived, not listed, for the same reason B is — see the parse block
         * at the top of this file for HOW, and for the key-order hole that
         * made a hand-rolled block walk the wrong tool for the job.
         *
         * Every control below is PER SITE. The first version's control was
         * `expect(encoded.length).toBeGreaterThanOrEqual(1)`, a global floor
         * that one healthy site satisfies on behalf of a vanished one: hide
         * `docker-compose.test.yml` and the dev stack alone kept it green.
         */

        /** `16-3.4` inside `agri-saas-postgres:16-3.4-pgvector`. */
        const VERSION_TOKEN = /\d+-\d+(?:\.\d+)*/;
        const pinTag = pin.split(':')[1] ?? '';

        const tagsOf = (rel: string) => buildSiteTags.find((e) => e.rel === rel)?.tags ?? [];

        const encoded = buildSiteTags.flatMap(({ rel, tags }) =>
            tags
                .map((ref) => ({ rel, ref, version: (ref.split(':').pop() ?? '').match(VERSION_TOKEN)?.[0] }))
                .filter((e): e is { rel: string; ref: string; version: string } => e.version !== undefined),
        );

        it('every YAML that could hold a build site actually parsed (positive control)', () => {
            // A parse error is the parsed population's version of an empty
            // scan: the file silently leaves, and every verdict below is
            // reached without it. Anything naming the pinned Dockerfile's
            // directory has to parse, by name, or this fails.
            const hiding = composeDocs.unparsable.filter((rel) =>
                (tryRead(rel) ?? '').includes(PIN_BUILD_DIR),
            );
            expect(hiding).toEqual([]);
            expect(composeDocs.parsed.length).toBeGreaterThan(20);
        });

        it('the build-site scan found every compose file that builds the pin (positive control)', () => {
            expect(buildSites).toEqual(
                expect.arrayContaining(REQUIRED_BUILD_SITES.map((s) => s.file)),
            );
        });

        it.each(REQUIRED_BUILD_SITES)(
            '$file publishes $tags tag(s) for the pinned build — $why',
            ({ file, tags }) => {
                // Proves the parse reached THIS file's build service and read
                // its `image:`, whichever side of `build:` that key sits on.
                expect(tagsOf(file)).toHaveLength(tags);
            },
        );

        it.each(REQUIRED_BUILD_SITES)(
            '$file contributes $encoded version-encoding tag(s) — $why',
            ({ file, encoded: expected }) => {
                // The per-site half of the emptiness control. A site that
                // stops encoding a version has to say so here; it can no
                // longer hide behind a sibling that still does.
                expect(encoded.filter((e) => e.rel === file)).toHaveLength(expected);
            },
        );

        it('the version-encoding population is non-empty and per-site complete (positive control)', () => {
            expect(encoded.length).toBeGreaterThanOrEqual(
                REQUIRED_BUILD_SITES.reduce((n, s) => n + s.encoded, 0),
            );
            expect(encoded.map((e) => e.rel)).toEqual(
                expect.arrayContaining(
                    REQUIRED_BUILD_SITES.filter((s) => s.encoded > 0).map((s) => s.file),
                ),
            );
            expect(pinTag).toMatch(VERSION_TOKEN);
        });

        it('no published tag encodes a version other than the owner’s', () => {
            const stale = encoded.filter((e) => e.version !== pinTag).map((e) => `${e.rel}: ${e.ref}`);
            expect(stale).toEqual([]);
        });
    });
});

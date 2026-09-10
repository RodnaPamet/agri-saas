/**
 * The Postgres/PostGIS service image is pinned in ONE place.
 *
 * `.github/postgis-image` owns the string. Eleven sites consume it, and only
 * one of them is able to READ a file — the other ten are literals by
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
 *      `Acquire::Check-Valid-Until=false` INSIDE that invocation. #833
 *      shipped that flag to the CI action and missed the two Dockerfile
 *      copies, so the dev stack, the VM's `agrent-db:local` build and the
 *      monthly restore drill all failed to build from 2026-09-07 while CI
 *      stayed green.
 *   C. The action derives (reads the owner file), restates nothing, and
 *      selects the container by COUNTING matches rather than taking the
 *      first of them.
 *   D. A local build tag that ENCODES the pinned version encodes the CURRENT
 *      one. `agri-saas-postgres:16-3.4-pgvector` is the pin spelled a second
 *      way, inside a name A's `postgis/postgis:` regex cannot see.
 *
 * ── WHAT THIS FILE IS A REWRITE OF, AND WHY (#860) ─────────────────────────
 *
 * A previous guard with this same four-direction structure was rejected three
 * times for being green against the very break it exists to prevent. The
 * structure survived; every one of its POPULATIONS was rebuilt here. The four
 * defeats it went green on, each of which this file is required to report:
 *
 *   1. THE FLAG SATISFIED BY A COMMENT. It filtered `!line.includes(FLAG)`
 *      over the whole PHYSICAL line, comments included, so
 *        `RUN apt-get update \  # FIXME(#832): Acquire::…=false dropped`
 *      left it 32/32 green with the real flag gone and the build broken.
 *      Here: comments are stripped in the file's own comment syntax BEFORE
 *      the flag is looked for, and the flag must sit inside the `apt-get`
 *      invocation itself — not merely somewhere on the line.
 *   2. `apt-get` ON A `RUN` CONTINUATION LINE. Its predicate required the
 *      line carrying `apt-get` to itself start with `RUN`, so the dominant
 *      `RUN … \` idiom never entered the population at all. Here: line
 *      continuations are JOINED first, so a `RUN` block is one logical line
 *      however it is wrapped.
 *   3. A `docker compose exec` SITE. It matched the substring `docker exec`
 *      only — and `docker compose exec` does not contain it. Here: the exec
 *      recogniser accepts the v1 and v2 spellings, `docker-compose`, a
 *      `-f <file>.yml` in between, `sudo` in front, and the command reached
 *      through a variable (`${DOCKER} exec`), because a command invoked
 *      through a variable is still a command.
 *   4. A `head -1` ALTERNATIVE SPELLING. Direction C blacklisted that one
 *      spelling, which `head -n 1`, `sed -n 1p` and `awk NR==1` walk past.
 *      Here: nothing is blacklisted. The count-based SHAPE is asserted
 *      positively — the lookup fills an array in ONE stage (no downstream
 *      filter of any spelling), the array's length is tested against both 0
 *      and >1, and the container id comes out of that same array.
 *
 * WHAT THE POSITIVE CONTROLS DO AND DO NOT PROVE. Every direction below is
 * paired with controls, because an empty selection passes "no site disagrees"
 * perfectly. Two kinds are used, and the difference matters:
 *
 *   - REACH controls (`REQUIRED_SITES`, `REQUIRED_APT_SITES`,
 *     `REQUIRED_BUILD_SITES`) prove the scan SAW the files that matter. They
 *     do not prove the verdict has teeth.
 *   - TEETH controls take the REAL source of a real site, inject the real
 *     defect into it in memory, and require the SAME function the live
 *     assertion calls to report it. They are derived from the live input, not
 *     from a fixture: a control that feeds synthetic input proves nothing
 *     about the path that executes, and that is precisely how the rejected
 *     guard passed while being defeated.
 *
 * This is a SOURCE-TEXT guard (CLAUDE.md, "Green is not the same as
 * executed"): it proves the strings agree and never starts a container. It
 * does not, and cannot, prove that `apt-get update` actually succeeds inside
 * the image — only that no site has quietly dropped the flag that makes it.
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

/**
 * A full `repo/name:tag` reference. Bare `postgis:16-3.4` prose does not match.
 *
 * Written with the separator escaped so this file does not itself contain the
 * literal it hunts for: Direction A scans the tracked tree and this file is IN
 * it, deliberately — a guard should not exempt itself — so a full reference
 * spelled here would be counted as an eleventh live copy.
 */
const IMAGE_REF = /postgis\/postgis:[A-Za-z0-9._-]+/g;

/**
 * The same pattern without `g`. A global regex carries `lastIndex` between
 * `.test()` calls, so a shared one alternates true/false on identical input.
 * A membership predicate must not be built on that.
 */
const HAS_IMAGE_REF = new RegExp(IMAGE_REF.source);

/**
 * Sites that MUST carry the pin. This list is not the population Direction A
 * scans — it is the REACH control PROVING that scan arrived at the files that
 * matter. A workflow renamed out from under a filesystem walk is otherwise
 * indistinguishable from a workflow with no pin in it.
 *
 * The counts add to TEN, which is the number `.github/postgis-image`
 * enumerates in prose: six `image:` lines, two `FROM`s, two doc mentions.
 * (`docs/dev-setup-macos.md` names the image twice — the arm64 table row and
 * the expired-Release section. The rejected guard registered it at one, which
 * was already wrong by the time that file grew its second mention.)
 */
const REQUIRED_SITES: ReadonlyArray<{ file: string; count: number; why: string }> = [
    { file: '.github/workflows/ci.yml', count: 3, why: 'test + e2e-shard + docker service containers' },
    { file: '.github/workflows/lighthouse.yml', count: 1, why: 'lighthouse service container' },
    { file: '.github/workflows/coverage-reference.yml', count: 1, why: 'must mirror ci.yml `test` exactly' },
    { file: '.github/workflows/load-test.yml', count: 1, why: 'k6 service container' },
    { file: 'deploy/postgres/Dockerfile', count: 1, why: 'dev stack + the VM agrent-db:local build' },
    { file: 'infra/scripts/restore-test-gcp.sh', count: 1, why: 'restore drill builds the same two layers on a bare VM' },
    { file: 'docs/dev-setup-macos.md', count: 2, why: 'arm64 manifest table + the expired-Release section' },
];

/** What the owner file's prose claims, spelled the way the prose spells it. */
const DECLARED_LITERALS = { count: 10, word: 'ten' } as const;

/**
 * Number words indexed by value, so `DECLARED_LITERALS` cannot say
 * `{ count: 10, word: 'nine' }` and be believed by the two halves separately.
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
 * WHY NOT `toContain('ten literals')`. The owner file makes the claim more
 * than once, and in the first sentence the number ends one line while the noun
 * begins the next behind a `# `. A substring match therefore reaches the LAST
 * sentence only — a stale number could be reinstated in the first one, four
 * lines apart from a correct one, with the guard green.
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
 * The three sites that today refresh the package index inside the image. Like
 * REQUIRED_SITES this is a REACH control for Direction B's scan, and
 * emphatically NOT its population — see the derivation in that block.
 */
const REQUIRED_APT_SITES: readonly string[] = [
    ACTION,
    'deploy/postgres/Dockerfile',
    'infra/scripts/restore-test-gcp.sh',
];

const STOPGAP_FLAG = 'Acquire::Check-Valid-Until=false';

/** The flag as an apt OPTION, which is the only form that changes behaviour. */
const STOPGAP_OPTION = new RegExp(String.raw`-o\s+${STOPGAP_FLAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/**
 * The real option struck out of real source. Every teeth control below starts
 * from this: the defect is INJECTED INTO THE LIVE INPUT, never assembled as a
 * fixture, so the control and the live assertion look at the same bytes.
 */
const withoutFlagOption = (src: string) => src.replace(new RegExp(STOPGAP_OPTION.source, 'g'), '');

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

/* ── Reading a command out of source text ──────────────────────────────────
 *
 * Three of the four defeats listed at the top of this file were defeats of
 * this layer, not of the assertions above it, so it is written once and used
 * by every direction that has to look at a shell command.
 */

type CommentStyle = 'hash' | 'slash' | 'none';

/**
 * Markdown gets `none` on purpose: `#` there is a heading, not a comment, and
 * pretending otherwise would silently delete prose that a doc-embedded command
 * might sit under. Unknown extensions get `hash`, the shell/YAML/Dockerfile
 * convention, because every executable consumer of this pin is one of those.
 */
function commentStyle(rel: string): CommentStyle {
    if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(rel)) return 'slash';
    if (/\.(?:md|mdx)$/.test(rel)) return 'none';
    return 'hash';
}

/**
 * Drop a trailing comment, quote-aware, so a `#` inside `sh -c '…#…'` is left
 * alone and a `#` that really does start a comment is cut.
 *
 * DEFEAT 1 LIVES HERE. The rejected guard asked whether the whole physical
 * line contained the flag, so writing the flag's TEXT into a trailing comment
 * satisfied it while the flag itself was gone from the command.
 */
function stripLineComment(line: string, style: CommentStyle): string {
    if (style === 'none') return line;
    const marker = style === 'hash' ? '#' : '//';
    let quote: string | null = null;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote !== null) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (line.startsWith(marker, i) && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
}

interface LogicalLine {
    /** 1-based number of the FIRST physical line, so a failure is navigable. */
    readonly line: number;
    readonly text: string;
}

/**
 * Comment-stripped, continuation-joined lines.
 *
 * DEFEAT 2 LIVES HERE. `RUN apt-get update && apt-get install …` written
 * across four lines with `\` is the dominant idiom in this repo and in every
 * Dockerfile anyone writes; a predicate applied to physical lines sees a first
 * line with no `apt-get` in it and three continuation lines with no `RUN`, and
 * selects none of them.
 */
function logicalLines(rel: string, src: string): LogicalLine[] {
    const style = commentStyle(rel);
    const body = style === 'slash' ? src.replace(/\/\*[\s\S]*?\*\//g, ' ') : src;
    const physical = body.split('\n').map((l) => stripLineComment(l, style));
    const out: LogicalLine[] = [];
    let i = 0;
    while (i < physical.length) {
        const start = i;
        let text = physical[i];
        while (/\\[ \t]*$/.test(text) && i + 1 < physical.length) {
            text = `${text.replace(/\\[ \t]*$/, ' ')}${physical[i + 1]}`;
            i += 1;
        }
        out.push({ line: start + 1, text });
        i += 1;
    }
    return out;
}

/** One logical line split into the individual commands it runs. */
const commandSegments = (text: string) => text.split(/\s*(?:&&|\|\||[;|&])\s*/);

/**
 * Where a command can begin: start of segment, after whitespace or a shell
 * operator — or immediately after a QUOTE, which is how every one of these
 * commands is actually written in this repo (`sh -c 'apt-get …'`,
 * `bash -c "docker exec …"`). Leaving the quotes out of this class is not a
 * cosmetic miss: it drops `.github/actions/enable-pgvector/action.yml`, the
 * one site #833 did patch, out of the population entirely.
 */
const COMMAND_START = String.raw`(?:^|[\s;&|(\{'"\x60])`;

/** A word that is not a shell separator or a quote — e.g. a path component. */
const WORD = String.raw`[^\s;&|()'"\x60]`;

/**
 * An `apt-get`/`apt` invocation, however it is reached: bare, by absolute
 * path, or through a variable. `${GC} …` taught this lesson in another guard
 * on the same day — a command invoked through a variable is still a command —
 * so the variable form is accepted, narrowed to apt-shaped names so that an
 * unrelated `$FOO` in a line that happens to say "update" is not swept in.
 */
const APT_INVOCATION = new RegExp(
    `${COMMAND_START}(?:(?:${WORD}*\\/)?apt(?:-get)?\\b|\\$\\{?(?:APT|apt)[A-Za-z0-9_]*\\}?)`,
);

/** `apt-get … update`, i.e. a refresh of the package index. */
const isIndexUpdate = (segment: string) =>
    APT_INVOCATION.test(segment) && /\bupdate\b/.test(segment);

/**
 * A command executed INSIDE a running container.
 *
 * DEFEAT 3 LIVES HERE. The rejected guard tested `line.includes('docker
 * exec')`, and `docker compose exec` — the Compose v2 spelling this repo
 * migrated to — does not contain that substring. Accepted here: `docker exec`,
 * `docker compose exec`, `docker-compose exec`, any of those behind `sudo` or
 * an absolute path, `-f <file>.yml`/`--project-name x` between the two words,
 * and the whole thing reached through a variable.
 */
const CONTAINER_EXEC = new RegExp(
    `${COMMAND_START}(?:(?:${WORD}*\\/)?docker(?:-compose)?|\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?)` +
        `(?:\\s+(?:compose|-{1,2}[A-Za-z0-9][^\\s]*|[^\\s]+\\.ya?ml))*\\s+exec\\b`,
);

/** A `RUN` layer of a Dockerfile — including a heredoc'd one inside a script. */
const DOCKERFILE_RUN = /^\s*RUN\b/;

const runsInsideImage = (text: string) => DOCKERFILE_RUN.test(text) || CONTAINER_EXEC.test(text);

interface AptUpdate {
    readonly line: number;
    readonly command: string;
    readonly flagged: boolean;
}

/**
 * Every package-index refresh this source runs INSIDE the pinned image.
 *
 * The narrowing to `RUN`/exec is load-bearing rather than cosmetic.
 * `infra/scripts/restore-test-gcp.sh` also updates the package index to
 * install docker.io on the restore VM's own HOST, which is a different,
 * unfrozen suite and must NOT carry the flag — requiring it there would be a
 * false positive that teaches the next reader to relax an index that is
 * perfectly healthy.
 *
 * `flagged` is decided on the apt SEGMENT, not the line: `apt-get install -o
 * Acquire::Check-Valid-Until=false … && apt-get update` flags the install and
 * leaves the update bare, and the line-level question cannot tell those apart.
 */
function aptIndexUpdates(rel: string, src: string): AptUpdate[] {
    const found: AptUpdate[] = [];
    for (const { line, text } of logicalLines(rel, src)) {
        if (!runsInsideImage(text)) continue;
        for (const segment of commandSegments(text)) {
            if (!isIndexUpdate(segment)) continue;
            found.push({ line, command: segment.trim(), flagged: segment.includes(STOPGAP_FLAG) });
        }
    }
    return found;
}

/** The finding list Direction B asserts is empty. One string per defect. */
const unflaggedUpdates = (rel: string, src: string) =>
    aptIndexUpdates(rel, src)
        .filter((u) => !u.flagged)
        .map((u) => `${rel}:${u.line}: ${u.command}`);

/* ── The compose side of the pin, derived once ─────────────────────────────
 *
 * Two directions need it. D needs the LOCAL image names that compose publishes
 * for builds of the pinned Dockerfile; B needs those same names to decide
 * whether a file works against the pinned image, because `FROM
 * agri-saas-postgres:<tag>-pgvector` is that image just as surely as a
 * `postgis/postgis` reference is.
 *
 * PARSED, NOT PATTERN-MATCHED — and that is a correction, not a preference.
 * An earlier revision found the `build:` key by regex and then scanned FORWARD
 * for a sibling `image:`. `image:` written ABOVE `build:` is YAML-identical and
 * entirely idiomatic Compose, and it dropped the service out of the population
 * with every assertion still green. js-yaml hands back a mapping, in which
 * order does not exist. It also picks up the `build: <dir>` shorthand and
 * resolves `dockerfile:` relative to `context:` the way Compose does.
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
 * publishes and how many of those ENCODE a version. REACH control, NOT the
 * population.
 *
 * The per-site `encoded` counts are the whole point. A global "at least one
 * tag encodes a version" floor is satisfied by the OTHER site when one drops
 * out of view, which is exactly how a site goes missing unnoticed.
 * `agrent-db:local` encodes no version and is registered at zero — correct,
 * and still required to be SEEN rather than tolerated by its absence.
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

/* ── Direction C's shape, as a function so it can be given a defect ────────
 *
 * DEFEAT 4 LIVES HERE. The rejected guard wrote
 * `expect(src).not.toMatch(/ancestor=[^\n]*\|\s*head\s+-1/)` — a blacklist of
 * ONE spelling, walked past by `head -n 1`, `sed -n 1p`, `awk NR==1`,
 * `tail -1`, `grep -m1` and anything else anyone invents.
 *
 * Nothing is blacklisted here. The SHAPE is asserted positively: the lookup
 * fills an array in a single stage, the array's length is compared against
 * both 0 and >1, and the container id is read out of that same array. Any
 * truncation, whatever its spelling, has to appear as a second stage in the
 * producer, and every spelling of a second stage is a pipe.
 */
function containerSelectionDefects(src: string): string[] {
    const problems: string[] = [];
    const fill = src.match(
        /\b(?:mapfile|readarray)\b[^\n]*?-t\s+([A-Za-z_][A-Za-z0-9_]*)[^\n]*?<\s*<\(([^\n]*)\)/,
    );
    if (fill === null) {
        problems.push(
            'no array-valued container lookup: the selection must be read into an array ' +
                '(mapfile/readarray) so that "no container" and "two containers" stay distinguishable',
        );
        return problems;
    }
    const [, array, producer] = fill;
    if (!/docker\s+ps[^\n]*ancestor=/.test(producer)) {
        problems.push(`the array is not filled from a \`docker ps --filter ancestor=\` lookup: ${producer}`);
    }
    if (producer.includes('|')) {
        problems.push(
            `the lookup is piped through a second stage, so the count below can no longer ` +
                `tell one container from several: ${producer.trim()}`,
        );
    }
    if (!new RegExp(String.raw`\$\{#${array}\[@\]\}"?\s*-eq\s+0`).test(src)) {
        problems.push(`no zero-match branch on \${#${array}[@]} — an empty selection would flow on unnoticed`);
    }
    if (!new RegExp(String.raw`\$\{#${array}\[@\]\}"?\s*-gt\s+1`).test(src)) {
        problems.push(`no more-than-one branch on \${#${array}[@]} — the step would silently guess`);
    }
    if (!new RegExp(String.raw`\$\{${array}\[0\]\}`).test(src)) {
        problems.push(`the container id is not taken from the counted array \${${array}[0]}`);
    }
    return problems;
}

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

        it('the scan reached a real population (reach control)', () => {
            // `git ls-files` returning nothing, or the regex silently failing
            // to compile against real content, would make the next assertion
            // vacuously true — the classic empty-selection pass. The floor is
            // the point: a scan root that resolves to nothing makes every
            // verdict over it green.
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
            // The owner file's header is an EXACT enumeration, and prose that
            // counts is prose that can drift off by one. (It did, twice: the
            // file once claimed nine and eight at the same time, and it was
            // still claiming nine after a tenth literal appeared in
            // docs/dev-setup-macos.md.) Tie the number to the tree so the
            // claim cannot rot silently, and so a genuinely new literal has to
            // be registered rather than quietly enlarging a sentence nobody
            // re-reads.
            const live = occurrences.filter((o) => !isHistorical(o.rel));
            expect(NUMBER_WORDS[DECLARED_LITERALS.count]).toBe(DECLARED_LITERALS.word);
            expect(REQUIRED_SITES.reduce((n, s) => n + s.count, 0)).toBe(DECLARED_LITERALS.count);
            expect(live).toHaveLength(DECLARED_LITERALS.count);

            // EVERY sentence that states the count, not just the one a
            // substring match happened to land on.
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

    describe('B. every site that refreshes the index inside the image keeps the stopgap', () => {
        /**
         * B'S POPULATION IS DERIVED, NOT LISTED.
         *
         * A hardcoded three-item list here would have exactly the defect this
         * guard exists to attack: adding a fourth Dockerfile with the pinned
         * `FROM` and an unflagged index update would pass every test, because
         * the new file was not on the list. That is the #833 recurrence shape
         * verbatim, so B scans the way A does.
         *
         * A file is IN the population when it BOTH
         *   (a) works against the pinned image — it carries the literal, or it
         *       derives the pin from the owner file (the action holds no
         *       literal at all, by Direction C, so matching the literal alone
         *       would miss the one site #833 did patch), or it names one of
         *       the LOCAL tags compose publishes for a build of the pinned
         *       Dockerfile, AND
         *   (b) refreshes the index inside that image, by `aptIndexUpdates`.
         *
         * WHAT THIS FILE ITSELF DOES IN THAT SCAN. Nothing, and not by
         * exemption — it is scanned like everything else. It qualifies under
         * (a) (it names the owner file) and fails (b): its own comment syntax
         * is `//`, which `commentStyle` strips before anything is matched, so
         * the commands quoted in these comments are not commands. That is a
         * real property of the scanner, not a coincidence of wording, and it
         * is the reason the rejected guard's "keep the two spellings on
         * separate lines" note is gone.
         */
        const usesPinnedImage = (src: string) =>
            HAS_IMAGE_REF.test(src) ||
            src.includes(PIN_BASENAME) ||
            LOCAL_PINNED_TAGS.some((tag) => src.includes(tag));

        const aptSites = trackedFiles()
            .filter((rel) => rel !== PIN_FILE && !isHistorical(rel))
            .filter((rel) => {
                const src = tryRead(rel);
                return src !== null && usesPinnedImage(src) && aptIndexUpdates(rel, src).length > 0;
            });

        it('the derived population is non-empty and holds every known site (reach control)', () => {
            // Narrowing a selector is the standard way a guard goes vacuous:
            // an over-tight predicate, or a `usesPinnedImage` that stopped
            // recognising the derivation, would select nothing and the flag
            // assertion below would pass by examining zero lines.
            expect(aptSites.length).toBeGreaterThanOrEqual(REQUIRED_APT_SITES.length);
            expect(aptSites).toEqual(expect.arrayContaining([...REQUIRED_APT_SITES]));

            // And the local-name recogniser specifically: it is DERIVED from
            // the compose parse, so if that returned nothing B would quietly
            // stop seeing a whole class of site while still passing the two
            // assertions above on the strength of its other two recognisers.
            expect(LOCAL_PINNED_TAGS.length).toBeGreaterThanOrEqual(2);
            for (const tag of LOCAL_PINNED_TAGS) expect(usesPinnedImage(`FROM ${tag}`)).toBe(true);
        });

        it.each(REQUIRED_APT_SITES)('%s refreshes the index inside the image (reach control)', (rel) => {
            expect(aptIndexUpdates(rel, read(rel)).length).toBeGreaterThanOrEqual(1);
        });

        it('every derived site carries the flag INSIDE the apt invocation', () => {
            // Reported as a LIST rather than per-site, so a brand-new site
            // nobody thought to register still names itself in the failure.
            const unflagged = aptSites.flatMap((rel) => unflaggedUpdates(rel, read(rel)));
            expect(unflagged).toEqual([]);
        });

        it.each(REQUIRED_APT_SITES)('%s passes the flag as an apt option, not as prose', (rel) => {
            // `-o Acquire::Check-Valid-Until=false` is the only form that
            // changes apt's behaviour. The mere presence of the string is
            // exactly what defeat 1 exploited.
            const updates = aptIndexUpdates(rel, read(rel));
            expect(updates.filter((u) => STOPGAP_OPTION.test(u.command)).length).toBeGreaterThanOrEqual(1);
        });

        /* ── TEETH CONTROLS ───────────────────────────────────────────────
         *
         * Everything above proves the scan reached the right files. None of
         * it proves the verdict has teeth, and a guard that is green either
         * way is the whole defect class. So: take each real site's REAL
         * source, inject the real defect into it in memory, and require the
         * SAME function the live assertion calls to report it.
         *
         * Derived from the live input on purpose. A control built on a
         * fixture — `unflaggedUpdates('x', 'RUN apt-get update')` — proves
         * only that a string it invented is matched by a pattern it chose,
         * and a one-line change to the predicate walks straight past it while
         * the control stays green. That happened, on this same defect class,
         * on the day this file was written.
         */

        it.each(REQUIRED_APT_SITES)('%s: dropping the flag is REPORTED (teeth control)', (rel) => {
            const real = read(rel);
            const broken = withoutFlagOption(real);
            // The injection actually happened.
            expect(broken).not.toBe(real);

            expect(unflaggedUpdates(rel, real)).toEqual([]);
            expect(unflaggedUpdates(rel, broken).length).toBeGreaterThanOrEqual(1);
        });

        it.each(REQUIRED_APT_SITES)(
            '%s: the flag moved into a trailing comment is REPORTED (teeth control, defeat 1)',
            (rel) => {
                const broken = withoutFlagOption(read(rel));
                // Put the flag's TEXT back, as a trailing comment, on the very
                // physical line the finding names — the mutation that left the
                // rejected guard 32/32 green with the build broken. The line is
                // taken from the finding rather than searched for, so the
                // comment cannot land on some other line that merely mentions
                // apt and leave this control passing for the wrong reason.
                const finding = aptIndexUpdates(rel, broken).find((u) => !u.flagged);
                expect(finding).toBeDefined();
                const idx = (finding as AptUpdate).line - 1;
                const lines = broken.split('\n');
                lines[idx] = `${lines[idx]}  # FIXME(#832): ${STOPGAP_FLAG} dropped pending base bump`;
                const commented = lines.join('\n');

                // A whole-line `includes(FLAG)` would be satisfied by this.
                expect(commented.split('\n')[idx]).toContain(STOPGAP_FLAG);
                expect(unflaggedUpdates(rel, commented).length).toBeGreaterThanOrEqual(1);
            },
        );

        it.each(['deploy/postgres/Dockerfile', 'infra/scripts/restore-test-gcp.sh'])(
            '%s: apt-get moved onto a RUN continuation is REPORTED (teeth control, defeat 2)',
            (rel) => {
                const real = read(rel);
                const broken = withoutFlagOption(real).replace(
                    /^([ \t]*)RUN[ \t]+/m,
                    '$1RUN set -eux \\\n    && ',
                );
                expect(broken).not.toBe(real);

                // The defeat, pinned: no PHYSICAL line now both starts with
                // RUN and carries the index update, so the rejected guard's
                // per-line predicate selects nothing here.
                const physicallyVisible = broken
                    .split('\n')
                    .filter((l) => /^\s*RUN\b/.test(l) && /\bapt(?:-get)?\b[^\n]*\bupdate\b/.test(l));
                expect(physicallyVisible).toEqual([]);

                expect(unflaggedUpdates(rel, broken).length).toBeGreaterThanOrEqual(1);
            },
        );

        it.each([
            'docker compose exec',
            'docker-compose exec',
            'docker compose -f deploy/docker-compose.vm.yml exec',
            'sudo docker compose exec',
            '${DOCKER} exec',
        ])('an unflagged index refresh through `%s` is REPORTED (teeth control, defeat 3)', (spelling) => {
            const real = read(ACTION);
            const broken = withoutFlagOption(real).replace(/\bdocker exec\b/, spelling);
            // The v1 spelling is GONE, so a finding can only come from
            // recognising the spelling under test.
            expect(broken).not.toContain('docker exec');
            expect(broken).not.toBe(real);

            expect(unflaggedUpdates(ACTION, broken).length).toBeGreaterThanOrEqual(1);
        });

        it('the host-side index refresh in the restore drill stays OUT of the population', () => {
            // The other direction of teeth: this scan must not demand the flag
            // where the suite is healthy. `apt-get update` installing
            // docker.io on the restore VM's own host is a different index, and
            // flagging it would teach the next reader to relax a working one.
            const rel = 'infra/scripts/restore-test-gcp.sh';
            const src = read(rel);
            const hostRefresh = src
                .split('\n')
                .findIndex((l) => /^apt-get\s+update/.test(l));
            expect(hostRefresh).toBeGreaterThanOrEqual(0);
            expect(aptIndexUpdates(rel, src).map((u) => u.line)).not.toContain(hostRefresh + 1);
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

    describe('C. the ancestor lookup derives, restates nothing, and counts', () => {
        const src = read(ACTION);

        it('actually READS the owner file', () => {
            // Reach control for the absence check below: an action that had
            // dropped the derivation entirely would also hold no literal, and
            // would pass "no site disagrees" by having nothing to compare.
            //
            // A `toContain('postgis-image')` is NOT enough, and that is not a
            // hypothetical — it was this guard's first draft, and pointing
            // `pin_file` at /dev/null left every test green, because the word
            // survives in the comments that explain the derivation. Match the
            // ASSIGNMENT and the READ.
            expect(src).toMatch(
                /pin_file="\$\{GITHUB_ACTION_PATH\}\/\.\.\/\.\.\/postgis-image"/,
            );
            expect(src).toMatch(/image="\$\(grep[^\n]*"\$pin_file"/);
            expect(src).toMatch(/docker ps --filter "ancestor=\$\{image\}"/);
        });

        it('holds no image literal of its own', () => {
            // The trap this guard exists for. A literal here is a copy that no
            // `image:` line drags along when the pin moves, and its failure
            // mode is a filter that matches nothing.
            expect(src.match(IMAGE_REF) ?? []).toEqual([]);
        });

        it('selects the container by counting, in one stage', () => {
            expect(containerSelectionDefects(src)).toEqual([]);
        });

        it.each([
            '| head -1',
            '| head -n 1',
            '| sed -n 1p',
            '| awk NR==1',
            '| tail -n 1',
            '| grep -m1 .',
        ])('a `%s` on the lookup is REPORTED (teeth control, defeat 4)', (truncation) => {
            // Derived from the REAL statement: take the action's own array
            // fill and give it a second stage. No spelling is blacklisted, so
            // the list above is illustrative rather than load-bearing — any
            // truncation is a pipe, and a pipe is what fails.
            const fill = src.match(/^[^\n]*\b(?:mapfile|readarray)\b[^\n]*$/m);
            expect(fill).not.toBeNull();
            const truncated = (fill as RegExpMatchArray)[0].replace(/\)\s*$/, ` ${truncation})`);
            const broken = src.replace((fill as RegExpMatchArray)[0], truncated);
            expect(broken).not.toBe(src);

            expect(containerSelectionDefects(broken).length).toBeGreaterThanOrEqual(1);
        });

        it('losing either count branch is REPORTED (teeth control)', () => {
            // The count is only worth asserting if BOTH ends of it are. The
            // patterns anchor on the array-length expansion itself, so the
            // edit cannot land on some unrelated `-eq 0` elsewhere in the file
            // and leave this passing while the real branch stands.
            const LENGTH = String.raw`(\$\{#[A-Za-z_][A-Za-z0-9_]*\[@\]\}"?\s*)`;
            for (const branch of [String.raw`${LENGTH}-eq\s+0`, String.raw`${LENGTH}-gt\s+1`]) {
                const broken = src.replace(new RegExp(branch), '$1-eq 12345');
                expect(broken).not.toBe(src);
                expect(containerSelectionDefects(broken).length).toBeGreaterThanOrEqual(1);
            }
        });

        it('replacing the array with a single-value capture is REPORTED (teeth control)', () => {
            // The `cid="$(docker ps … | head -1)"` shape this step used to
            // have: no array, so nothing to count.
            const broken = src.replace(/^[^\n]*\b(?:mapfile|readarray)\b[^\n]*$/m, '        cid="$(docker ps --filter "ancestor=${image}" --format \'{{.ID}}\' | head -1)"');
            expect(broken).not.toBe(src);
            expect(containerSelectionDefects(broken).length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('D. a local tag that encodes the pin encodes the CURRENT pin', () => {
        /**
         * `docker-compose.yml` and `docker-compose.test.yml` build
         * `deploy/postgres/Dockerfile` and publish the result as
         * `agri-saas-postgres:16-3.4-pgvector`. That `16-3.4` IS the pin,
         * spelled a second way — but the name is local, so Direction A's
         * regex cannot see it. Bump the owner and those two lines keep
         * claiming the old version with CI green.
         *
         * Derived, not listed, for the same reason B is — see the parse block
         * at the top of this file for HOW, and for the key-order hole that
         * made a hand-rolled walk the wrong tool for the job.
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

        it('every YAML that could hold a build site actually parsed (reach control)', () => {
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

        it('the build-site scan found every compose file that builds the pin (reach control)', () => {
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

        it('the version-encoding population is non-empty and per-site complete (reach control)', () => {
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

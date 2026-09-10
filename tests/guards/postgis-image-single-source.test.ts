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
 *      way, inside a name A's `postgis/postgis:` regex cannot see.
 *
 * This is a SOURCE-TEXT guard (CLAUDE.md, "Green is not the same as
 * executed"): it proves the strings agree and never starts a container.
 * Every assertion is paired with a POSITIVE CONTROL on its own population,
 * because an empty scan satisfies "no site disagrees" perfectly.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
            expect(REQUIRED_SITES.reduce((n, s) => n + s.count, 0)).toBe(DECLARED_LITERALS.count);
            expect(live).toHaveLength(DECLARED_LITERALS.count);
            expect(read(PIN_FILE)).toContain(`${DECLARED_LITERALS.word} literals`);
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
         *       would miss the one site #833 did patch), AND
         *   (b) runs the index update inside that image, by `inImage` above.
         *
         * Like Direction A, this scan does not exempt the guard's own file.
         * It simply does not match: no line here is a Dockerfile `RUN`, and
         * no single line pairs a container-exec with an index update. An
         * earlier draft of THIS comment did pair them, and the scan duly
         * reported this file as an unflagged site — the derivation working
         * exactly as intended. Keep the two spellings on separate lines.
         */
        const usesPinnedImage = (src: string) => HAS_IMAGE_REF.test(src) || src.includes(PIN_BASENAME);

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
         * Derived, not listed, for the same reason B is. The population is
         * every compose service that BUILDS the pinned Dockerfile, found by
         * either the explicit `dockerfile:` key or a `context:` pointing at
         * the directory that holds it — `deploy/docker-compose.vm.yml` uses
         * the second shape, and a list written from the first would have
         * missed it.
         */
        const BUILDS_PIN: readonly RegExp[] = [
            /^\s*dockerfile:\s*deploy\/postgres\/Dockerfile\s*$/,
            /^\s*context:\s*\.?\/?deploy\/postgres\/?\s*$/,
        ];

        const indentOf = (line: string) => (line.match(/^\s*/) ?? [''])[0].length;

        /**
         * The `image:` values a build service publishes. `image:` is a
         * SIBLING of `build:`, so walk out to the `build:` key's indent and
         * read the sibling keys until the block dedents — rather than
         * grabbing the file's `image:` lines at large, most of which belong
         * to unrelated services (pgbouncer, redis, caddy, watchtower).
         */
        function publishedTags(rel: string): string[] {
            const lines = (tryRead(rel) ?? '').split('\n');
            const out: string[] = [];
            for (let i = 0; i < lines.length; i++) {
                if (!BUILDS_PIN.some((re) => re.test(lines[i]))) continue;
                let j = i;
                while (j >= 0 && !(/^\s*build:\s*$/.test(lines[j]) && indentOf(lines[j]) < indentOf(lines[i]))) j--;
                if (j < 0) continue; // a `dockerfile:`/`context:` outside any build block
                const keyIndent = indentOf(lines[j]);
                for (let k = j + 1; k < lines.length; k++) {
                    const line = lines[k];
                    if (line.trim() === '' || line.trim().startsWith('#')) continue;
                    if (indentOf(line) < keyIndent) break;
                    if (indentOf(line) !== keyIndent) continue;
                    const m = line.match(/^\s*image:\s*(\S+)/);
                    if (m) out.push(m[1]);
                }
            }
            return [...new Set(out)];
        }

        /** `16-3.4` inside `agri-saas-postgres:16-3.4-pgvector`. */
        const VERSION_TOKEN = /\d+-\d+(?:\.\d+)*/;
        const pinTag = pin.split(':')[1] ?? '';

        const buildSites = trackedFiles().filter((rel) => {
            const src = tryRead(rel);
            return src !== null && src.split('\n').some((line) => BUILDS_PIN.some((re) => re.test(line)));
        });

        const encoded = buildSites.flatMap((rel) =>
            publishedTags(rel)
                .map((ref) => ({ rel, ref, version: (ref.split(':').pop() ?? '').match(VERSION_TOKEN)?.[0] }))
                .filter((e): e is { rel: string; ref: string; version: string } => e.version !== undefined),
        );

        it('the build-site scan found every compose file that builds the pin (positive control)', () => {
            expect(buildSites).toEqual(
                expect.arrayContaining([
                    'docker-compose.yml',
                    'docker-compose.test.yml',
                    'deploy/docker-compose.vm.yml',
                ]),
            );
        });

        it('at least one published tag actually encodes a version (positive control)', () => {
            // The emptiness trap, and a live one: `agrent-db:local` encodes
            // no version at all, so a block walker that silently returned
            // nothing would look identical to "every tag is fine". Assert
            // the selection is non-empty before trusting the verdict below.
            expect(encoded.length).toBeGreaterThanOrEqual(1);
            expect(pinTag).toMatch(VERSION_TOKEN);
        });

        it('no published tag encodes a version other than the owner’s', () => {
            const stale = encoded.filter((e) => e.version !== pinTag).map((e) => `${e.rel}: ${e.ref}`);
            expect(stale).toEqual([]);
        });
    });
});

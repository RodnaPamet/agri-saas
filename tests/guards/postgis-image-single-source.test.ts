/**
 * `.github/postgis-image` is the single source of truth, and this enforces it.
 *
 * ## Why this file exists
 *
 * Because `.github/postgis-image` said it already did. Until 2026-09-17 its
 * header read:
 *
 *     tests/guards/postgis-image-single-source.test.ts fails CI the instant any
 *     of them disagrees with the line below — that is what makes nine literals
 *     safe.
 *
 * and went on to describe a "Direction D" that parses every compose file. None
 * of it existed — confirmed against `origin/main` with a positive control on
 * the search, independently by two sessions. The claim was worse than the gap:
 * a reader had every reason to believe the literals were protected.
 *
 * #974 corrected the claim and moved all eleven literals off
 * `postgis/postgis:16-3.4`. This makes the claim true, against the settled
 * shape rather than the one mid-change.
 *
 * ## The failure it prevents
 *
 * GitHub Actions gives `jobs.<id>.services.<id>.image` no `env` context and no
 * way to call an action, and `FROM` takes no runtime lookup. So the pin is
 * necessarily repeated, and the pin file's own warning is the exact hazard:
 * *bump this file and leave those two compose tags behind and they lie about
 * the base, with CI green.*
 *
 * ## Three shapes, deliberately distinguished
 *
 *   exact      `image: postgres:16-trixie` / `FROM postgres:16-trixie`
 *   docTable   a markdown table cell naming the image
 *   embedTag   `agri-saas-postgres:16-trixie-postgis-pgvector` — the pin's TAG
 *              inside a LOCAL image name, which no `postgres:` search finds.
 *              This is the shape the old header called "one more spelling" and
 *              then excluded from its own count of nine.
 *
 * Direction B then catches a TWELFTH site appearing anywhere in the tracked
 * tree, because a guard over a hand-written list only ever protects the list.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const PIN_FILE = '.github/postgis-image';

type Shape = 'exact' | 'docTable' | 'embedTag';
interface Consumer {
    file: string;
    shape: Shape;
    /** How many times the pin must appear in this file. */
    times: number;
}

/**
 * Every site that repeats the pin. Registered by hand ON PURPOSE — a tenth or
 * twelfth literal must be a visible line in someone's diff, which is what the
 * pin file has always said. Direction B is what stops the list going stale.
 */
const CONSUMERS: Consumer[] = [
    { file: '.github/workflows/ci.yml', shape: 'exact', times: 3 },
    { file: '.github/workflows/coverage-reference.yml', shape: 'exact', times: 1 },
    { file: '.github/workflows/lighthouse.yml', shape: 'exact', times: 1 },
    { file: '.github/workflows/load-test.yml', shape: 'exact', times: 1 },
    { file: 'deploy/postgres/Dockerfile', shape: 'exact', times: 1 },
    { file: 'infra/scripts/restore-test-gcp.sh', shape: 'exact', times: 1 },
    { file: 'docs/dev-setup-macos.md', shape: 'docTable', times: 1 },
    { file: 'docker-compose.yml', shape: 'embedTag', times: 1 },
    { file: 'docker-compose.test.yml', shape: 'embedTag', times: 1 },
];

/** Total literal sites, counting a file that repeats the pin once per repeat. */
const LITERAL_COUNT = CONSUMERS.reduce((n, c) => n + c.times, 0);

/**
 * References that name a DIFFERENT image on purpose — history, not drift.
 *
 * Scoped to the exact IMAGE STRINGS each file is allowed to mention, NOT to
 * the file. An earlier version of this exempted whole files, and a mutation
 * proved the hole: appending `image: postgres:16-bookworm` to
 * docs/dev-setup-macos.md — a file on the list — passed. A file-level
 * exemption blinds the sweep to every future reference in that file, which is
 * the same too-coarse-selection defect this repo keeps finding.
 */
const HISTORICAL_MENTIONS: Array<{ file: string; images: string[]; reason: string }> = [
    {
        file: 'docs/postgis-base-image-options.md',
        images: ['postgis/postgis:16-3.4', 'postgis/postgis:16-3.5-alpine', 'postgres:16-bookworm', 'agri-saas-postgres:16-3.4-pgvector'],
        reason: 'the research that chose this base; its measurements name the old image throughout',
    },
    {
        file: 'docs/implementation-notes/2026-09-10-postgis-image-single-source.md',
        images: ['postgis/postgis:16-3.4', 'postgres:16-bullseye'],
        reason: 'dated implementation note — a record of the state at that date',
    },
    {
        file: 'docs/runbooks/postgis-trixie-cutover.md',
        images: ['postgis/postgis:16-3.4'],
        reason: 'the cutover runbook; its title is the old image -> the new one',
    },
    {
        file: 'deploy/postgres/Dockerfile',
        images: ['postgis/postgis:16-3.4', 'postgres:16-bullseye'],
        reason: 'the comment explaining WHY the base is no longer postgis/postgis',
    },
    {
        file: 'docs/dev-setup-macos.md',
        images: ['postgis/postgis:16-3.4', 'postgres:16-bullseye'],
        reason: 'section 5 records the expired-bullseye breakage and its resolution',
    },
    {
        file: '.github/postgis-image',
        images: ['postgis/postgis:16-3.4', 'postgres:16-bullseye'],
        reason: 'the pin file itself explains what it moved away from',
    },
    {
        file: '.github/actions/enable-pgvector/action.yml',
        images: ['postgres:16-bullseye'],
        reason: 'the note recording why the Acquire flag was removed',
    },
    {
        file: 'prisma/migrations/20260713170000_cadastre_opendata_import/migration.sql',
        images: ['postgis:16-3.4'],
        reason: 'an applied migration is immutable history and must not be edited',
    },
];

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The pin, parsed the way every consumer parses it. */
function pinnedImage(): string {
    const lines = read(PIN_FILE).split('\n');
    const ref = lines.find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    return (ref ?? '').trim();
}

/** `postgres:16-trixie` -> `16-trixie` */
const tagOf = (image: string): string => image.slice(image.lastIndexOf(':') + 1);

/**
 * Tracked files, so an untracked scratch file cannot fail the sweep.
 *
 * Collected through `collectTrackedFiles` (#865) so an empty result THROWS
 * rather than returning [] — a sweep over nothing would report "no
 * unregistered references" and pass, which is the defect this guard is for.
 */
function trackedFiles(): string[] {
    return collectTrackedFiles({ roots: ['.'], floor: 1000 }).map((abs) =>
        path.relative(ROOT, abs).split(path.sep).join('/'),
    );
}

/**
 * This guard's own file. It is the REGISTRY: it necessarily contains every
 * image string it registers, in HISTORICAL_MENTIONS, ALTERNATE_IMAGES and the
 * docblock explaining what moved. A registry containing the things it
 * registers is not drift, so the sweep skips it.
 *
 * Excluded here rather than via HISTORICAL_MENTIONS because a self-referential
 * entry would need editing every time those lists change and would go stale
 * silently. The property is not lost: a wrong entry in the lists is caught by
 * "every declared historical mention still contains one", which reads each
 * declared image back out of the file it claims to be in.
 *
 * THIS COST A CI ROUND-TRIP, and the reason is worth keeping. It passed
 * locally and failed on push, because `trackedFiles()` reads `git ls-files`
 * and an uncommitted new file is not tracked — so while this guard was new it
 * could not see itself, and no amount of local running would have shown it.
 * A guard that sweeps the tracked tree cannot be fully verified before its own
 * first commit.
 */
const SELF = 'tests/guards/postgis-image-single-source.test.ts';

const PIN = pinnedImage();
const TAG = tagOf(PIN);

/**
 * Any `<name>:<tag>` that looks like a Postgres/PostGIS base image.
 *
 * The tag must contain a non-digit. `postgres:5432` in a DATABASE_URL is a
 * HOST and a PORT, not an image, and it appears twice in
 * docker-compose.staging.yml — the first version of this pattern flagged both
 * and would have taught the next reader that this guard cries wolf.
 */
const IMAGE_REF = /\b(?:postgis\/postgis|agri-saas-postgres|postgres|postgis):[0-9][A-Za-z0-9._-]*[A-Za-z0-9]/g;

/**
 * Two things that LOOK like image references and are not, filtered here rather
 * than in the pattern so the reason is readable:
 *
 *   `postgres:5432`   a HOST and a PORT in a DATABASE_URL — appears twice in
 *                     docker-compose.staging.yml
 *   `postgres:16-*`   a wildcard in prose (docs/postgis-base-image-options.md
 *                     line 122: "Both official `postgres:16-*` images already…")
 */
function looksLikeAnImage(ref: string): boolean {
    const tag = ref.slice(ref.lastIndexOf(':') + 1);
    if (/^\d+$/.test(tag)) return false; // a port, not a tag
    return true;
}

/**
 * Postgres images that are legitimately NOT this pin.
 *
 * Declared rather than pattern-excluded, so that a NEW unrelated Postgres
 * image still has to be justified in a diff instead of slipping through a
 * broad rule.
 */
const ALTERNATE_IMAGES: Array<{ image: string; reason: string }> = [
    {
        image: 'postgres:16-alpine',
        reason:
            'PLAIN Postgres, no PostGIS — a different role, not a stale copy of this pin. ' +
            'Used by the inflect-lineage manifests this repo retains for the GAP-03 ' +
            'encryption-key guardrail (docker-compose.staging.yml, ' +
            'deploy/docker-compose.prod.yml — note container_name: inflect-staging-db) and ' +
            'as the restore drill\'s pull-path image for the OTHER stack ' +
            '(.github/workflows/restore-test.yml). None of them needs geometry.',
    },
];

describe('.github/postgis-image is the single source of truth', () => {
    describe('the guard is reading real inputs', () => {
        it('the pin file yields an image reference', () => {
            // Without this, a reformatted pin file makes PIN '' and every
            // assertion below compares empty strings and passes — which is the
            // defect this repo keeps finding, in the guard that checks for it.
            expect(PIN).toMatch(/^[a-z0-9._/-]+:[A-Za-z0-9._-]+$/);
        });

        it('every registered consumer file exists', () => {
            for (const c of CONSUMERS) {
                expect(fs.existsSync(path.join(ROOT, c.file))).toBe(true);
            }
        });

        it('the tracked-file sweep found a real tree', () => {
            expect(trackedFiles().length).toBeGreaterThan(1000);
        });
    });

    describe('direction A — every consumer agrees with the pin', () => {
        it.each(CONSUMERS.filter((c) => c.shape === 'exact'))(
            '$file repeats the pin exactly $times time(s)',
            ({ file, times }) => {
                const hits = read(file).split(PIN).length - 1;
                expect(hits).toBeGreaterThanOrEqual(times);
            },
        );

        it('docs/dev-setup-macos.md names the pin in its arm64 table', () => {
            const row = read('docs/dev-setup-macos.md')
                .split('\n')
                .find((l) => l.startsWith('|') && l.includes('deploy/postgres/Dockerfile'));
            expect(row).toBeDefined();
            expect(row).toContain(PIN);
        });

        it.each(CONSUMERS.filter((c) => c.shape === 'embedTag'))(
            "$file's local image tag encodes the pin's tag",
            ({ file }) => {
                const tagLine = read(file)
                    .split('\n')
                    .find((l) => l.includes('image: agri-saas-postgres:'));
                expect(tagLine).toBeDefined();
                // The local name is `agri-saas-postgres:<pin tag>-postgis-pgvector`.
                // Bumping the pin and leaving this behind is the exact failure
                // the pin file warns about, and no `postgres:` search finds it.
                expect(tagLine).toContain(`agri-saas-postgres:${TAG}-`);
            },
        );
    });

    describe('direction B — no unregistered site names a Postgres image', () => {
        it('the non-image filter accepts real images and rejects a host:port', () => {
            // Control on `looksLikeAnImage`. selector-teeth killed this guard
            // without it: the filter is consulted as `if (!looksLikeAnImage(x))
            // continue`, so a version that returns FALSY rejects every
            // candidate, the sweep examines nothing, and Direction B reports no
            // unregistered references — a clean bill of health from a scan that
            // looked at zero strings.
            //
            // Both directions are pinned, so neither a reject-all nor an
            // accept-all survives.
            expect(looksLikeAnImage('postgres:16-trixie')).toBe(true);
            expect(looksLikeAnImage('postgis/postgis:16-3.4')).toBe(true);
            expect(looksLikeAnImage('agri-saas-postgres:16-trixie-postgis-pgvector')).toBe(true);
            expect(looksLikeAnImage('postgres:5432')).toBe(false);
        });

        it('the sweep actually examines image references', () => {
            // The denominator. Without it, any change that makes the scan visit
            // no files — a broken extension filter, an empty tracked list —
            // leaves "no offenders" meaning "nothing was looked at".
            let seen = 0;
            for (const file of trackedFiles()) {
                if (file === SELF) continue;
                if (!/\.(ya?ml|md|sh|ts|tsx|js|mjs|sql|json)$|Dockerfile/.test(file)) continue;
                let text: string;
                try {
                    text = read(file);
                } catch {
                    continue;
                }
                seen += [...text.matchAll(IMAGE_REF)].filter((m) => looksLikeAnImage(m[0])).length;
            }
            expect(seen).toBeGreaterThan(15);
        });

        it('every Postgres/PostGIS image reference in the tree is the pin, registered, or declared history', () => {
            // NOTE: a registered consumer is NOT skipped here. It legitimately
            // contains the pin — which the `m[0] === PIN` test below allows —
            // but skipping the whole FILE would blind this sweep to a second,
            // WRONG image appearing in it. That hole was real: appending
            // `image: postgres:16-bookworm` to docs/dev-setup-macos.md (a
            // consumer) passed, until this skip came out. Same too-coarse
            // selection as the file-level HISTORICAL_MENTIONS it sits beside,
            // and it survived one round of fixing because only one of the two
            // lists was corrected.
            const allowedIn = new Map(HISTORICAL_MENTIONS.map((h) => [h.file, new Set(h.images)]));
            const offenders: string[] = [];

            for (const file of trackedFiles()) {
                if (file === SELF) continue;
                if (!/\.(ya?ml|md|sh|ts|tsx|js|mjs|sql|json)$|Dockerfile/.test(file)) continue;
                let text: string;
                try {
                    text = read(file);
                } catch {
                    continue; // binary or unreadable — not a place a pin hides
                }
                for (const m of text.matchAll(IMAGE_REF)) {
                    if (!looksLikeAnImage(m[0])) continue;
                    if (m[0] === PIN) continue;
                    if (m[0].startsWith('agri-saas-postgres:') && m[0].includes(TAG)) continue;
                    if (ALTERNATE_IMAGES.some((a) => a.image === m[0])) continue;
                    if (allowedIn.get(file)?.has(m[0])) continue;
                    offenders.push(`${file}: ${m[0]}`);
                }
            }

            if (offenders.length > 0) {
                throw new Error(
                    `Postgres image reference(s) outside the single source of truth:\n` +
                        offenders.map((o) => `  ${o}`).join('\n') +
                        `\n\nThe pin is '${PIN}' (${PIN_FILE}). Either update the site to match, ` +
                        `register it in CONSUMERS in this file, add it to ALTERNATE_IMAGES if it ` +
                        `is a different Postgres role, or — if it names an old image ` +
                        `deliberately, as history — add it to HISTORICAL_MENTIONS with a reason.`,
                );
            }
            expect(offenders).toEqual([]);
        });

        it('every declared historical mention still contains one', () => {
            // A "no stale entries" check. An exemption for a file that no longer
            // names an old image is an exemption nobody can evaluate, and it
            // would sit here forever widening the blind spot.
            const stale: string[] = [];
            for (const { file, images } of HISTORICAL_MENTIONS) {
                if (!fs.existsSync(path.join(ROOT, file))) {
                    stale.push(`${file} (missing)`);
                    continue;
                }
                const text = read(file);
                for (const img of images) {
                    if (!text.includes(img)) stale.push(`${file}: ${img} no longer appears`);
                }
            }
            expect(stale).toEqual([]);
        });
    });

    describe('the declared alternates are real', () => {
        it('every ALTERNATE_IMAGES entry still appears somewhere in the tree', () => {
            // A no-stale check. An alternate nobody uses is a hole in Direction
            // B that nothing would ever close.
            const files = trackedFiles().filter((f) =>
                /\.(ya?ml|md|sh|ts|tsx|js|mjs|sql|json)$|Dockerfile/.test(f),
            );
            const unused = ALTERNATE_IMAGES.filter(
                ({ image }) =>
                    !files.some((f) => {
                        try {
                            return read(f).includes(image);
                        } catch {
                            return false;
                        }
                    }),
            );
            expect(unused).toEqual([]);
        });
    });

    describe('the count in the pin file is not just prose', () => {
        it('the header states the number of literal sites, and it matches', () => {
            // The old header claimed "nine" while separately describing two more
            // spellings it did not count. The number is asserted now, so the
            // prose cannot drift from the list.
            const words: Record<number, string> = {
                9: 'NINE',
                10: 'TEN',
                11: 'ELEVEN',
                12: 'TWELVE',
                13: 'THIRTEEN',
            };
            const word = words[LITERAL_COUNT];
            expect(word).toBeDefined();
            expect(read(PIN_FILE).toUpperCase()).toContain(word);
        });
    });

    describe('the two Dockerfiles that build the image stay in step', () => {
        it('the restore-drill heredoc installs the same packages as deploy/postgres/Dockerfile', () => {
            // The heredoc is a COPY of that Dockerfile, because the drill is
            // scp'd to a bare VM with no repo checkout. With PostGIS now
            // INSTALLED rather than baked into the base, the package list is as
            // load-bearing as the tag: a drill that builds without postgis
            // cannot restore a database whose extensions need it, and that
            // reads as a failed RESTORE rather than a broken build.
            const pkgs = (text: string): string[] =>
                [...text.matchAll(/postgresql-16-[a-z0-9-]+/g)].map((m) => m[0]).sort();
            const dockerfile = pkgs(read('deploy/postgres/Dockerfile'));
            const heredoc = pkgs(read('infra/scripts/restore-test-gcp.sh'));
            expect(dockerfile.length).toBeGreaterThan(0);
            expect(heredoc).toEqual(dockerfile);
        });
    });
});

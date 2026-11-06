import fs from 'fs';
import path from 'path';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/**
 * Every job context that builds a LITERAL `userId` is registered, with whether
 * that value may reach a foreign key — #2788.
 *
 * ## The hazard
 *
 * A job holds a `RequestContext` whose `userId` is a string that names no
 * `User` row. That is correct for what the context is used for — permissions,
 * the audit actor, the RLS `app.actor_user_id` session variable, none of which
 * is an FK — and it satisfies **none of the 43 NOT-NULL `*userId` columns in
 * the schema**.
 *
 * Writing `ctx.userId` into a `createdByUserId` column is the obvious thing to
 * do with it. It typechecks (`String` to `String`), it passes every mocked
 * unit test because a Prisma double never consults an FK, and it fails only
 * against a real database. #2729 is the proof that the obvious thing gets
 * done: `retention-notifications` omitted the column behind a blanket
 * any-cast, which hid a second defect as well, and no test in the repo could
 * see either.
 *
 * ## Why a registry rather than a classifier
 *
 * The honest reason, and it is the same as `lookup-hash-call-sites-registered`
 * next door: whether a sentinel REACHES a write is a dataflow question, and a
 * regex guessing at it would guess in the direction of "fine", which is the
 * failure that reads as green. So the detector demands only that a site be
 * REGISTERED, and a human writes down which kind it is. A new job context
 * fails this guard until someone has looked.
 *
 * ## The population is 8, and the issue that prompted this said 5
 *
 * Worth recording, because the miss is instructive. #2788 counted
 * `userId: 'system'` — the bare literal — and missed three sites using a
 * NAMESPACED form, `userId: 'system:<job-name>'`, which is strictly more
 * informative (it says which job acted) and equally un-FK-able. The issue
 * grepped for the string it expected rather than for the SHAPE, so the
 * detector below matches any single-quoted literal and the case at the bottom
 * proves it sees both spellings.
 */

/** Jobs are the population: a request-scoped context carries a real user. */
const ROOTS = ['src/app-layer/jobs'];

type Kind = (typeof SAFE_KINDS)[number] | (typeof UNSAFE_KINDS)[number];

/** Kinds where the sentinel cannot reach a foreign key. */
const SAFE_KINDS = ['sentinel-not-written', 'sentinel-write-uses-row-value'] as const;

/**
 * Kinds that put a non-existent user id into an FK column.
 *
 * The conversion list. It is EMPTY: #2729 was the one realised instance and it
 * now resolves a real row through `resolveSystemUserId`. An entry appearing
 * here again is a regression, which the case below asserts.
 */
const UNSAFE_KINDS = ['sentinel-reaches-fk'] as const;

interface Registration {
    readonly kind: Kind;
    readonly note: string;
}

const REGISTERED: Readonly<Record<string, Registration>> = {
    'src/app-layer/jobs/classify-photo.ts': {
        kind: 'sentinel-write-uses-row-value',
        note: "Context carries `userId: 'system'`, and its writes do NOT use it: the notification rows take `logEntry.createdByUserId` and `notifyUserId`, both read from real rows. The sentinel reaches permissions and the audit actor only.",
    },
    'src/app-layer/jobs/sla-monitor.ts': {
        kind: 'sentinel-write-uses-row-value',
        note: "Context carries `userId: 'system'`. Recipients come from a membership `select: { userId: true }`, so every id written is a real member's.",
    },
    'src/app-layer/jobs/snapshot.ts': {
        kind: 'sentinel-not-written',
        note: "Context carries `userId: 'system'` and no write takes it.",
    },
    'src/app-layer/jobs/push-send.ts': {
        kind: 'sentinel-not-written',
        note: "Context carries `userId: 'system'` alongside a real `recipientUserId` parameter. It performs no model create of its own.",
    },
    'src/app-layer/jobs/push-summary.ts': {
        kind: 'sentinel-not-written',
        note: "As push-send: sentinel for the context, real `recipientUserId` for the recipient, no create that takes either.",
    },
    'src/app-layer/jobs/embed-chunks.ts': {
        kind: 'sentinel-not-written',
        note: "Namespaced sentinel `'system:embed-chunks'`. Zero write calls — it reads chunks and calls the embedding provider.",
    },
    'src/app-layer/jobs/memory-extract.ts': {
        kind: 'sentinel-write-uses-row-value',
        note: "Namespaced sentinel `'system:memory-extract'`. Its facts are written with `userId: conv.userId` — the conversation's real owner — which is also the only correct value, since a memory point belongs to the person it is about.",
    },
    'src/app-layer/jobs/reindex-knowledge-article.ts': {
        kind: 'sentinel-not-written',
        note: "Namespaced sentinel `'system:reindex-knowledge-article'`. Its `createMany` writes chunks, which carry no user column.",
    },
};

/** Mask comments so a sentinel named only in prose does not register as code. */
function codeOf(source: string): string {
    return blankNonCode(source);
}

/**
 * Does this source build a context with a LITERAL string `userId`?
 *
 * Deliberately any single-quoted literal rather than the word `system`: the
 * namespaced spelling is already in use, and the next convention nobody has
 * invented yet should fail this guard rather than slip past it.
 */
export function buildsLiteralUserId(source: string): boolean {
    return /userId:\s*'[^']*'/.test(codeOf(source));
}

const FILES = collectSourceFiles({
    roots: ROOTS,
    // High enough that a broken selector fails rather than reporting a tidy
    // zero. There are ~45 job modules.
    floor: 30,
}).map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'));

const SITES = FILES.filter((rel) =>
    buildsLiteralUserId(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')),
);

describe('the detector, before anything is asserted with it', () => {
    it('reports the population, so a zero would be visible', () => {
        expect(FILES.length).toBeGreaterThan(30);
        console.log(
            `[system-ctx] ${FILES.length} job modules scanned, ${SITES.length} build a literal userId, ` +
                `${Object.keys(REGISTERED).length} registered`,
        );
        // Pinned at the real figure rather than a number a broken selector
        // would also satisfy. A zero here means the collector or the pattern
        // broke, not that the repo is clean.
        expect(SITES.length).toBeGreaterThanOrEqual(8);
    });

    it('matches BOTH spellings — the bare and the namespaced', () => {
        // #2788 counted only the bare form and missed three namespaced sites.
        // A detector keyed to `'system'` exactly would inherit that miss.
        expect(buildsLiteralUserId("const c = { userId: 'system' };")).toBe(true);
        expect(buildsLiteralUserId("const c = { userId: 'system:embed-chunks' };")).toBe(true);
        // And a spelling nobody has invented yet still registers.
        expect(buildsLiteralUserId("const c = { userId: 'job-runner' };")).toBe(true);
    });

    it('does NOT match a real id, nor a mention in prose', () => {
        expect(buildsLiteralUserId('const c = { userId: ctx.userId };')).toBe(false);
        expect(buildsLiteralUserId('const c = { userId: conv.userId };')).toBe(false);
        // A scar is not a wound: a comment describing the sentinel is not one.
        expect(buildsLiteralUserId("// once wrote userId: 'system' here\n")).toBe(false);
    });
});

describe('every job context with a literal userId is registered', () => {
    it('the detector and the registry agree on the count', () => {
        // A detector finding FEWER files than the registry lists would
        // otherwise read as "nothing left to classify".
        expect(SITES.length).toBe(Object.keys(REGISTERED).length);
    });

    it('no unregistered site', () => {
        const unregistered = SITES.filter((f) => !(f in REGISTERED));
        if (unregistered.length > 0) {
            throw new Error(
                `${unregistered.length} job module(s) build a literal \`userId\` and are not ` +
                    `registered in tests/guards/system-ctx-sites-registered.test.ts:\n  ` +
                    unregistered.join('\n  ') +
                    `\n\nWrite down whether that value can reach a NOT-NULL \`*userId\` column. ` +
                    `If it can, it needs \`resolveSystemUserId(tenantId)\` instead — a sentinel ` +
                    `names no User row and the FK will reject it at RUNTIME, where no mocked ` +
                    `test can see it (#2729).`,
            );
        }
    });

    it('no STALE entry — every registered file still builds one', () => {
        // The list can only shrink. An entry for a file that stopped matching
        // is cover for whatever is written there next.
        const stale = Object.keys(REGISTERED).filter((f) => !SITES.includes(f));
        expect(stale).toEqual([]);
    });

    it('every entry carries a real note', () => {
        for (const [file, reg] of Object.entries(REGISTERED)) {
            expect(SAFE_KINDS.concat(UNSAFE_KINDS as readonly string[] as never).includes(reg.kind as never)).toBe(true);
            // Long enough to be a reason rather than a label.
            expect(reg.note.length).toBeGreaterThan(40);
            expect(file.startsWith('src/app-layer/jobs/')).toBe(true);
        }
    });

    it('the UNSAFE list is EMPTY — #2729 was the one instance and it is retired', () => {
        /*
         * `retention-notifications` wrote a sentinel into `Task.createdByUserId`
         * behind an any-cast; it now resolves a real row through
         * `resolveSystemUserId`. An entry reappearing here is a regression,
         * and the failure it describes is invisible to every mocked suite.
         */
        const unsafe = Object.entries(REGISTERED).filter(([, r]) =>
            (UNSAFE_KINDS as readonly string[]).includes(r.kind),
        );
        expect(unsafe.map(([f]) => f)).toEqual([]);
    });
});

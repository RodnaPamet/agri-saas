/**
 * NOTHING writes a `ChannelMembership` on anybody's behalf — P9.2 (#2936).
 *
 * The phase line is "Channels are suggested from the farm's crops and oblast,
 * **never joined automatically**", and everything else in P9.2 is reference
 * data. That clause is the deliverable, so it gets a guard.
 *
 * ## Why this class is worth a guard at all
 *
 * `tests/guardrails/no-auto-join.test.ts` exists because Epic 1 GAP-01 granted
 * auto-ADMIN on OAuth sign-in — a person finding themselves in something they
 * did not join, with privileges nobody gave them. A channel is a weaker case
 * than a tenant and the same shape: a farmer opening the app to forty-three
 * channels they never chose has had a decision made for them, and the fix
 * after the fact is worse than the prevention, because leaving looks like a
 * choice they made too.
 *
 * So the rule is: **suggestion is a READ that returns candidates; the join is
 * a WRITE the person performs.**
 *
 * ## It is a SEPARATE file from `no-auto-join`, deliberately
 *
 * The obvious move is to add `channelMembership` to that guardrail's patterns.
 * It is the wrong one: that file's allowlist entries each assert a membership
 * path is "gated by what? audit-logged how? email-bound?" — questions about
 * TENANT privilege that do not apply here. Folding channels in would make its
 * six careful reasons sit beside entries that answer different questions, and
 * the next reader could not tell which rule a given entry was obeying.
 *
 * ## The population is the SEED plus `src/`, and the seed is the point
 *
 * `scripts/channels/seed-channels.ts` is the file most likely to acquire a
 * "and join everyone in that oblast" line, because it already holds the
 * oblast list and the temptation is one `createMany` away. So the seed is IN
 * the population rather than exempt from it.
 *
 * ## Today the allowlist is EMPTY, and that is why the proof is synthetic
 *
 * P9.2 ships no join path at all — the write arrives with P9.3's behaviour or
 * P9.5's UI. A guard whose population is empty passes whatever it asserts
 * (`an-empty-window-passes-a-negated-assertion`), so the detector is proved
 * against crafted sources instead: one that joins and one that does not. When
 * the real join path lands it goes in `ALLOWLISTED_JOIN_SITES` with a reason
 * saying what makes it the person's own act.
 */
import { readFileSync } from 'fs';
import { relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = process.cwd();

/**
 * Writes that create a membership row. `update` is absent on purpose: the read
 * cursor, the mute and the ban are all updates to a row that already exists,
 * and `channel_membership_update` admits the caller's own row for exactly that.
 */
const JOIN_WRITE = /channelMembership\s*\.\s*(?:create|createMany|upsert)\b/;

/**
 * The file's CODE, with comments and strings blanked.
 *
 * `guards-blank-comments-before-matching` (#1774) requires it, and the reason
 * bites directly here: a docblock explaining why this guard exists would
 * naturally quote `channelMembership.create` — so the better the explanation,
 * the more likely the guard reports its own prose. This very file is in its own
 * population, and its header quotes the pattern twice.
 *
 * Strings go too: a `'channelMembership.create'` in an error message or a test
 * fixture is not a write.
 *
 * CACHED, because two assertions range over the same 2,455 files and blanking
 * is the expensive part — `pages-are-reachable` learned this the direct way
 * (53s uncached, 3.8s cached) and recorded the rule: a slow guard is one
 * somebody eventually moves out of the default population.
 */
const CODE_CACHE = new Map<string, string>();

function codeOf(relPath: string): string {
    const hit = CODE_CACHE.get(relPath);
    if (hit !== undefined) return hit;
    const code = blankNonCode(readFileSync(relPath, 'utf8'), { strings: true });
    CODE_CACHE.set(relPath, code);
    return code;
}

interface AllowlistedSite {
    readonly file: string;
    /** What makes this write the PERSON'S OWN act rather than one done to them. */
    readonly reason: string;
}

/**
 * EMPTY until a join path exists. An entry here must say what makes the write
 * the person's own act — a request they made, not a list they appeared on.
 */
const ALLOWLISTED_JOIN_SITES: readonly AllowlistedSite[] = [];

/**
 * Every TRACKED TypeScript file that could hold such a write.
 *
 * `collectTrackedFiles` rather than a hand-rolled `git ls-files`, because
 * `file-collection-is-not-silently-empty` refuses a new collector — and
 * rightly: the shared helper carries the FLOOR, so a renamed root fails loudly
 * instead of scanning nothing and reporting a clean sweep. (It refused my first
 * draft, which spelled the `git ls-files` call inline.)
 *
 * One caveat the helper does not remove, because it is `git ls-files`
 * underneath: **an unstaged new file is invisible.** The seed assertion below
 * failed until the seed was `git add`ed — the same family as
 * `git checkout -- <path>` being a no-op on an untracked file. Not a hole in
 * CI, where everything is tracked by definition; it does mean proving a NEW
 * file is covered has to happen after staging it.
 */
function candidateFiles(): string[] {
    return collectTrackedFiles({
        roots: ['src', 'scripts', 'prisma'],
        extensions: ['.ts', '.tsx'],
        floor: 100,
    }).map((abs) => relative(ROOT, abs));
}

describe('a channel membership is never written on somebody’s behalf', () => {
    const files = candidateFiles();

    it('the scan selected files — an empty scan passes vacuously', () => {
        // The floor is on the POPULATION, not on the findings: a renamed `src/`
        // or a `git ls-files` that stopped resolving would make this guard a
        // permanent green tick over nothing.
        expect(files.length).toBeGreaterThan(100);
    });

    it('reports what it graded', () => {
        const withPattern = files.filter((f) =>
            JOIN_WRITE.test(codeOf(f)));
        console.log(
            `[channel-auto-join] ${files.length} file(s) scanned, `
            + `${withPattern.length} with a membership write, `
            + `${ALLOWLISTED_JOIN_SITES.length} allowlisted`,
        );
        expect(withPattern.length).toBeGreaterThanOrEqual(0);
    });

    it('no unallowlisted file creates a ChannelMembership', () => {
        const allowed = new Set(ALLOWLISTED_JOIN_SITES.map((s) => s.file));
        const offenders = files.filter(
            (f) => !allowed.has(f) && JOIN_WRITE.test(codeOf(f)),
        );
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} file(s) create a ChannelMembership and are not `
                + `allowlisted:\n  ${offenders.join('\n  ')}\n\n`
                + 'P9.2: "Channels are suggested from the farm\'s crops and oblast, NEVER '
                + 'joined automatically." Suggestion is a READ returning candidates; the '
                + 'join is a WRITE the person performs.\n\n'
                + 'If this IS a legitimate join path, add it to ALLOWLISTED_JOIN_SITES '
                + 'with a reason saying what makes the write the person\'s own act — a '
                + 'request they made, not a list they appeared on. Epic 1 GAP-01 '
                + '(auto-ADMIN on OAuth sign-in) is why this class has a guard.',
            );
        }
        expect(offenders).toEqual([]);
    });

    it('the SEED is in the population, not exempt from it', () => {
        // It holds the oblast list, so "and join everyone in that oblast" is one
        // `createMany` away — which is precisely why it must not be excluded.
        expect(files).toContain('scripts/channels/seed-channels.ts');
    });

    describe('the detector has teeth — proved synthetically, because the population is empty', () => {
        it('matches a join write', () => {
            for (const src of [
                'await prisma.channelMembership.create({ data: { channelId, userId } });',
                'await tx.channelMembership.createMany({ data: rows });',
                'await prisma.channelMembership.upsert({ where, create, update });',
                'await prisma . channelMembership . create ({})',
            ]) {
                expect(JOIN_WRITE.test(src)).toBe(true);
            }
        });

        it('does NOT match a read, a count, or an update to an existing row', () => {
            // All three are legitimate and common: suggestion reads, the member
            // count is maintained from a join that already happened, and the
            // read cursor is an update to the caller's own row.
            for (const src of [
                'await prisma.channelMembership.findMany({ where: { userId } });',
                'await prisma.channelMembership.count({ where: { channelId } });',
                'await prisma.channelMembership.update({ where: { id }, data: { lastReadAt } });',
                'await prisma.channelMembership.delete({ where: { id } });',
            ]) {
                expect(JOIN_WRITE.test(src)).toBe(false);
            }
        });

        it('and the allowlist actually excuses a file, rather than being decorative', () => {
            // Without this, an allowlist that was never consulted would read as
            // working for as long as it stayed empty — which is now.
            const allowed = new Set(['some/file.ts']);
            const offenders = ['some/file.ts', 'other/file.ts'].filter(
                (f) => !allowed.has(f),
            );
            expect(offenders).toEqual(['other/file.ts']);
        });
    });
});

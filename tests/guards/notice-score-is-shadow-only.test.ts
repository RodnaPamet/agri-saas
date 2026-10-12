/**
 * P5.5b — the shadow score is read by NOTHING that decides (#1596).
 *
 * This is the point of the phase, not a side control. "AI scores reports in
 * shadow mode only" is easy to state, easy to satisfy on the day it ships, and
 * easy to violate later in a way that looks like an improvement: ordering the
 * triage queue by score is a decision path wearing a sort, and it would put an
 * unevaluated model in charge of which Art 16 notices a human sees first.
 *
 * ## What "reads it" means here
 *
 * Any source file outside the scoring path that mentions `noticeScore` /
 * `NoticeScore`. Deliberately coarse: a narrower rule ("no `orderBy` on
 * score") would pass a threshold filter, and a rule about thresholds would
 * pass a sort. The property worth holding is that the column has exactly one
 * writer and no readers, which is checkable without predicting the shape of
 * the violation.
 *
 * ## It is the SOURCE half of a two-part control
 *
 * The database half is in migration `20261011120000`: no policy arm grants
 * `app_user` any access to `NoticeScore`, so a request-path read sees zero rows
 * even if the source changed. Neither half subsumes the other — a platform-key
 * route runs as a privileged role and would read the rows fine, which is
 * exactly the moderation console this guard is about.
 *
 * ## The denominator is printed
 *
 * An allowlist-shaped guard whose population silently empties is a guard that
 * passes forever. §1 prints what it scanned and floors it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = join(__dirname, '../..');

/**
 * The only files allowed to name the model.
 *
 * Each is part of writing a score or declaring the column; none reads one back
 * to act on it.
 */
const WRITERS: Readonly<Record<string, string>> = {
    'src/app-layer/jobs/notice-score.ts':
        'The job that writes the score. The one permitted writer — it reads the table only as an anti-join to find unscored notices, never a score VALUE.',
    'src/app-layer/ai/notice-scorer.ts':
        'Produces the score by calling the model. Holds no database access at all; it returns a value to the job above.',
    'src/lib/security/encrypted-fields.ts':
        'Declares NoticeScore.rationale as an encrypted column. A manifest entry, not a read.',
    'src/lib/db/encryption-middleware.ts':
        'Declares NoticeScore in GLOBAL_KEK_MODELS so the rationale decrypts under the global KEK. A key-selection entry, not a read.',
    // These two match on the JOB's identifiers rather than on the table:
    // `runNoticeScore` and `NoticeScorePayload`. The matcher is deliberately
    // coarse (see the docblock) and that coarseness catches them, which is the
    // right trade — narrowing it to the Prisma accessor would stop catching a
    // read dressed as something else, and these two cannot read a score value
    // in any case: one imports a function, the other declares a payload shape.
    'src/app-layer/jobs/executor-registry.ts':
        'Registers the job executor, importing `runNoticeScore`. It never touches the table — the dynamic import is the whole of its involvement.',
    'src/app-layer/jobs/types.ts':
        'Declares `NoticeScorePayload` and its `JobPayloadMap` entry. A type declaration carrying a `limit`, with no database access of any kind.',
};

/** Case-insensitive, so `noticeScore` (Prisma client) and `NoticeScore` (model) both count. */
const MENTIONS = /noticeScore/i;

const ALL = collectSourceFiles({ roots: ['src'], floor: 1500 });
const rel = (abs: string) => abs.replace(`${ROOT}/`, '');

/**
 * Strip comments before matching.
 *
 * Without this the guard reports the OPPOSITE of the truth in both directions:
 * a file that merely EXPLAINS why it must not read the score (the moderation
 * usecase is the obvious candidate for such a note) would be reported as a
 * reader, and a scar left where a read was removed would keep failing. This is
 * the `a-scar-is-not-a-wound` rule.
 *
 * The SHARED helper, not a local regex pair. A local one is how #1497 happened:
 * stripping block comments before line comments lets a `//` line containing an
 * unclosed `/*` swallow everything up to the next `*\/` elsewhere in the file —
 * real code, silently. `blankNonCode` is a state-aware single pass, and
 * `comment-stripper-order` caps the number of block-first local strippers so a
 * new one has to be a visible decision rather than a copy.
 *
 * Strings are left ALONE (the default): this guard's matcher is an identifier,
 * and blanking strings would hide a `prisma['noticeScore']` read.
 */
function codeOnly(src: string): string {
    return blankNonCode(src);
}

const mentioning = ALL.map(rel).filter((p) =>
    MENTIONS.test(codeOnly(readFileSync(join(ROOT, p), 'utf8'))),
);

describe('§1 the population this covers', () => {
    it('prints the denominator, so an empty selection is visible', () => {
        // eslint-disable-next-line no-console
        console.log(
            `[notice-score-shadow] scanned ${ALL.length} source files; `
            + `${mentioning.length} mention NoticeScore: ${mentioning.join(', ') || '(none)'}`,
        );
        // `collectSourceFiles`'s own floor refuses an empty sweep, and this
        // restates it beside the answer.
        expect(ALL.length).toBeGreaterThan(1500);
    });

    it('finds the writers it expects, so the matcher is not simply broken', () => {
        // A positive control. If `MENTIONS` stopped matching — a rename, a
        // regex typo — every assertion below would pass on an empty set, which
        // is the classic always-green guard.
        expect(mentioning).toContain('src/app-layer/jobs/notice-score.ts');
        expect(mentioning).toContain('src/app-layer/ai/notice-scorer.ts');
    });
});

describe('§2 nothing outside the writing path names the score', () => {
    it('has no reader', () => {
        const unexpected = mentioning.filter((p) => !(p in WRITERS));

        // The message names the rule rather than the symbol, because the next
        // person to trip this will be adding a feature that seems reasonable.
        expect(unexpected).toEqual([]);
    });

    it('the moderation console does not order or filter by score', () => {
        // Named explicitly because it is the most likely violation and the
        // most harmful: the queue is what a human works through, so sorting it
        // by an unevaluated model's score IS the model deciding.
        const console_ = readFileSync(
            join(ROOT, 'src/app-layer/usecases/moderation.ts'), 'utf8');
        const code = codeOnly(console_);
        expect(MENTIONS.test(code)).toBe(false);
        expect(code).not.toMatch(/orderBy[\s\S]{0,80}score/);
    });

    it('no API route names it', () => {
        // A route is the other way a score reaches a decision — a client that
        // can read it can sort on it, and then the control lives in somebody
        // else's codebase.
        const routes = mentioning.filter((p) => p.startsWith('src/app/api/'));
        expect(routes).toEqual([]);
    });

    it('no component names it', () => {
        const components = mentioning.filter((p) => p.startsWith('src/components/'));
        expect(components).toEqual([]);
    });
});

describe('§3 the allowlist has no stale entries', () => {
    it.each(Object.keys(WRITERS))('%s still exists and still mentions it', (path) => {
        // An entry for a file that no longer names the score is cover for
        // whatever is created at that path next.
        expect(mentioning).toContain(path);
    });

    it('every entry carries a real reason', () => {
        for (const [path, reason] of Object.entries(WRITERS)) {
            expect(reason.length).toBeGreaterThan(40);
            expect(reason).not.toMatch(/^(TODO|FIXME|n\/a|see above)/i);
            expect(path).toMatch(/^src\//);
        }
    });

    it('the WRITING path is exactly one file', () => {
        // The guard's real invariant, stated as a count: one writer. Two would
        // mean two places deciding what a score means, and the second is where
        // a read creeps in.
        const writes = Object.keys(WRITERS).filter((p) =>
            /noticeScore\.create|noticeScore\.upsert/.test(
                readFileSync(join(ROOT, p), 'utf8')));
        expect(writes).toEqual(['src/app-layer/jobs/notice-score.ts']);
    });
});

describe('§4 the detector can tell a read from a declaration', () => {
    // Mutation proof against synthetic sources, because every real file is
    // currently compliant — so a green §2 is also what a detector that checks
    // nothing produces.
    const detects = (src: string) => MENTIONS.test(codeOnly(src));

    it('catches a queue ordered by score', () => {
        expect(detects(`
            const notices = await db.contentReport.findMany({
                include: { noticeScore: true },
                orderBy: { noticeScore: { score: 'desc' } },
            });
        `)).toBe(true);
    });

    it('catches a threshold filter, not only a sort', () => {
        expect(detects(`
            const suspicious = await prisma.noticeScore.findMany({
                where: { score: { gte: 80 } },
            });
        `)).toBe(true);
    });

    it('does NOT catch a comment explaining the rule', () => {
        // The half that makes the guard usable: a file must be able to say why
        // it does not read the score without being reported as reading it.
        expect(detects(`
            // The triage queue is deliberately NOT ordered by NoticeScore —
            // shadow mode means nothing decides on it.
            const notices = await db.contentReport.findMany({ orderBy: { createdAt: 'asc' } });
        `)).toBe(false);
    });

    it('does NOT catch a block comment mentioning it', () => {
        expect(detects(`
            /**
             * See NoticeScore for the shadow-scoring table; nothing here reads it.
             */
            export const x = 1;
        `)).toBe(false);
    });
});

/**
 * §4 — `subjectNoticeCount` is display-only too (#1600).
 *
 * ## Why this guard had to grow a second subject
 *
 * §1-§3 cover `NoticeScore`, a model, by name. #1600 added
 * `QueuedNotice.subjectNoticeCount` — how many notices exist about the same
 * subject — and the owner ruled it DISPLAY ONLY for the reason this whole file
 * exists: a number that orders the triage queue decides which Art 16 notices a
 * human reads first.
 *
 * **The existing sections could not have caught it.** They match a MODEL name;
 * the count is a computed field on a return type, with no model of its own. So
 * a `sortBy(notices, n => -n.subjectNoticeCount)` in a console or an
 * `orderBy` derived from it would have been invisible here — a guard aimed one
 * level off its target, which is `a-guard-that-grades-the-wrong-thing`.
 *
 * ## The distinction being enforced
 *
 * A raw count is a FACT, unlike a model score, and a moderator reading "5
 * notices about this listing" is exactly the point of computing it. What is
 * forbidden is the count becoming the ORDER — report volume is the one signal
 * a brigade can drive directly, so ordering by it rewards the brigading that
 * `PUBLIC_NOTICE_LIMIT`'s docblock says per-subject capping would otherwise
 * catch.
 *
 * Reading it, formatting it, and displaying it are all fine. Sorting or
 * filtering the queue on it is not.
 */
const COUNT_FIELD = 'subjectNoticeCount';

/** A sort or filter keyed on the count, with comments stripped first. */
function ordersByCount(src: string): boolean {
    const code = blankNonCode(src);
    if (!code.includes(COUNT_FIELD)) return false;
    return (
        // `orderBy: { subjectNoticeCount: ... }` or a Prisma-shaped sort
        /orderBy[\s\S]{0,80}subjectNoticeCount/.test(code) ||
        // `.sort(...)` / `sortBy(...)` with the field inside the comparator
        /\.sort\s*\([\s\S]{0,160}subjectNoticeCount/.test(code) ||
        /sortBy[\s\S]{0,120}subjectNoticeCount/.test(code) ||
        // a threshold filter — the other half, per §3's lesson that a rule
        // about sorts passes a filter and vice versa. Only the
        // FIELD-then-OPERATOR direction, and the operator must be adjacent:
        //
        // the mirror form (`operator ... field`) matched JSX, because the `>`
        // closing `<span>` sits within a few characters of
        // `{notice.subjectNoticeCount}`. That is a matcher tripping on syntax
        // rather than on its subject, and it reported the one usage the field
        // exists FOR — rendering it — as a violation. An inverted comparison
        // (`5 <= n.count`) is now uncaught, which is the right trade: a guard
        // that cries wolf on every display site is one somebody deletes.
        /subjectNoticeCount\s*(>=|<=|>|<)[^=]/.test(code) ||
        /subjectNoticeCount[\s\S]{0,30}\b(gte|gt|lte|lt)\s*:/.test(code)
    );
}

describe('§4 the per-subject count never orders or filters the queue', () => {
    it('no file in the repo sorts or filters on it', () => {
        // `ALL` is this file's existing population — `collectSourceFiles({
        // roots: ['src'], floor: 1500 })` — reused rather than re-derived, so
        // §4 cannot end up scanning a different tree from §1-§3.
        const offenders = ALL
            .filter((p) => ordersByCount(readFileSync(p, 'utf8')))
            .map(rel);

        // The denominator printed, so a selection that stopped matching
        // anything cannot read as a pass — the `a-gate-narrow-enough-to-
        // always-pass` rule.
        const mentioning = ALL.filter((p) =>
            blankNonCode(readFileSync(p, 'utf8')).includes(COUNT_FIELD),
        ).length;

        expect({ offenders, filesMentioningTheCount: mentioning })
            .toEqual({ offenders: [], filesMentioningTheCount: mentioning });
        // A positive control on the population: if nothing mentions the field
        // at all, the scan above proves nothing and the field has been renamed
        // or removed without this guard following it.
        expect(mentioning).toBeGreaterThan(0);
    });

    it('catches a Prisma orderBy on the count', () => {
        expect(ordersByCount(`
            const rows = await prisma.contentReport.findMany({
                orderBy: { subjectNoticeCount: 'desc' },
            });
        `)).toBe(true);
    });

    it('catches an in-memory sort on the count', () => {
        expect(ordersByCount(`
            const worst = notices.sort((a, b) => b.subjectNoticeCount - a.subjectNoticeCount);
        `)).toBe(true);
    });

    it('catches a threshold filter on the count', () => {
        expect(ordersByCount(`
            const brigaded = notices.filter((n) => n.subjectNoticeCount >= 5);
        `)).toBe(true);
    });

    it('does NOT catch merely reading or rendering it', () => {
        // The half that keeps the field usable for the purpose it was built
        // for: a moderator has to be able to see the number.
        expect(ordersByCount(`
            return <span>{notice.subjectNoticeCount} notices about this subject</span>;
        `)).toBe(false);
        expect(ordersByCount(`
            const label = String(notice.subjectNoticeCount);
        `)).toBe(false);
    });

    it('does NOT catch a comment explaining the rule', () => {
        expect(ordersByCount(`
            // Deliberately NOT ordered by subjectNoticeCount >= anything:
            // report volume is a signal a brigade can drive.
            const notices = rows.sort((a, b) => +a.createdAt - +b.createdAt);
        `)).toBe(false);
    });
});


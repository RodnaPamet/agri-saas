/**
 * Every journal reader is classified as manual-only or task-inclusive.
 *
 * Owner ruling 2026-10-10: «decouple tasks from journal — journal should be
 * entered manually only and tasks list should appear only in tasks». So
 * `LogEntryFilters.includeTaskWritten` defaults to FALSE and the journal, its
 * API and the dashboard strip show what a person typed.
 *
 * The owner then ruled on scope separately: the satellite briefing KEEPS
 * seeing task-written entries, because its job is to summarise what happened
 * on the farm and a briefing blind to spraying is less useful rather than
 * tidier. That makes it the single exception, and a single exception is
 * exactly the thing that rots — either by spreading to a second caller or by
 * being "tidied" off the one that needs it.
 *
 * ## Why the population is DERIVED
 *
 * A guard listing two call sites would pass forever while a third appeared.
 * The population here is every caller of `listLogEntries` /
 * `listLogEntriesPaginated` found on disk, so a new journal reader fails until
 * somebody records which side of the ruling it is on. Inheriting the default
 * is the right outcome for most new callers — but it should be a decision
 * somebody made, not one nobody noticed.
 *
 * The default is also the SAFE direction: a new caller that forgets the flag
 * shows fewer rows, never more. That is why the flag is opt-IN rather than
 * opt-out, and it is worth preserving if this ever gets refactored.
 *
 * ## Not covered here, deliberately
 *
 * `reports/pdf/farm-record-diary.ts` never reaches `JournalRepository`, so the
 * ДНЕВНИК register keeps its rows whatever this flag does — and that is
 * DESIGN, not luck. It takes its spray rows from `operationParcel.findMany`
 * (:905) and reads `logEntry` only for cert snapshots and OBSERVATION rows,
 * filtered by `type`. Its own comment says why:
 *
 *     Cert snapshots (frozen at completion) keyed by operationParcelId …
 *     from OperationParcel REGARDLESS of the journal entry's lifecycle
 *
 * written before this ruling existed. So the register survives the entry being
 * deleted outright, which is stronger than the hiding this flag does.
 *
 * Do not "make that explicit" by routing the PDF through this repository for
 * consistency — that would create the coupling its author deliberately
 * avoided. A guard here asserting the PDF is unaffected would also be
 * asserting something about a query this file cannot see;
 * `tests/integration/journal-location-filter.test.ts` covers the behaviour
 * that matters.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT as ROOT } from '../helpers/collect-files';

/** The reader that must keep seeing task-written entries, and why. */
const TASK_INCLUSIVE: Readonly<Record<string, string>> = {
    'src/app-layer/usecases/satellite-briefing.ts':
        'summarises farm activity — a briefing blind to spraying is less useful, not tidier (owner, 2026-10-10)',
};

/** Readers that must stay manual-only, each with the reason it is listed. */
const MANUAL_ONLY: Readonly<Record<string, string>> = {
    'src/app-layer/ai/assistant/tools.ts':
        'the assistant answers questions ABOUT the journal, so it must describe the same register the journal page shows — and it is the one reader whose output is prose, where a task-written row would read as something the farmer wrote',
    'src/app-layer/usecases/ag-dashboard.ts':
        'the recent-entries strip sits beside the journal page; the two must not disagree about what the journal contains',
    'src/app/api/t/[tenantSlug]/journal/route.ts': 'the journal API itself',
    'src/app/t/[tenantSlug]/(app)/journal/page.tsx': 'the journal page itself',
};

/**
 * Files that CALL a journal list usecase — the import alone is not enough.
 *
 * Collection goes through `collectSourceFiles` rather than a local walk: a
 * hand-rolled `walk` is the exact function #865 found gutted-and-still-green in
 * 37 of 47 dead guards, and `tests/guards/file-collection-is-not-silently-empty`
 * enforces the migration. The `floor` makes an empty population throw instead
 * of passing, which is a stronger control than a test asserting a count.
 */
function journalReaders(): string[] {
    const found: string[] = [];
    for (const file of collectSourceFiles({ roots: ['src'], floor: 1000 })) {
        const rel = path.relative(ROOT, file);
        // The usecase module defines them; it is not a reader of itself.
        if (rel === 'src/app-layer/usecases/journal.ts') continue;
        // Blanked (#2623): a docblock naming `listLogEntries(...)` — which this
        // very file does, twice — would enter the POPULATION as a reader and
        // demand a classification for a file that calls nothing.
        const src = blankNonCode(fs.readFileSync(file, 'utf8'), { strings: true });
        if (/\blistLogEntries(?:Paginated)?\s*\(/.test(src)) found.push(rel);
    }
    return found.sort();
}

/**
 * Source with comments and string CONTENTS blanked (#2623).
 *
 * `{ strings: true }` because every subject here is a CALL or a STRUCTURE —
 * `includeTaskWritten: true`, `includeTaskWritten !== true`, a `where.NOT`
 * object literal — never message copy, so a sequence appearing inside a string
 * is no more a call than one inside a comment.
 *
 * Found on #2621: `src/app-layer/ai/assistant/tools.ts` mentions
 * `includeTaskWritten` THREE times, all in comments explaining why it is never
 * passed, and passed this guard only because none of them happened to spell
 * `: true`. A correct file was one quotation away from reddening three shards,
 * and the quotation is the natural thing to write — "passing
 * `includeTaskWritten: true` would widen a БАБХ register". That is cases 2 and
 * 4 of `guards-blank-comments-before-matching`'s own docblock, the second of
 * which has already happened twice in this repo.
 */
const reads = (rel: string): string =>
    blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { strings: true });

describe('every journal reader is classified', () => {
    it('control: the scan found readers at all', () => {
        // Without this the comparisons below run over an empty set, which is
        // agreement and worthless — and the regex is the fragile part, since
        // renaming the usecase would silently empty it.
        expect(journalReaders().length).toBeGreaterThanOrEqual(3);
    });

    it('names any reader that is on neither list', () => {
        // A new journal reader inherits manual-only, which is correct for
        // most — but it should be a decision somebody made. The failure names
        // the file so the fix is to classify it, not to widen a regex.
        const classified = new Set([...Object.keys(TASK_INCLUSIVE), ...Object.keys(MANUAL_ONLY)]);
        const unclassified = journalReaders().filter((f) => !classified.has(f));

        expect(unclassified).toEqual([]);
    });

    it('every listed file still exists and still reads the journal', () => {
        // Shrink-only in the other direction: a stale entry keeps a path
        // pre-approved for whatever is created there next, which is how the
        // `require('@/env')` allowlist outlived the usecases it described.
        const live = new Set(journalReaders());
        for (const f of [...Object.keys(TASK_INCLUSIVE), ...Object.keys(MANUAL_ONLY)]) {
            expect({ file: f, stillAReader: live.has(f) }).toEqual({
                file: f,
                stillAReader: true,
            });
        }
    });

    it.each(Object.keys(TASK_INCLUSIVE))('%s opts IN explicitly', (file) => {
        expect(reads(file)).toMatch(/includeTaskWritten:\s*true/);
    });

    it.each(Object.keys(MANUAL_ONLY))('%s does NOT opt in', (file) => {
        // The direction that silently reverses the owner's ruling. A dashboard
        // strip showing spray entries beside a journal page that hides them is
        // the inconsistency that gets reported as a bug months later.
        expect(reads(file)).not.toMatch(/includeTaskWritten:\s*true/);
    });

    it('the flag defaults to manual-only, and only `true` widens', () => {
        // Pinned on the repository because the default is the whole safety
        // argument: a caller that forgets the flag shows FEWER rows, never
        // more. A truthiness check (`if (!filters?.includeTaskWritten)`) would
        // behave the same for a boolean and differently for a coerced string,
        // which a route could pass.
        const repo = reads('src/app-layer/repositories/JournalRepository.ts');
        expect(repo).toMatch(/includeTaskWritten\s*!==\s*true/);
    });

    it('hides a task-written row by NEGATING it, not by testing the FK alone', () => {
        // The mechanism changed in #1740 and this assertion changed with it,
        // deliberately rather than by deletion.
        //
        // It used to pin `where.operationParcelId = null`, on the premise that
        // the FK was the only thing separating a task-written entry from a
        // typed one. The two-step treatment record broke that premise: it is
        // typed by a person and ALSO writes operation lines, because those
        // lines are what the BABH diary PDF reads. So the rule is now the
        // negation of what is being hidden.
        //
        // Pinned on the SHAPE and not merely on the two column names, because
        // the shape is the correctness argument. `NOT: { a, b }` is
        // `NOT (a AND b)` — asserted against a real database in
        // `tests/integration/journal-diary-recorded.test.ts`, because if
        // Prisma had read it as `NOT a AND NOT b` the rule would additionally
        // hide every entry with no operation line and blank the journal for
        // every existing farm. A correct-looking clause, an outage.
        //
        // `NOT` also has to stay `NOT`. `where.OR` belongs to the free-text
        // search and `where.AND` to the crop, location and cursor clauses; the
        // first version of this change used `where.OR` and would have been
        // silently discarded by any search, WIDENING the result.
        const repo = reads('src/app-layer/repositories/JournalRepository.ts');
        expect(repo).toMatch(
            /where\.NOT\s*=\s*\{\s*operationParcelId:\s*\{\s*not:\s*null\s*\},\s*recordedInDiary:\s*false\s*\}/,
        );
    });
});

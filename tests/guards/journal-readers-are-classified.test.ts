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
 * `reports/pdf/farm-record-diary.ts` queries `logEntry.findMany` DIRECTLY and
 * never reaches `JournalRepository`, so the ДНЕВНИК register keeps its
 * observation rows whatever this flag does. That is luck rather than design —
 * the register has its own copy of the journal read — and it is the reason the
 * owner's "the PDF stays on the Дневник" needed no code change. A guard
 * asserting the PDF is unaffected would be asserting something about a query
 * this file cannot see; `tests/integration/journal-location-filter.test.ts`
 * covers the behaviour that matters.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles, REPO_ROOT as ROOT } from '../helpers/collect-files';

/** The reader that must keep seeing task-written entries, and why. */
const TASK_INCLUSIVE: Readonly<Record<string, string>> = {
    'src/app-layer/usecases/satellite-briefing.ts':
        'summarises farm activity — a briefing blind to spraying is less useful, not tidier (owner, 2026-10-10)',
};

/** Readers that must stay manual-only, each with the reason it is listed. */
const MANUAL_ONLY: Readonly<Record<string, string>> = {
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
        const src = fs.readFileSync(file, 'utf8');
        if (/\blistLogEntries(?:Paginated)?\s*\(/.test(src)) found.push(rel);
    }
    return found.sort();
}

const reads = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
        expect(repo).toMatch(/where\.operationParcelId\s*=\s*null/);
    });
});

/**
 * One PDFKit stream collector in the codebase — #1905.
 *
 * ## Why a guard, and why only now
 *
 * `collect-buffer.ts` was extracted (#1740) because two byte-serving routes
 * had hand-rolled the same function. Its docblock states the reason: "Two
 * hand-rolled stream collectors is how two byte-serving routes end up
 * disagreeing about when the document is finished."
 *
 * The extraction migrated ONE of them. A third copy survived in
 * `processes/[id]/export-pdf` and was found a year later, byte-identical — so
 * never a live bug, and exactly the condition the extraction existed to end.
 * That is the second recurrence of the shape, which is what pays for a guard;
 * the first extraction shipped without one, and that is why there was a third
 * copy to find.
 *
 * ## The property at stake
 *
 * Listeners attached BEFORE `end()`. pdfkit starts flushing on `end()`, so
 * attaching `data` afterwards drops the chunks already emitted and the buffer
 * comes back short — a truncated PDF rather than an error, which a client may
 * well still open. That property is asserted in one place and would be
 * ASSUMED in every copy.
 *
 * ## The population is derived
 *
 * Every file under `src/` is scanned for the collector's SHAPE — a `'data'`
 * listener and an `'end'` listener on the same declaration — rather than for
 * a function name, because the next copy will not necessarily be called
 * `collectPdfBuffer`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** The one module allowed to implement it. */
const CANONICAL = 'src/app-layer/reports/pdf/collect-buffer.ts';

const files = collectSourceFiles({
    roots: ['src'],
    exclude: (rel) => /\.(test|spec)\.tsx?$/.test(rel),
    floor: 500,
}).map((abs) => path.relative(REPO_ROOT, abs));

/**
 * Comments are blanked. This file and `collect-buffer.ts` both DESCRIBE the
 * shape at length, and prose about a defect is not the defect — the mistake a
 * sibling guard in this repo made twice.
 */
const codeOf = (rel: string) => blankNonCode(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

/**
 * A PDFKit stream collector: `.on('data'` and `.on('end'` in the same file,
 * plus the `.end()` that starts the flush.
 *
 * Deliberately shape-based, not name-based. A fourth copy called
 * `drainPdf`/`toBuffer`/`bufferDoc` is the same defect, and a name list would
 * miss every one of them.
 */
function looksLikeACollector(code: string): boolean {
    return (
        /\.on\(\s*['"]data['"]/.test(code) &&
        /\.on\(\s*['"]end['"]/.test(code) &&
        /\.end\(\s*\)/.test(code)
    );
}

describe('one PDFKit stream collector', () => {
    const implementors = files.filter((rel) => looksLikeACollector(codeOf(rel)));

    it('collected a real population and found the canonical module', () => {
        // The denominator. A scan that collected nothing would pass the
        // assertion below for free.
        expect(files.length).toBeGreaterThanOrEqual(500);
        expect(implementors).toContain(CANONICAL);
    });

    it('is the only implementation', () => {
        expect([...implementors].sort()).toEqual([CANONICAL]);
    });

    it('is the one every byte-serving route imports', () => {
        // The inverse: a canonical module nobody imports is not one
        // implementation, it is dead code beside the live copies. Three routes
        // stream a PDF today; all three must come here.
        const importers = files.filter((rel) =>
            /from\s+['"](@\/app-layer\/reports\/pdf\/collect-buffer|\.\.?\/[^'"]*collect-buffer)['"]/.test(
                codeOf(rel),
            ),
        );
        expect(importers.length).toBeGreaterThanOrEqual(3);
    });
});

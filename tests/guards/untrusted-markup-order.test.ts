/**
 * A file handling EXTERNAL-AUTHOR text must use `sanitizeUntrustedMarkup` (#2698).
 *
 * ## The defect this is about
 *
 * `sanitizeUntrusted` neutralises two families with different anchoring:
 * `INJECTION_LINE_PATTERNS` are unanchored, so markup around them is
 * irrelevant; `ROLE_SPOOF_PREFIX` is anchored at line start, so one HTML tag
 * masks it. An RSS `<description>` routinely carries HTML and
 * `rss-client.ts`'s `text()` helper strips none of it, so `<p>system: …`
 * reached two extraction prompts with the role-spoof defang INERT — while the
 * "ignore previous instructions" family kept working, which is what made it
 * survive review.
 *
 * ## Why a guard rather than the note in the module
 *
 * The two orders fail in opposite directions and NEITHER errors. Strip-then-
 * check defangs; check-then-strip hands the model a clean prefix after the
 * check passed on text where it was invisible. A convention documented at a
 * call site is one that gets got wrong at the next call site.
 *
 * ## Population, and what it does NOT cover
 *
 * DERIVED on content: any file under `src/app-layer/ai` that mentions
 * `MarketNewsItem` — the row whose `summary` came from a feed — must use the
 * `Markup` variant for its untrusted input. That is the external-author class
 * as it exists today.
 *
 * It does NOT cover a future external source that is not news: a scraped page,
 * an uploaded supplier leaflet (#2664). Those need their own row here, and the
 * denominator below is printed so a reader can see how narrow this is rather
 * than infer breadth from the file's name.
 */
import fs from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

/*
 * A call to the PLAIN helper.
 *
 * `\s*\(` cannot match across the `Markup` suffix, so this pattern already
 * EXCLUDES `sanitizeUntrustedMarkup(` and must not have the markup count
 * subtracted from it. Subtracting produced `plain=-2`, which is the tell that
 * two patterns were being treated as overlapping when they are disjoint.
 */
const PLAIN_CALL = /\bsanitizeUntrusted\s*\(/g;
const MARKUP_CALL = /\bsanitizeUntrustedMarkup\s*\(/g;

function aiFiles(): { rel: string; src: string }[] {
    return collectSourceFiles({
        roots: ['src/app-layer/ai', 'src/app/api'],
        extensions: ['.ts'],
        skipDirs: ['node_modules', '.next', '.git'],
        floor: 20,
    }).map((abs) => ({
        rel: path.relative(REPO_ROOT, abs),
        src: fs.readFileSync(abs, 'utf8'),
    }));
}

/** Comments stripped, so a docblock explaining the hazard is not a call. */
function code(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
}

describe('external-author text uses the strip-first helper', () => {
    it('prints every call site and the variant it uses', () => {
        const rows = aiFiles()
            .map(({ rel, src }) => {
                const body = code(src);
                const markup = (body.match(MARKUP_CALL) ?? []).length;
                const plain = (body.match(PLAIN_CALL) ?? []).length;
                return { rel, plain, markup };
            })
            .filter((r) => r.plain > 0 || r.markup > 0);

        console.log(`[untrusted-markup] call-site files=${rows.length}`);
        for (const r of rows) {
            console.log(`[untrusted-markup]   ${r.rel} plain=${r.plain} markup=${r.markup}`);
        }
        // A floor: an extraction that stopped matching would otherwise satisfy
        // the assertion below over an empty set.
        expect(rows.length).toBeGreaterThanOrEqual(3);
    });

    it('every MarketNewsItem-handling file uses ONLY the Markup variant', () => {
        const offenders = aiFiles()
            .filter(({ src }) => src.includes('MarketNewsItem'))
            .map(({ rel, src }) => {
                const body = code(src);
                const markup = (body.match(MARKUP_CALL) ?? []).length;
                const plain = (body.match(PLAIN_CALL) ?? []).length;
                return { rel, plain };
            })
            .filter((r) => r.plain > 0);

        expect(
            offenders.map(
                (o) =>
                    `${o.rel} calls the PLAIN sanitizeUntrusted on text that reached it from an RSS feed. ` +
                    `Its anchored role-spoof check is masked by one leading tag — use sanitizeUntrustedMarkup.`,
            ),
        ).toEqual([]);
    });

    it('the Markup helper exists and strips BEFORE checking', () => {
        // Pinning the order, because a refactor that swaps the two calls inside
        // it leaves every test above green: the tag is gone either way, and
        // only the defang differs.
        const src = fs.readFileSync(
            path.join(REPO_ROOT, 'src/app-layer/ai/safety/sanitize-untrusted.ts'),
            'utf8',
        );
        expect(src).toMatch(/return sanitizeUntrusted\(sanitizePlainText\(/);
        expect(src).not.toMatch(/return sanitizePlainText\(sanitizeUntrusted\(/);
    });
});

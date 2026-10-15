/**
 * Every QR code in the product is encoded by ONE function — P6.7 (#1816).
 *
 * ## The failure this prevents
 *
 * The encoding parameters (`QRCode(0, 'M')` — auto version, medium error
 * correction) decide which QR VERSION a given url becomes. Two call sites
 * that drift apart do not fail: they produce two different, individually
 * valid codes for the same farm. That is survivable on a screen, where the
 * code is regenerated on every render, and not survivable on the A6 card,
 * which is printed once and handed out.
 *
 * `src/components/ui/qr-code.tsx` held the only copy until the share card
 * needed the same matrix in node. Rather than a second `QRCode(0, 'M')` in
 * the PDF generator, the encoder moved to `src/lib/qr/matrix.ts` and both
 * consume it.
 *
 * ## The population is DERIVED
 *
 * This does not check two files I happened to know about. It collects every
 * file under `src/` that reaches the `qrcode-generator` library at all, and
 * asserts the set is exactly `{ src/lib/qr/matrix.ts }`. A third surface
 * added next month — a sticker sheet, a market-stall poster — is in scope the
 * day it is written, and fails here if it encodes its own.
 *
 * A guard that listed the known call sites would pass forever while the thing
 * it names stopped being true, which is the shape of defect this repository
 * keeps finding.
 *
 * The walk is `collectSourceFiles`, not a hand-rolled one: its own module
 * records that 37 guards were killed by a gutted private `walk`, and it
 * refuses to return a population below its floor.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/** The one module allowed to reach the library. */
const CANONICAL = 'src/lib/qr/matrix.ts';

const files = collectSourceFiles({
    roots: ['src'],
    exclude: (rel) => /\.(test|spec)\.tsx?$/.test(rel),
    // `src/` is ~1700 files; a floor well under that still catches an
    // exclude predicate or an extension filter that ate the population.
    floor: 500,
}).map((abs) => path.relative(REPO_ROOT, abs));

/**
 * Comments are blanked before the search. A docblock EXPLAINING the encoder —
 * `qr-code.tsx` has one, and so does the canonical module — is not a call
 * site, and counting prose is how a sibling guard in this repo inflated its
 * own population twice. Strings are KEPT: the import specifier being looked
 * for is itself a string literal.
 */
const codeOf = (rel: string) => blankNonCode(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

describe('QR encoding has one definition', () => {
/**
 * Reaching the library, in any form a module can: a static import, a
 * re-export, or `require`. That is the COMPLETE set — an aliased import
 * (`import Q from 'qrcode-generator'`) and a re-export both still name the
 * specifier, so there is no way to encode a QR without matching this.
 *
 * The first version also matched the call shape `/\bQRCode\s*\(/`, meaning to
 * catch an alias this would miss. It had no such gap to cover, and the clause
 * had a false positive instead: `src/components/ui/icons/nucleo/qrcode.tsx`
 * is a static SVG icon that happens to DECLARE `export function QRCode(`. The
 * regex could not tell a declaration from a call, nor an unrelated identifier
 * from this library's factory, and the guard reported an encoder that cannot
 * encode anything. Found on the guard's first run, which is the argument for
 * anchoring on the dependency rather than on a name.
 */
const REACHES_LIBRARY = /(?:from|require\s*\()\s*['"]qrcode-generator['"]/;

const encoders = files.filter((rel) => REACHES_LIBRARY.test(codeOf(rel)));

    it('collected a real population and found the module it guards', () => {
        // The denominator, printed. A scan that collected nothing would pass
        // every assertion below for free.
        expect(files.length).toBeGreaterThanOrEqual(500);
        expect(encoders).toContain(CANONICAL);
    });

    it('is the only file that encodes a QR', () => {
        expect([...encoders].sort()).toEqual([CANONICAL]);
    });

    it('is actually consumed, by both the screen and the printed card', () => {
        // The inverse of the rule above: a canonical module nobody imports is
        // not one definition, it is dead code beside two live copies.
        const consumers = files.filter((rel) =>
            /from\s+['"]@\/lib\/qr\/matrix['"]/.test(codeOf(rel)),
        );
        expect(consumers).toContain('src/components/ui/qr-code.tsx');
        expect(consumers).toContain('src/app-layer/reports/pdf/farm-share-card.ts');
    });

    it('keeps the encoder free of server-only imports, because a client component uses it', () => {
        // `qr-code.tsx` is `'use client'`. A server-only reach from the shared
        // module — a logger, `env`, `getAppBaseUrl` — fails the BUILD with
        // `UnhandledSchemeError: node:async_hooks`, and tsc, lint and every
        // rendered test are blind to it (#1874). So the import list is
        // asserted rather than assumed.
        const imports = [...codeOf(CANONICAL).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
        expect(imports).toEqual(['qrcode-generator']);
    });
});

/**
 * Every namespace a PUBLIC surface reads is one it is actually sent (#1813).
 *
 * ## The failure this exists for
 *
 * The root layout now sends an anonymous visitor only
 * `PUBLIC_SURFACE_NAMESPACES` — **314 bytes of Bulgarian instead of 272,298**,
 * re-measured 2026-10-15. That list is a CLAIM about what the public pages
 * use, and nothing else enforces it.
 *
 * The figure replaces "475 bytes instead of 404,981", which no longer
 * reproduced in either direction: the catalogue is 491,803 bytes ON DISK
 * (4-space indented) and 272,298 SERIALISED, and it is the serialised form
 * that reaches the RSC payload. Quoting a number measured one way and
 * compared another is how a citation rots while the claim it supports stays
 * true — so `the payload stays a rounding error` below now DERIVES it instead
 * of restating it.
 *
 * A public page that reads an unlisted namespace renders **raw keys**:
 * `publicFarm.cropsTitle` on the page where «Култури» should be. next-intl
 * does not throw for a missing namespace in a server component, the HTML is
 * valid, the status is 200, and a reviewer reading the diff sees a correct
 * `getTranslations('somethingElse')` call. The only observer is a visitor.
 *
 * So the list needs a mechanical check, derived from the files rather than
 * maintained beside them.
 *
 * ## Scope, and its honest limit
 *
 * The population is the public surface's own render tree: everything under
 * `src/app/f/**`, plus the root-level `not-found`/`error` pages, which a
 * withdrawn or missing handle reaches — the likeliest path a stranger hits.
 *
 * What it does NOT follow is imports. A shared component three levels down
 * that calls `useTranslations('someNamespace')` would not be seen here. That
 * is a real gap and the reason the list errs wide rather than tight: adding a
 * namespace costs bytes, and omitting one costs a visitor the page's words.
 * A full import-graph walk is the stronger check and a bigger piece of work;
 * recorded here rather than implied.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

import { PUBLIC_SURFACE_NAMESPACES, publicSurfaceMessages } from '@/lib/i18n/public-surface';

/** The public surface's own render tree. */
const EXTRA_FILES = ['src/app/not-found.tsx', 'src/app/error.tsx'];

function publicSurfaceFiles(): string[] {
    const underF = collectSourceFiles({
        roots: ['src/app/f'],
        extensions: ['.ts', '.tsx'],
    });
    const extras = EXTRA_FILES.map((r) => path.join(REPO_ROOT, r)).filter((p) =>
        fs.existsSync(p),
    );
    return [...underF, ...extras];
}

/** Namespaces a file reads, comments blanked so prose cannot add one. */
function namespacesIn(src: string): string[] {
    const code = blankNonCode(src);
    return [
        ...new Set(
            [...code.matchAll(/(?:get|use)Translations\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ),
    ];
}

const FILES = publicSurfaceFiles();

describe('the public i18n payload covers what the public surface reads', () => {
    it('control: the population is not empty', () => {
        // `collectSourceFiles` throws on an empty result, but not on an empty
        // DERIVATION — a glob that stopped matching would make every
        // assertion below vacuous, which is the failure mode this file exists
        // to prevent one level down.
        expect(FILES.length).toBeGreaterThanOrEqual(2);
        expect(PUBLIC_SURFACE_NAMESPACES.length).toBeGreaterThan(0);
    });

    it('control: the extractor finds the namespaces it is looking for', () => {
        // POSITIVE CONTROL. Without it, a regex that stopped matching would
        // report "no unlisted namespaces" for every file.
        expect(namespacesIn("const t = await getTranslations('publicFarm');")).toEqual([
            'publicFarm',
        ]);
        expect(namespacesIn("const t = useTranslations('notFound');")).toEqual(['notFound']);
        // …and it ignores a namespace named only in prose.
        expect(namespacesIn("// uses getTranslations('ghost')\nconst x = 1;")).toEqual([]);
    });

    it('every namespace a public-surface file reads is SENT to it', () => {
        const listed = new Set<string>(PUBLIC_SURFACE_NAMESPACES);
        const unlisted: string[] = [];

        for (const abs of FILES) {
            for (const ns of namespacesIn(fs.readFileSync(abs, 'utf8'))) {
                if (!listed.has(ns)) {
                    unlisted.push(`${path.relative(REPO_ROOT, abs)} reads '${ns}'`);
                }
            }
        }

        if (unlisted.length > 0) {
            throw new Error(
                `${unlisted.length} namespace(s) are read by a public surface but not sent `
                    + `to it:\n  ${unlisted.join('\n  ')}\n\n`
                    + `An anonymous visitor receives only PUBLIC_SURFACE_NAMESPACES, so these `
                    + `render as RAW KEYS — next-intl does not throw, the HTML is valid and `
                    + `the status is 200, so the only observer is the visitor.\n`
                    + `Add the namespace to PUBLIC_SURFACE_NAMESPACES in `
                    + `src/lib/i18n/public-surface.ts, or stop reading it on a public page.`,
            );
        }
        expect(unlisted).toEqual([]);
    });

    it('the payload stays a rounding error — the actual deliverable of #1813', () => {
        // #1813's own text: "the deliverable is not 'fewer files' but a
        // measured reduction in what `/f/[handle]` sends". Every other
        // assertion in this file checks COMPLETENESS — that nothing the
        // public pages read is missing. None of them checks the size, so
        // adding `app` or `common` to PUBLIC_SURFACE_NAMESPACES would ship
        // the whole operator catalogue to anonymous visitors and pass the lot.
        //
        // Measured here rather than quoted, so it cannot drift the way the
        // prose figure above did. JSON.stringify, not the file's byte count:
        // the indented file on disk is ~1.8x the serialised form, and it is
        // the serialised form that `NextIntlClientProvider` puts in the RSC
        // payload.
        for (const locale of ['bg', 'en'] as const) {
            const all = JSON.parse(
                fs.readFileSync(path.join(REPO_ROOT, `messages/${locale}.json`), 'utf8'),
            ) as Record<string, unknown>;
            const sent = publicSurfaceMessages(all);

            const fullBytes = JSON.stringify(all).length;
            const sentBytes = JSON.stringify(sent).length;
            const share = sentBytes / fullBytes;

            // Non-vacuous in both directions: a subset that collapsed to `{}`
            // would satisfy any ceiling, and the public page would render raw
            // keys — which the completeness assertions above would catch, but
            // only if the namespaces are still listed. Assert it carries real
            // copy.
            expect(sentBytes).toBeGreaterThan(100);
            expect(Object.keys(sent).length).toBe(PUBLIC_SURFACE_NAMESPACES.length);

            // 1% is ~8x today's 0.12% — deliberately loose, because this is a
            // REGRESSION bound on a payload that should never grow by an order
            // of magnitude, not a target to optimise against. A new public
            // namespace is expected to move it a little; `app` would blow it.
            //
            // Asserted through an object so a FAILURE prints the numbers that
            // caused it. The first draft of this compared that object to
            // ITSELF, which prints them and can never fail — a tautology
            // dressed as an assertion.
            expect({
                locale,
                withinBudget: share < 0.01,
                share: `${(share * 100).toFixed(3)}%`,
                sentBytes,
                fullBytes,
            }).toMatchObject({ locale, withinBudget: true });
        }
    });

    it('every SENT namespace exists in both catalogues', () => {
        // The other direction: a listed namespace that no catalogue has is a
        // typo that `publicSurfaceMessages` skips silently, so the page it was
        // added for still renders raw keys.
        for (const locale of ['bg', 'en']) {
            const cat = JSON.parse(
                fs.readFileSync(path.join(REPO_ROOT, `messages/${locale}.json`), 'utf8'),
            ) as Record<string, unknown>;
            const missing = PUBLIC_SURFACE_NAMESPACES.filter((ns) => !(ns in cat));
            expect(missing).toEqual([]);
        }
    });
});

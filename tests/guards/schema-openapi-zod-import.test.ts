/**
 * A schema calling `.openapi()` imports `z` from `@/lib/openapi/zod` (#1580).
 *
 * `.openapi()` is added by `extendZodWithOpenApi(z)`, a one-time runtime side
 * effect. The spec generator applies it before loading any schema, so the
 * generated spec is never the thing that breaks. What breaks is a TEST that
 * imports such a module DIRECTLY:
 *
 *     TypeError: zod_1.z.string(...).max(...).openapi is not a function
 *       ● Test suite failed to run
 *
 * The convention is already documented in `src/lib/openapi/zod.ts` — "schema
 * files that don't add `.openapi()` calls keep `import { z } from 'zod'`",
 * i.e. files that DO add them must not. Nothing enforced it.
 *
 * ## Why it is worth a guard rather than two one-line fixes
 *
 * A bare-`zod` file carrying `.openapi()` can work ANYWAY, if something
 * upstream in its import graph happens to pull the extended `z` in first.
 * `catalog.schemas.ts` did exactly that and was imported by a green suite
 * throughout. So the defect is latent and its trigger is an unrelated import
 * change in a different file — and when it fires, the error names zod, not the
 * import line. That is the shape a guard is for: correct today, for a reason
 * nobody chose.
 *
 * Measured when this landed: 41 schema files, 4 calling `.openapi()`, 1 wrong.
 */
import * as fs from 'fs';
import * as path from 'path';

import { collectSourceFiles, REPO_ROOT as ROOT } from '../helpers/collect-files';

const EXTENDED = '@/lib/openapi/zod';

/** Schema files, derived from the filesystem so a new one is covered at once. */
function schemaFiles(): string[] {
    return collectSourceFiles({
        roots: ['src/app-layer/schemas', 'src/lib/schemas'],
        floor: 20,
    });
}

/** Where a file imports `z` from, or null if it does not import one. */
function zImportSource(src: string): string | null {
    const m = /^import \{[^}]*\bz\b[^}]*\} from '([^']+)';/m.exec(src);
    return m ? m[1] : null;
}

const callsOpenapi = (src: string): boolean => /\.openapi\(/.test(src);

describe('a schema calling .openapi() imports the EXTENDED zod', () => {
    it('reports the population it covers', () => {
        const files = schemaFiles();
        const callers = files.filter((f) => callsOpenapi(fs.readFileSync(f, 'utf8')));
        // Printed, because the interesting number is the small one: a regex
        // that stopped matching `.openapi(` would sweep zero and agree.
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(
            `schema files: ${files.length}, of which call .openapi(): ${callers.length}\n  ` +
                callers.map((f) => path.relative(ROOT, f)).join('\n  '),
        );

        expect(files.length).toBeGreaterThanOrEqual(20);
        expect(callers.length).toBeGreaterThanOrEqual(1);
    });

    it('names any file that calls .openapi() with a bare zod import', () => {
        const offenders: string[] = [];
        for (const file of schemaFiles()) {
            const src = fs.readFileSync(file, 'utf8');
            if (!callsOpenapi(src)) continue;
            if (zImportSource(src) !== EXTENDED) {
                offenders.push(`${path.relative(ROOT, file)} (z from ${zImportSource(src)})`);
            }
        }

        expect(offenders).toEqual([]);
    });

    it('does NOT require the extended import of a file that only validates', () => {
        // The other direction, and the reason this is not "every schema file
        // imports the extended zod": `src/lib/openapi/zod.ts` says plainly that
        // files without `.openapi()` keep bare `zod` — no churn forced on
        // schemas outside the documented API surface. A guard that demanded it
        // everywhere would be rewriting 37 files to no effect, and would get
        // reverted rather than obeyed.
        const plain = schemaFiles().filter((f) => {
            const src = fs.readFileSync(f, 'utf8');
            return !callsOpenapi(src) && zImportSource(src) === 'zod';
        });

        expect(plain.length).toBeGreaterThan(0);
    });

    it('the detector has teeth, on synthetic sources', () => {
        const BAD = `import { z } from 'zod';\nexport const A = z.string().openapi({});`;
        const GOOD = `import { z } from '@/lib/openapi/zod';\nexport const A = z.string().openapi({});`;
        const PLAIN = `import { z } from 'zod';\nexport const A = z.string();`;
        const check = (src: string) => callsOpenapi(src) && zImportSource(src) !== EXTENDED;

        expect(check(BAD)).toBe(true);
        expect(check(GOOD)).toBe(false);
        // A file with no `.openapi()` is not an offender however it imports z.
        expect(check(PLAIN)).toBe(false);
    });

    it('a MULTI-LINE import is read, and still flagged', () => {
        // I wrote this expecting the opposite and the test corrected me. The
        // character class `[^}]*` matches newlines, so the `^`-anchored regex
        // spans a multi-line import without needing the `s` flag — the
        // detector is stronger than I credited it with being.
        //
        // Worth pinning rather than deleting: three of the four real callers
        // use a single-line import, so the live population cannot demonstrate
        // this either way, and a future "tidy" of the regex to something
        // line-bounded would silently stop flagging a file that spells its
        // import across several lines.
        const MULTI = `import {\n    z,\n} from 'zod';\nexport const A = z.string().openapi({});`;
        const MULTI_OK = `import {\n    z,\n} from '@/lib/openapi/zod';\nexport const A = z.string().openapi({});`;

        expect(zImportSource(MULTI)).toBe('zod');
        expect(zImportSource(MULTI_OK)).toBe(EXTENDED);
    });
});

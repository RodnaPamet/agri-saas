/**
 * Roadmap-4 PR-5 — date-format hygiene: no rename-aliases on the
 * canonical formatter imports.
 *
 * Two sites used to import the canonical helpers under a different
 * local name:
 *
 *   • api-keys/page.tsx — `import { formatDateTime as formatDate }
 *     from '@/lib/format-date'`. The local name `formatDate`
 *     looked like the absolute-only helper but was actually
 *     `formatDateTime` (with hours + minutes). A reader scanning
 *     the file's JSX (`{formatDate(row.original.expiresAt)}`)
 *     would expect "16 Apr 2026" and get "16 Apr 2026, 08:00".
 *
 *   • date-picker/date-picker.tsx — `import { formatDate as
 *     formatDateForDisplay }`. Less harmful (same shape, just a
 *     longer local name) but the alias signals "we have a local
 *     formatDate" — and there ISN'T one. Pure noise.
 *
 * Steve-Jobs reading: a function should mean what its name says.
 * Aliases break that contract.
 *
 * What this ratchet locks
 *
 *   No `.tsx` / `.ts` file under `src/` may import from
 *   `@/lib/format-date` using a rename-alias (`as <other-name>`).
 *   Use the canonical name verbatim — at every callsite, the
 *   function name is the documentation.
 *
 * What this ratchet does NOT police
 *
 *   - Bare imports (`import { formatDate, formatDateTime } from
 *     …`) — those are fine and the canonical pattern.
 *   - Type-only imports (`import type { … }`) — types are
 *     allowed to be aliased per TS convention.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');

// Match `… as <name>` inside a single-line `import { … } from
// '@/lib/format-date'` statement. The detector is anchored on the
// import-source path so a coincidental "as" elsewhere doesn't
// trip.
const ALIASED_FORMAT_DATE_IMPORT =
    /import\s*\{[^}]*\bas\s+\w+[^}]*\}\s*from\s*['"]@\/lib\/format-date['"]/;

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * Was an inline recursive `walk` inside the `it()` below, so `selector-teeth`
 * found nothing at module scope to mutate, while the assertion
 * `expect(offenders).toEqual([])` is satisfied for free by an emptied walk.
 * `collectSourceFiles` REFUSES an empty result, so the population cannot be
 * empty rather than being emptied and caught (#865).
 *
 * Parity measured BEFORE the change: 2287 files both ways, zero difference,
 * with no exclusions applied identically.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.ts', '.tsx'],
    // EXPLICIT skipDirs: this guard includes `.ts`, and `DEFAULT_SKIP_DIRS`
    // excludes any directory named `coverage` — which is the orthophoto
    // coverage API route here, not a build artefact (#2421, #2517). With the
    // defaults this scan would silently stop reading
    // `src/app/api/t/[tenantSlug]/ortho/coverage/route.ts`.
    skipDirs: ['node_modules', '.next'],
    floor: 600,
});

describe('format-date import discipline (Roadmap-4 PR-5)', () => {
    it('no .tsx / .ts file under src/ uses an "as" alias on a format-date import', () => {
        const offenders: { file: string; line: string }[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
            const src = fs.readFileSync(full, 'utf-8');
            // Iterate line-by-line so the offender entry can
            // include the offending statement verbatim — easier
            // to debug than a "this file has it somewhere" hint.
            for (const line of src.split('\n')) {
                if (ALIASED_FORMAT_DATE_IMPORT.test(line)) {
                    offenders.push({ file: rel, line: line.trim() });
                    break;
                }
            }
        }
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}\n    ${o.line}`)
                .join('\n');
            throw new Error(
                `These imports rename a format-date helper. Drop the "as <alias>" — function names are the documentation.\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

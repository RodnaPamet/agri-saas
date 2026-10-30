/**
 * Roadmap-4 PR-8 — Heading-primitive discipline.
 *
 * The `<Heading>` primitive at `src/components/ui/typography.tsx`
 * defines a deliberately-small three-level type scale:
 *
 *   <Heading level={1}>   text-2xl semibold (page titles)
 *   <Heading level={2}>   text-lg  semibold (major sections)
 *   <Heading level={3}>   text-sm  semibold (sub-sections)
 *
 * Until this ratchet, raw `<h1>` … `<h6>` tags drifted across the
 * codebase (10 sites). Each rolled its own size + weight + tone:
 *
 *   `<h2 className="text-lg font-bold text-content-emphasis">…`
 *   `<h2 className="text-xl font-bold text-content-inverted">…`
 *   `<h1 className="text-xl font-semibold text-gray-900">…`
 *
 * Three flavours, all approximately heading-shaped, none of them
 * using the primitive. The primitive's whole point is to keep
 * the type scale finite — drift here is a slow erosion of the
 * design system.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may render `<h1>` … `<h6>` as a
 *   raw element. Pages MUST reach for `<Heading>` (or its `as=`
 *   override when an outer-level heading already exists in the
 *   section). The detector matches `<hN ` with a following
 *   space or `>` — so `<header`, `<hgroup` etc. are fine.
 *
 *   The allowlist below is small + each entry carries a written
 *   reason. Adding a new entry is a deliberate act, never a
 *   blanket "this file too".
 *
 * What this ratchet does NOT police
 *
 *   - Headings inside MDX / docs files. Out of scope.
 *   - Headings inside server-side PDF rendering
 *     (`src/app-layer/reports/pdf/...`). The `pdfkit` API has
 *     its own typography model.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

interface AllowlistEntry {
    file: string;
    reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
    {
        file: 'src/app/global-error.tsx',
        reason:
            'Next.js App Router root error boundary — replaces the root layout, owns its own <html> / <body>, ships its own CSS module for typography (CSP-compliant). Cannot import client-side primitives that depend on the app shell.',
    },
];

const ALLOWLIST_PATHS = new Set(ALLOWLIST.map((e) => e.file));

/**
 * The scanned population, via the SANCTIONED collector — #2483 class A.
 *
 * This was an inline recursive `walk` inside the `it()` below, so
 * `selector-teeth` reported the file as having no module-level selector: there
 * was nothing at module scope to mutate. The assertion is
 * `expect(offenders).toEqual([])`, which an emptied walk satisfies for free.
 *
 * Migrated rather than hoisted. #2483's remedy is extraction so the auditor can
 * gut the walk; `collectSourceFiles` is stronger because it REFUSES an empty
 * result — the population cannot be empty rather than being emptied and caught.
 * #865: "the guarantee moves from 'we mutated its collector and it noticed' to
 * 'its collector cannot return empty'", and it expects the harness to then
 * report the file NOT AUDITED, which is correct here.
 *
 * Population parity measured BEFORE the change: 871 files by the
 * hand-rolled walk and by this call, zero difference either way.
 * `DEFAULT_SKIP_DIRS` already covers the `node_modules` / `.next` skips.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    exclude: (rel) => ALLOWLIST_PATHS.has(rel),
    floor: 600,
});

const RAW_HEADING_RE = /<h[1-6][\s>]/;

describe('Heading-primitive discipline (Roadmap-4 PR-8)', () => {
    it('every allowlisted file still exists (stale-entry check)', () => {
        const stale: string[] = [];
        for (const entry of ALLOWLIST) {
            if (!fs.existsSync(path.join(ROOT, entry.file))) {
                stale.push(entry.file);
            }
        }
        if (stale.length > 0) {
            throw new Error(
                `These allowlist entries no longer reference real files — drop them from ALLOWLIST:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });

    it('no .tsx file under src/ ships a raw <h1>…<h6> outside the allowlist', () => {
        const offenders: string[] = [];
        for (const full of SCANNED) {
            const rel = path.relative(ROOT, full);
            const src = fs.readFileSync(full, 'utf-8');
            // Strip block + line comments first so JSDoc usage
            // examples ("`<h1>Risks</h1>`") don't false-positive.
            const stripped = blankNonCode(src);
            if (RAW_HEADING_RE.test(stripped)) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `These files render a raw <h1>…<h6> instead of the <Heading> primitive. Use <Heading level={N}> from @/components/ui/typography:\n  ${offenders.join('\n  ')}\n\nIf the file is genuinely outside the in-app type scale (external surface, special boundary, …), add it to ALLOWLIST in this ratchet with a written reason.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

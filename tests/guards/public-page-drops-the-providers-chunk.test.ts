/**
 * The root layout imports `Providers` DYNAMICALLY — #2306.
 *
 * ## Why this needs a guard at all
 *
 * `Providers` renders only in the non-public branch, and
 * `public-surface-skips-app-chrome` already asserts that. But rendering and
 * PAYLOAD are different properties: a static import puts the whole subtree in
 * every route's client bundle whatever the branch renders, which is exactly
 * what `check-public-chunk-payload.mjs`'s docblock says and what it was built
 * to measure.
 *
 * So re-writing `const Providers = dynamic(...)` back to
 * `import { Providers } from './providers'` would keep every existing
 * assertion green while returning 190.5 KB and 608 ms to the public page.
 * Nothing would notice: the payload tool REPORTS bytes and deliberately does
 * not gate on them, so the figures would simply go back up in a log.
 *
 * ## What was measured
 *
 * On the public-farm Lighthouse leg before the change:
 *
 *     bootup-time    624 ms total
 *       608 ms (97%)   41151-*.js   190.5 KB transfer
 *
 * That chunk is zod (449 occurrences, and none of the five provider-only UI
 * libraries), reached by `providers.tsx:6  import '@/lib/zod-jitless'`. The
 * public page's own tree imports zod nowhere.
 *
 * ## `ssr: false` must NOT appear
 *
 * It is rejected in a server component, and it would be wrong regardless:
 * `Providers` wraps `{children}` for the whole application, so disabling its
 * SSR would stop every authenticated page rendering on the server. The goal is
 * code splitting, which `dynamic` gives on its own. Asserted, because the
 * flag is the first thing somebody reaches for when a dynamic import does not
 * behave as expected.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RAW = fs.readFileSync(path.join(REPO_ROOT, 'src/app/layout.tsx'), 'utf8');

/**
 * Comments blanked (#1774). The docblock above the import explains the whole
 * mechanism, so a raw scan would be satisfied by the prose describing the
 * dynamic import rather than the import — and the `ssr: false` assertion below
 * would fail on a comment that merely MENTIONS the flag it forbids.
 */
const CODE = blankNonCode(RAW);

describe('the public page does not download the Providers chunk (#2306)', () => {
    it('imports Providers through next/dynamic, not statically', () => {
        expect(CODE).toMatch(/const Providers = dynamic\(/);
        expect(CODE).toMatch(/import dynamic from 'next\/dynamic'/);
    });

    it('has NO static import of ./providers', () => {
        // The exact regression: one line, every other assertion still green.
        expect(CODE).not.toMatch(/import\s*\{[^}]*\bProviders\b[^}]*\}\s*from\s*'\.\/providers'/);
    });

    it('does NOT pass ssr: false', () => {
        // Rejected in a server component, and it would stop every
        // authenticated page rendering on the server — Providers wraps
        // {children} for the whole app.
        const call = CODE.slice(CODE.indexOf('const Providers = dynamic('));
        expect(call.slice(0, 300)).not.toMatch(/ssr\s*:\s*false/);
    });

    it('still renders Providers only in the non-public branch', () => {
        // The payload change must not have quietly altered WHICH branch
        // renders it — that is `public-surface-skips-app-chrome`'s property,
        // restated here because the two are easy to conflate and this file is
        // where someone editing the import will be looking.
        expect(CODE).toMatch(/isPublic \?/);
        expect(CODE).toMatch(/<Providers\s/);
    });

    it('SELF-TEST: a reverted import is detected', () => {
        // Without this the three assertions above could all be aimed slightly
        // off and nobody would know until the bytes came back.
        const reverted = blankNonCode(
            RAW.replace(
                /const Providers = dynamic\([^;]*;/s,
                "import { Providers } from './providers';",
            ),
        );
        expect(reverted).not.toMatch(/const Providers = dynamic\(/);
        expect(reverted).toMatch(/import\s*\{[^}]*\bProviders\b[^}]*\}\s*from\s*'\.\/providers'/);
    });
});

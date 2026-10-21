/**
 * The VAPID public key reaches the browser at REQUEST time — P7.4 (#1993).
 *
 * ## The defect this locks out
 *
 * `PushOptIn` read `process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY`. A
 * `NEXT_PUBLIC_*` value is inlined by `next build`, this one reached no
 * Dockerfile `ARG`, so every image baked `undefined` — and because the control
 * is "feature-detected + key-gated", the consequence was a button that
 * rendered as unsupported rather than an error anybody could see.
 *
 * Measured in production 2026-10-20, four independent ways: no `ARG` in the
 * Dockerfile's runner stage; `src/lib/geo/basemap-bundle-scan.ts` had already
 * recorded the bundle shape `NEXT_PUBLIC_VAPID_PUBLIC_KEY:nf.env.…` as a
 * bystander while solving the same problem for MapTiler; neither VAPID
 * variable set in the running container; and zero `platform='WEB'`
 * subscription rows ever created.
 *
 * The fix is a prop from a server component. The failure mode of the fix is
 * somebody re-adding the `NEXT_PUBLIC_` mirror "for convenience", which would
 * work on their machine — `next dev` reads `.env` at request time — and bake
 * `undefined` again in CI. So the identifier is forbidden outright.
 *
 * ## Why the page must stay dynamic, and why that is asserted
 *
 * Reading `env` in a server component is request-time only while the page is
 * rendered per request. A statically rendered page would evaluate it once at
 * build and re-bake exactly the old behaviour, with none of the old spelling
 * left to notice. That is the quieter half of this defect class, so the page's
 * dynamism is pinned rather than assumed.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT as ROOT } from '../helpers/collect-files';

const FIELD_PAGE = 'src/app/t/[tenantSlug]/(app)/field/[taskId]/page.tsx';
const LAYOUT = 'src/app/t/[tenantSlug]/layout.tsx';

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel: string): string => blankNonCode(read(rel));

describe('the VAPID public key is served at runtime', () => {
    it('reports the population it sweeps, so a zero would be visible', () => {
        const files = collectSourceFiles({ roots: ['src'], floor: 50 });
        console.log(`[vapid-runtime] swept ${files.length} source files under src/`);
        expect(files.length).toBeGreaterThan(50);
    });

    it('no source file READS a NEXT_PUBLIC VAPID identifier', () => {
        // The detector is the READ — the `process.env` prefix plus the name —
        // not the bare identifier, and it runs on RAW text. Both halves are
        // deliberate.
        //
        // Narrowed to the read, because a `NEXT_PUBLIC_*` value can only be
        // inlined by reading it off `process.env`: the read is the defect and
        // the name alone is not. Several docblocks name the variable precisely
        // because they explain why it is gone — `env.ts` at length, and
        // `basemap-bundle-scan.ts` records the bundle shape it was measured in.
        //
        // Raw rather than blanked, because the forbidden form is then
        // forbidden in PROSE too. That costs one thing — a comment may not
        // spell the exact read, and the docblock in `PushOptIn.tsx` is
        // deliberately worded around it — and buys independence from comment
        // blanking, which cannot be relied on here.
        //
        // It is ALSO what makes this assertion independent of comment
        // blanking, which cannot be relied on here. `blankNonCode` has no
        // regex-literal state, so the three double quotes in
        // `basemap-bundle-scan.ts:99` (`/NEXT_PUBLIC_MAPTILER_KEY:"[^"]+"/`)
        // open a string that swallows every comment after it — that file's
        // prose reads as code to any caller. #2106 has the measurement (13
        // files under `src/`, two independent causes) and the fix; until it
        // lands, a guard whose correctness depends on blanking that file is a
        // guard that reports the wrong thing.
        const offenders: string[] = [];
        for (const abs of collectSourceFiles({ roots: ['src'], floor: 50 })) {
            const rel = path.relative(ROOT, abs).split(path.sep).join('/');
            if (/process\.env\.NEXT_PUBLIC_VAPID/.test(fs.readFileSync(abs, 'utf8'))) {
                offenders.push(rel);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('env.ts no longer DECLARES a NEXT_PUBLIC VAPID key', () => {
        // The other half: a schema entry is what makes the identifier
        // available to read in the first place, and `env.ts` carries neither a
        // regex literal nor an emoji, so blanking is trustworthy there.
        const c = code('src/env.ts');

        expect(c).not.toMatch(/NEXT_PUBLIC_VAPID/);
        // The control — the server-side key it replaced must still be declared,
        // or this assertion would pass on a file that lost both.
        expect(c).toMatch(/VAPID_PUBLIC_KEY/);
    });

    it('the field page reads the server-side key and passes it down', () => {
        const c = code(FIELD_PAGE);

        expect(c).toMatch(/env\.VAPID_PUBLIC_KEY/);
        expect(c).toMatch(/vapidPublicKey=\{/);
    });

    it('PushOptIn takes the key as a REQUIRED prop', () => {
        // Required, not optional. An optional prop would let a caller omit it
        // and silently get the old "unsupported" render back — the defect
        // restored with no diff resembling it.
        const c = code('src/components/pwa/PushOptIn.tsx');

        expect(c).toMatch(/vapidPublicKey:\s*string\s*\|\s*null/);
        expect(c).not.toMatch(/vapidPublicKey\?:/);
    });

    it('the field page is rendered per request, not statically', () => {
        const page = code(FIELD_PAGE);
        const layout = code(LAYOUT);

        // Two independent reasons it is dynamic today. Either alone suffices;
        // both are asserted because losing one silently is the realistic
        // change, and the assertion should survive that rather than pass on a
        // reason that moved.
        const awaitsParams = /await\s+params/.test(page);
        const layoutOptsOut = /noStore\(\)/.test(layout);

        expect(awaitsParams || layoutOptsOut).toBe(true);
        // And nothing has forced it static.
        expect(page).not.toMatch(/force-static/);
        expect(page).not.toMatch(/export\s+const\s+revalidate\s*=/);
    });

    it('the detector has teeth, on synthetic sources', () => {
        const BAD = `const K = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;`;
        const GOOD = `export function PushOptIn({ vapidPublicKey }: { vapidPublicKey: string | null }) {}`;
        const COMMENT_ONLY = `// NEXT_PUBLIC_VAPID_PUBLIC_KEY was removed in #1993\nconst K = null;`;
        const OPTIONAL = `function P({ vapidPublicKey }: { vapidPublicKey?: string }) {}`;

        const reads = (src: string) => /NEXT_PUBLIC_VAPID/.test(blankNonCode(src));
        const isOptional = (src: string) => /vapidPublicKey\?:/.test(blankNonCode(src));

        expect(reads(BAD)).toBe(true);
        expect(reads(GOOD)).toBe(false);
        // The case that makes comment-blanking load-bearing: the docblocks
        // explaining this fix all name the variable.
        expect(reads(COMMENT_ONLY)).toBe(false);
        expect(isOptional(OPTIONAL)).toBe(true);
        expect(isOptional(GOOD)).toBe(false);
    });
});

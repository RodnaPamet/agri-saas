#!/usr/bin/env tsx
/**
 * `src/app/**\/page.tsx` → `src/lib/assistant/generated/page-routes.ts` — #2578.
 *
 *   npx tsx scripts/generate-page-routes.ts            # write
 *   npx tsx scripts/generate-page-routes.ts --check     # exit 1 on drift
 *
 * `--check` is what CI runs, for the reason the token generator's does:
 * regenerating the output and verifying it in one step would make a moved page
 * a green diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pageTemplates, renderPageRoutesModule, ROOT } from './lib/page-routes';

const TARGET_REL = 'src/lib/assistant/generated/page-routes.ts';
// An env seam so a test can drive the real CLI over a temp destination, the
// same shape `detect-secrets.sh` uses for its `PATTERN_FILE`. The destination
// is never interpolated into a log: it derives from the environment, and
// CodeQL correctly reads that as an env value reaching output (#2584).
const TARGET = process.env.PAGE_ROUTES_TARGET
    ? path.resolve(process.env.PAGE_ROUTES_TARGET)
    : path.join(ROOT, TARGET_REL);

const templates = pageTemplates();
if (templates.length === 0) {
    // An empty derivation would make every `route` invalid and the assistant
    // reject every request with a context. Refuse loudly instead: an empty
    // population is the one result that cannot be correct here.
    console.error('::error::no page templates derived from src/app — refusing to write an empty module.');
    process.exit(1);
}
const rendered = renderPageRoutesModule(templates);

if (process.argv.includes('--check')) {
    let current = '';
    try {
        current = readFileSync(TARGET, 'utf8');
    } catch {
        console.error('::error::page-routes module is MISSING. Run `npm run page-routes:generate`.');
        process.exit(1);
    }
    if (current !== rendered) {
        console.error(
            '::error::page-routes module is STALE against src/app. '
                + 'Run `npm run page-routes:generate` and commit the result.',
        );
        process.exit(1);
    }
    console.log(`[page-routes] in sync — ${templates.length} template(s)`);
    process.exit(0);
}

writeFileSync(TARGET, rendered, 'utf8');
console.log(
    `[page-routes] wrote ${templates.length} template(s) to `
        + (process.env.PAGE_ROUTES_TARGET ? 'the PAGE_ROUTES_TARGET override' : TARGET_REL),
);

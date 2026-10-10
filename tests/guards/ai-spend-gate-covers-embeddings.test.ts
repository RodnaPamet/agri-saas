/**
 * Every path that spends AI tokens passes `assertAiSpendAllowed` (#1345).
 *
 * ## Why a DERIVED population and not a list
 *
 * `assertAiBudget` was called from exactly one file — `ai/routing.ts` — which
 * is a real choke point for COMPLETIONS and not one for anything else. Three
 * paths reached a provider without going through routing, and nothing noticed:
 * two embedding paths and, more expensively, `usecases/rag.ts` calling
 * `.complete()` directly with no budget check at all.
 *
 * A guard naming today's three files would say nothing about the fourth. So
 * the population comes from the FILESYSTEM: any file under `src/` that reaches
 * an AI provider must either gate or be recorded as deliberately exempt, and a
 * new bypass fails this test until somebody decides which it is.
 *
 * ## What makes this worth a gate rather than a convention
 *
 * `assertAiBudget` carries P3.5f's unverified-farm rule — a SaaS tenant whose
 * farm is not verified has NO budget, whatever its plan. That has shipped, so
 * "an unverified farm cannot spend" is a guarantee the product makes today, and
 * an ungated path is not a cost inefficiency but a false guarantee.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = join(__dirname, '..', '..');
const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

/**
 * Strip comments BEFORE matching.
 *
 * The first version of this guard did not, and it put `src/env.ts` in the
 * population off a `//` line quoting `getAiProvider().embed()` in prose — and
 * the §4 case meant to catch that used a `/** *\/` block, so it passed while
 * the real form sailed through. Four of the eight files mentioning a provider
 * factory mention it only in a docblock, including two that say they go
 * through routing precisely so a reader does not think they bypass it.
 *
 * A grep hit in a comment usually means the opposite of what it looks like.
 */
function codeOnly(src: string): string {
    return blankNonCode(src)
        .replace(/\s\/\/.*$/gm, '');
}

/**
 * Names a provider factory, OR imports a model SDK directly.
 *
 * The SDK clause is the one the first version missed entirely, and it covers
 * the majority of spending files: five of the ten reach a model through
 * `@anthropic-ai/sdk` rather than through the factory. A matcher built only on
 * the factory sees three paths and calls the population complete.
 */
const USES_FACTORY =
    /\b(getAiProvider|getEmbeddingProvider)\b|from\s+'@anthropic-ai\/sdk'|from\s+'openai'/;
/**
 * …and actually calls something that spends. Separate from the factory match
 * because `provider/index.ts` DEFINES the factories and spends nothing, and a
 * single combined regex forces the inline `getX().method()` spelling — which
 * would miss a file that assigns the provider to a variable first.
 */
const CALLS_MODEL =
    /\.\s*(complete|embed|stream)\s*\(|\.\s*(messages|chat|completions|embeddings)\s*\.\s*create\s*\(/;
/**
 * The gate being CALLED — not merely imported.
 *
 * The first version matched the bare name, which the `import { … }` statement
 * satisfies. So removing `await assertAiSpendAllowed(ctx)` from all three
 * gated files reddened NOTHING: the import line kept the guard green while the
 * call was gone. "Wired is not delivered", inside the guard meant to enforce
 * exactly that.
 *
 * Requiring the open paren fixes it, and import lines are stripped as well so
 * a future `import { assertAiSpendAllowed as g }` cannot reintroduce it.
 */
const GATED = /\b(assertAiSpendAllowed|assertAiBudget|completeWithRouting)\s*\(/;

/** Drop import statements before asking whether the gate is CALLED. */
function withoutImports(src: string): string {
    return src.replace(/^\s*import\s[\s\S]*?from\s+'[^']+';\s*$/gm, '');
}

const ALL = collectSourceFiles({ roots: ['src'] });

/**
 * Files that reach a provider and are deliberately NOT gated, each with the
 * reason. A "no stale entries" test below removes the cover as soon as the
 * file stops reaching a provider.
 */
const DELIBERATELY_UNGATED: Readonly<Record<string, string>> = {
    // ── The mechanism, not consumers of it ──
    'src/app-layer/ai/provider/index.ts':
        'Defines getAiProvider and getEmbeddingProvider and spends nothing itself; this is the mechanism the gate protects, not a consumer of it.',
    'src/app-layer/ai/provider/claude-provider.ts':
        'A provider IMPLEMENTATION: it is what a gated caller calls, so gating it would charge the budget twice for one request and would gate the router against itself.',
    'src/app-layer/ai/provider/openai-compatible-provider.ts':
        'A provider IMPLEMENTATION, same reasoning as claude-provider — the spend is attributed at the caller, which is where the tenant is known.',
    'src/app-layer/ai/vision/claude-vision-provider.ts':
        'A provider implementation for the vision surface; its callers hold the RequestContext and are where a budget decision belongs.',

    // ── GLOBAL, tenant-less jobs: there is no tenant budget to charge ──
    //
    // Not an oversight, and this is the half #1345's suggested fix would have
    // broken. The issue proposed gating at the provider factory as "the point
    // every path reaches"; these three do not reach it at all. They talk to
    // the Anthropic Messages API directly BECAUSE the router needs a tenant
    // `RequestContext` to resolve budget and model policy, and a global job
    // has none to supply. Each says so in its own docblock —
    // `field-briefing.ts` is the documented template the other two copy.
    //
    // `assertAiSpendAllowed(ctx)` cannot be called here: there is no ctx, and
    // inventing one would charge an arbitrary tenant for platform work.
    //
    // What IS missing is a PLATFORM-level cap on this spend — these jobs have
    // no ceiling of any kind. That is a different control from a per-tenant
    // budget and is filed separately rather than smuggled in here.
    'src/app-layer/ai/field-briefing.ts':
        'GLOBAL fail-safe helper with no tenant RequestContext — the repo template for this pattern. Gates on env.ANTHROPIC_API_KEY and returns null rather than throwing; there is no tenant whose budget could be charged.',
    'src/app-layer/ai/news-event-extractor.ts':
        'GLOBAL: MarketNewsItem is a tenant-less table and the daily job that calls this has no ctx. Returns an empty array on any failure, so extraction is advisory and degrades to "nothing proposed today".',
    'src/app-layer/ai/support-scheme-extractor.ts':
        'GLOBAL subsidy extraction, copied in shape from field-briefing for the same reason: a global job has no tenant, so there is no per-tenant budget to assert against.',
};

const SPENDING = ALL.map(rel).filter((p) => {
    const code = codeOnly(readFileSync(join(ROOT, p), 'utf8'));
    return USES_FACTORY.test(code) && CALLS_MODEL.test(code);
});

describe('§1 the population this covers', () => {
    it('prints the denominator, so an empty selection is visible', () => {
        // If the matcher ever stops recognising how a provider is reached —
        // a rename, a wrapper, a destructured import — this drops toward zero
        // and every assertion below passes vacuously. That is the failure this
        // line exists to make loud.
        // eslint-disable-next-line no-console -- the denominator IS the output
        console.log(
            `[ai-spend] files reaching a provider: ${SPENDING.length}\n  ` +
                SPENDING.join('\n  '),
        );
        expect(SPENDING.length).toBeGreaterThan(0);
    });
});

describe('§2 every spending path is gated, or recorded as not', () => {
    it.each(SPENDING)('%s', (path) => {
        const code = withoutImports(codeOnly(readFileSync(join(ROOT, path), 'utf8')));
        const gated = GATED.test(code);
        const exempt = path in DELIBERATELY_UNGATED;

        if (!gated && !exempt) {
            throw new Error(
                `${path} reaches an AI provider and does not call assertAiSpendAllowed ` +
                    `(nor assertAiBudget / completeWithRouting).\n\n` +
                    `Either gate it, or add an entry to DELIBERATELY_UNGATED in this file ` +
                    `with the reason. An ungated path is not a cost inefficiency: ` +
                    `assertAiBudget carries P3.5f's unverified-farm rule, so bypassing it ` +
                    `means an unverified farm CAN spend, which the product says it cannot.`,
            );
        }
        // Not both — an exemption for a file that gates anyway is a stale
        // reason nobody will re-read.
        expect(gated && exempt).toBe(false);
    });
});

describe('§3 the exemption list has no stale entries', () => {
    it.each(Object.keys(DELIBERATELY_UNGATED))('%s still reaches a model', (path) => {
        // Checked against USES_FACTORY rather than SPENDING, because the
        // factory file is exempt precisely BECAUSE it calls nothing — asserting
        // it is in SPENDING is what made the earlier bogus `routing.ts` entry
        // look valid.
        const code = codeOnly(readFileSync(join(ROOT, path), 'utf8'));
        expect(USES_FACTORY.test(code)).toBe(true);
    });

    it('every entry carries a real reason', () => {
        for (const [path, reason] of Object.entries(DELIBERATELY_UNGATED)) {
            expect(reason.length).toBeGreaterThan(40);
            expect(reason).not.toMatch(/TODO|TBD|FIXME/i);
            expect(path).toBeTruthy();
        }
    });
});

describe('§4 the detector can tell gated from ungated', () => {
    // A guard whose matcher cannot produce a failing input is green for ever,
    // so both directions are driven against synthetic sources rather than
    // trusting the regexes above.
    it('recognises a bypass', () => {
        const bypass = `
            import { getEmbeddingProvider } from '@/app-layer/ai/provider';
            export async function leak(ctx) {
                return getEmbeddingProvider().embed({ texts: ['x'] });
            }`;
        expect(USES_FACTORY.test(bypass) && CALLS_MODEL.test(bypass)).toBe(true);
        expect(GATED.test(bypass)).toBe(false);
    });

    it('recognises a DIRECT SDK path, not only the factory', () => {
        // Five of the ten spending files reach a model this way. A matcher
        // built only on the factory sees three paths and reports the
        // population as complete.
        const sdk = `
            import Anthropic from '@anthropic-ai/sdk';
            const r = await client.messages.create({ model: 'x', messages: [] });`;
        expect(USES_FACTORY.test(sdk)).toBe(true);
        expect(CALLS_MODEL.test(sdk)).toBe(true);
    });

    it('recognises a bypass that assigns the provider to a VARIABLE first', () => {
        // The spelling a single combined regex would miss, and the reason the
        // factory match and the call match are separate.
        const indirect = `
            const p = getEmbeddingProvider();
            const v = await p.embed({ texts: ['x'] });`;
        expect(USES_FACTORY.test(indirect) && CALLS_MODEL.test(indirect)).toBe(true);
    });

    it('an IMPORT of the gate is not a CALL to it', () => {
        // The defect the first version of this guard shipped with: removing
        // the call from all three gated files reddened nothing, because the
        // import line matched. Mutation-proved — this is the assertion that
        // notices.
        const importedNotCalled = `
            import { assertAiSpendAllowed } from '@/app-layer/ai/budget';
            import { getEmbeddingProvider } from '@/app-layer/ai/provider';
            export async function leak(ctx) {
                return getEmbeddingProvider().embed({ texts: ['x'] });
            }`;
        const code = withoutImports(codeOnly(importedNotCalled));
        expect(USES_FACTORY.test(codeOnly(importedNotCalled))).toBe(true);
        expect(GATED.test(code)).toBe(false);
    });

    it('recognises a gated path', () => {
        const ok = `
            import { getEmbeddingProvider } from '@/app-layer/ai/provider';
            import { assertAiSpendAllowed } from '@/app-layer/ai/budget';
            export async function fine(ctx) {
                await assertAiSpendAllowed(ctx);
                return getEmbeddingProvider().embed({ texts: ['x'] });
            }`;
        expect(USES_FACTORY.test(ok)).toBe(true);
        expect(CALLS_MODEL.test(ok)).toBe(true);
        expect(GATED.test(withoutImports(ok))).toBe(true);
    });

    it('does not mistake a COMPLETION bypass for a non-spending file', () => {
        // The case #1345's own table got wrong: `usecases/rag.ts` was listed
        // under embeddings and actually calls `.complete()`. A matcher that
        // only looked for `embed` would have missed the most expensive bypass
        // in the repo.
        const completionBypass = `const c = await getAiProvider().complete({ messages: [] });`;
        expect(USES_FACTORY.test(completionBypass) && CALLS_MODEL.test(completionBypass)).toBe(true);
    });

    it.each([
        ['a block docblock', '/** Uses getEmbeddingProvider().embed() for RAG. */'],
        ['a LINE comment', '// embeddings endpoint, so `getAiProvider().embed()` throws'],
        ['a trailing comment', 'const x = 1; // see getEmbeddingProvider().embed()'],
    ])('ignores %s that merely mentions a provider', (_label, prose) => {
        // All three spellings, because the first version of this test used
        // only the block form and `src/env.ts` entered the population off a
        // LINE comment — the case the test was for, in the form it did not
        // cover.
        const code = codeOnly(prose);
        expect(USES_FACTORY.test(code) && CALLS_MODEL.test(code)).toBe(false);
    });
});

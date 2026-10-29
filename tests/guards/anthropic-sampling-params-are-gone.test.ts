/**
 * No Anthropic Messages call passes `temperature`, `top_p` or `top_k` — #2437.
 *
 * ## Why a guard, when `tsc` already failed
 *
 * `@anthropic-ai/sdk` v1 pins `anthropic-version: 2026-10-21`, and that API
 * version removed all three sampling parameters from the Messages API. They
 * are absent from the SDK's types entirely — not renamed, not moved — so there
 * is no field to forward them to.
 *
 * `tsc` caught **five of the seven** call sites. It missed two, and the two it
 * missed are the dangerous ones:
 *
 * ```ts
 * ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
 * ```
 *
 * **TypeScript's excess-property check does not apply to spread expressions.**
 * Only a direct object literal is checked, so these two compiled clean against
 * the new SDK while sending a parameter the API no longer accepts — a failure
 * that would have surfaced in production rather than in CI. The error count
 * understated the blast radius, and nothing about the five visible errors
 * pointed at the two invisible ones.
 *
 * That is the whole reason this file exists: the compiler cannot express the
 * rule, so the rule needs its own detector.
 *
 * ## The population is DERIVED, not listed
 *
 * Files that actually CALL `messages.create(` / `messages.stream(`. Deliberately
 * not "files importing the SDK": `provider/types.ts` imports it for types and
 * legitimately still declares `temperature?: number`, because
 * `OpenAiCompatibleProvider` and the OpenRouter call in `llm-client.ts` both
 * honour it. A rule keyed on the import would forbid that declaration and push
 * someone to delete a field two other backends use.
 *
 * `chat.completions.create` — the OpenAI shape — is excluded for the same
 * reason, and asserted below so the rule cannot creep onto that path.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectTrackedFiles } from '../helpers/collect-files';

const ROOT = join(__dirname, '../..');

/**
 * The installed package root.
 *
 * This was `dirname(require.resolve('@anthropic-ai/sdk/package.json'))` on the
 * claim that every package exposes `./package.json`. **It does not** — this
 * one's `exports` map omits it, and Jest's resolver threw
 * `Cannot find module '@anthropic-ai/sdk/package.json'`. Recorded rather than
 * quietly replaced, because the plausible-sounding version was wrong.
 *
 * A plain path it is. The point of the change that brought me here was never
 * the resolver: it was reading EVERY `.d.ts` instead of one hardcoded file,
 * and this keeps that while dropping the `resources/messages/` segment
 * `one-catalogue-reader` objects to.
 */
const SDK_ROOT = join(ROOT, 'node_modules/@anthropic-ai/sdk');

/**
 * Every `.d.ts` the installed SDK ships.
 *
 * `readdirSync` throws on a missing root, which is what we want: a package
 * that moved must fail LOUDLY here, not return `[]` and let the premise check
 * report the parameters absent having read nothing.
 */
function sdkTypeFiles(dir: string = SDK_ROOT): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) out.push(...sdkTypeFiles(abs));
        else if (name.endsWith('.d.ts')) out.push(abs);
    }
    return out;
}

/** Removed by API version 2026-10-21. */
const REMOVED = ['temperature', 'top_p', 'top_k'] as const;

const CALL = /messages\.(create|stream)\(/;

/**
 * The SHARED collector, not a walk of my own. A hand-rolled one can be gutted
 * to return `[]` and every assertion below then passes over nothing — and
 * since the defect this file guards is already invisible to `tsc`, an empty
 * population would restore exactly the silence it was written to end.
 * `collectTrackedFiles` throws on an empty result and takes a floor.
 * Enforced by `tests/guards/file-collection-is-not-silently-empty.test.ts`,
 * which is how the first version of this file was caught.
 */
const ALL = collectTrackedFiles({
    roots: ['src'],
    extensions: ['.ts', '.tsx'],
    floor: 500,
});
const CALLERS = ALL.filter((f) => CALL.test(readFileSync(f, 'utf8')));

describe('Anthropic sampling params are gone from the API (#2437)', () => {
    it('[anthropic-sampling] ranges over a real set', () => {
        console.log(
            `[anthropic-sampling] ${ALL.length} .ts/.tsx under src/; `
                + `${CALLERS.length} call messages.create/stream: `
                + CALLERS.map((f) => relative(ROOT, f)).join(', '),
        );
        // A regex that stopped matching would make the rule below pass over
        // nothing — and since the defect it guards is INVISIBLE to tsc, an
        // empty population would restore exactly the silence this file was
        // written to end.
        expect(ALL.length).toBeGreaterThanOrEqual(500);
        expect(CALLERS.length).toBeGreaterThanOrEqual(5);
    });

    it.each(CALLERS.map((f) => [relative(ROOT, f), f] as const))(
        '%s passes no removed sampling parameter',
        (label, file) => {
            // Comments blanked: the docblock in `types.ts` NAMES all three
            // parameters to explain why they are gone, and a detector that
            // read raw text would count an explanation as a violation.
            const code = blankNonCode(readFileSync(file, 'utf8'));
            const found = REMOVED.filter((p) => new RegExp(`\\b${p}\\b`).test(code));
            expect({ file: label, found }).toEqual({ file: label, found: [] });
        },
    );

    it('the premise still holds: the SDK really has no such parameters', () => {
        // THE EXPIRY. If a future API version reintroduces these, this guard
        // would go on forbidding something legal and the next reader would
        // have only the assertion, not the reason. So the reason is checked:
        // fail HERE, pointing at the SDK, rather than silently outliving it.
        //
        // EVERY `.d.ts` in the package, located through `require.resolve`, not
        // one hardcoded path. Two reasons, and the second is why this changed:
        //   · a single file answers only for that file, and upstream moves
        //     declarations between them — a path that stops existing would read
        //     as "the parameters are gone" for the wrong reason (the
        //     `readFileSync` would throw, so that one fails loudly, but a file
        //     that merely stopped holding them would not);
        //   · the hardcoded path contained `resources/messages/`, which tripped
        //     `one-catalogue-reader`'s "path construction into messages/" rule.
        //     That detector is right to be broad — its docblock records two
        //     narrower versions leaking — and dodging it by splitting the string
        //     literal would be the contrivance it warns against. Resolving the
        //     package removes the path instead of hiding it.
        const files = sdkTypeFiles();
        // The denominator, and a floor: an empty walk would make the loop below
        // assert nothing and report the premise confirmed having read no types.
        expect(files.length).toBeGreaterThan(20);

        const offenders: string[] = [];
        for (const file of files) {
            const types = readFileSync(file, 'utf8');
            for (const param of REMOVED) {
                if (new RegExp(`\\b${param}\\b`).test(types)) {
                    offenders.push(`${relative(SDK_ROOT, file)} mentions ${param}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the SDK is the v1 generation this rule is about', () => {
        const v = JSON.parse(
            readFileSync(join(SDK_ROOT, 'package.json'), 'utf8'),
        ).version as string;
        // On v0 the parameters were valid, so the rule would be wrong.
        expect(Number(v.split('.')[0])).toBeGreaterThanOrEqual(1);
    });

    it('the detector can see a violation (positive control)', () => {
        // Both forms — the literal tsc catches, and the spread it does not.
        const literal = 'await c.messages.create({ model: m, temperature: 0 });';
        const spread = 'await c.messages.create({ ...(t !== undefined ? { top_p: t } : {}) });';
        for (const sample of [literal, spread]) {
            const code = blankNonCode(sample);
            expect(REMOVED.some((p) => new RegExp(`\\b${p}\\b`).test(code))).toBe(true);
        }
        // And it must NOT fire on the word inside a comment, which is what
        // lets `types.ts` keep explaining itself.
        expect(
            REMOVED.some((p) =>
                new RegExp(`\\b${p}\\b`).test(blankNonCode('// temperature was removed\nconst a = 1;')),
            ),
        ).toBe(false);
    });

    it('the OpenAI-compatible path is deliberately NOT in the population', () => {
        // It calls `chat.completions.create`, a different API that still
        // accepts `temperature` — and it does pass it. If it ever landed in
        // CALLERS, the rule above would demand a change that breaks it, so
        // the exclusion is pinned rather than left to the regex's shape.
        const openai = join(ROOT, 'src/app-layer/ai/provider/openai-compatible-provider.ts');
        expect(CALLERS).not.toContain(openai);
        const code = blankNonCode(readFileSync(openai, 'utf8'));
        expect(code).toContain('chat.completions.create');
        expect(code).toContain('temperature');
    });
});

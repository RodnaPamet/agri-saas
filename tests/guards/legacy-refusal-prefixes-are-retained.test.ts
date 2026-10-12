/**
 * Five refusals keep their legacy `lower_snake:` prefix in `message` (#1679).
 *
 * ## What this protects, and from whom
 *
 * Before #1679 these five had **no error code** — the prefix at the start of
 * `message` was their only identifier, and `agrent-ios` matches on it
 * (`UserMessage.swift`: `code == "FORBIDDEN" && message.hasPrefix(
 * "plan_limit_exceeded")`), checked BEFORE its code table. **Every installed
 * build does this.**
 *
 * So deleting the prefix does not break a future client — it breaks the ones
 * already on farmers' phones. For `plan_limit_exceeded` the consequence is
 * specific: the match fails, the phone falls through to the generic `FORBIDDEN`
 * copy — «Нямате права» — and sends a farmer to the farm owner for a plan
 * limit that no permission lifts (agrent-ios#241).
 *
 * The prefix now looks like leftover noise beside a real `code` and real
 * `params`, which is exactly why it needs a guard rather than a comment: the
 * next person to tidy these messages has every reason to think it is dead.
 *
 * ## When this may be deleted
 *
 * When `agrent-ios` has shipped the codes AND the builds that only know the
 * prefix are out of circulation. That is their call to make, not this repo's,
 * because only they can see the installed-version spread. Delete this guard and
 * the prefixes in the same PR, with their confirmation linked.
 *
 * It is deliberately NOT tied to #1677's server-side localisation either. That
 * ruling makes `message` a translated sentence — which would remove the prefix
 * as a side effect, for every one of these five, on whatever release it lands
 * in. That ordering is the one thing #1679 exists to prevent, and this guard is
 * what makes the collision loud instead of silent.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const REPO = path.resolve(__dirname, '../..');

/** code → the legacy token its `message` must still begin with. */
const RETAINED: ReadonlyArray<readonly [string, string, string]> = [
    ['PLAN_LIMIT_EXCEEDED', 'plan_limit_exceeded', 'src/lib/billing/entitlements.ts'],
    ['AI_TIER_NOT_ALLOWED', 'ai_tier_not_allowed', 'src/lib/billing/entitlements.ts'],
    ['AI_BUDGET_EXCEEDED', 'ai_budget_exceeded', 'src/app-layer/ai/budget.ts'],
    ['MODULE_DISABLED', 'module_disabled', 'src/app-layer/usecases/modules.ts'],
    ['BILLING_UNAVAILABLE', 'billing_unavailable', 'src/app/api/t/[tenantSlug]/billing/checkout/route.ts'],
    ['BILLING_UNAVAILABLE', 'billing_unavailable', 'src/app/api/t/[tenantSlug]/billing/portal/route.ts'],
];

const read = (rel: string): string =>
    blankNonCode(fs.readFileSync(path.join(REPO, rel), 'utf8'));

describe('legacy refusal prefixes are retained (#1679)', () => {
    it('prints the denominator', () => {
        expect(RETAINED.length).toBe(6);
        console.log(
            `[legacy-refusal-prefixes] ${RETAINED.length} call site(s), ` +
                `${new Set(RETAINED.map(([c]) => c)).size} distinct code(s)`,
        );
    });

    it.each(RETAINED)(
        '%s still begins its message with `%s:`',
        (code, token, file) => {
            const src = read(file);
            // The code and the token must appear in ONE call, in that order,
            // with the token at the start of the message argument. Asserted on
            // the call shape rather than "both strings are in the file",
            // because the latter passes when the prefix has moved to an
            // unrelated throw or survives only in a comment.
            const call = new RegExp(
                `codedForbidden\\(\\s*'${code}'\\s*,\\s*[\`'"]${token}:`,
            );
            expect(src).toMatch(call);
        },
    );

    it.each(RETAINED)('%s passes params, not just a code', (code, _token, file) => {
        // The prefix is transitional; `params` is the thing that replaces it.
        // A site that kept the prefix and shipped no params would satisfy the
        // assertion above and leave the client exactly where it was.
        const src = read(file);
        const idx = src.indexOf(`'${code}'`);
        expect(idx).toBeGreaterThan(-1);
        // The call's closing `);` within a generous window, then look for an
        // object literal before it.
        const window = src.slice(idx, idx + 600);
        const end = window.indexOf('\n        );') >= 0
            ? window.indexOf('\n        );')
            : window.indexOf(');');
        expect(window.slice(0, end === -1 ? undefined : end)).toMatch(/\{[^}]*\}/);
    });

    it('the call-shape regex can tell a bare code from a prefixed one — positive control', () => {
        // `a-probe-with-no-discriminating-power`: every `.each` above passes
        // the same way when the regex is broken as when the code is right.
        const re = /codedForbidden\(\s*'PLAN_LIMIT_EXCEEDED'\s*,\s*[`'"]plan_limit_exceeded:/;
        expect(
            "throw codedForbidden('PLAN_LIMIT_EXCEEDED', `plan_limit_exceeded: FREE…`, {})",
        ).toMatch(re);
        // The shape a well-meaning cleanup produces.
        expect(
            "throw codedForbidden('PLAN_LIMIT_EXCEEDED', 'You have reached your plan limit.', {})",
        ).not.toMatch(re);
        // And a mention in prose is not the call.
        expect(blankNonCode("// codedForbidden('PLAN_LIMIT_EXCEEDED', `plan_limit_exceeded: x`)\n"))
            .not.toMatch(re);
    });

    it('no OTHER coded refusal grew a lower_snake prefix', () => {
        // The inverse, and the reason #1679 was filed: a prefix in a human
        // field is a protocol in the wrong place. These six are grandfathered;
        // a seventh is the defect returning.
        // `collectSourceFiles`, not a hand-rolled walk —
        // `tests/guards/file-collection-is-not-silently-empty.test.ts` requires
        // it and caught this file's first draft. The shared collector is what
        // supplies the `floor`, so a renamed `src/` names itself instead of
        // scanning nothing and reporting the tree clean (#875). Second time
        // today I reached for `readdirSync` first; it is the default habit and
        // the meta-guard is the thing that corrects it.
        const offenders: string[] = [];
        const files = collectSourceFiles({
            roots: ['src'],
            extensions: ['.ts', '.tsx'],
            exclude: (rel) => rel.startsWith('src/generated/'),
            floor: 1000,
        });
        for (const abs of files) {
            const src = blankNonCode(fs.readFileSync(abs, 'utf8'));
            for (const m of src.matchAll(
                /coded[A-Za-z]+\(\s*'([A-Z0-9_]+)'\s*,\s*[`'"]([a-z][a-z0-9_]{4,}):/g,
            )) {
                const rel = path.relative(REPO, abs);
                if (!RETAINED.some(([c, t, f]) => c === m[1] && t === m[2] && f === rel)) {
                    offenders.push(`${rel}  ${m[1]} / ${m[2]}:`);
                }
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} coded refusal(s) put a machine-readable token in ` +
                    `the human \`message\` field (#1679):\n\n` +
                    offenders.map((o) => `  ${o}`).join('\n') +
                    `\n\nUse \`params\` for the machine-readable part. The six sites listed ` +
                    `in this guard are grandfathered for ONE release because installed ` +
                    `clients match on their prefix; a new one has no such excuse.`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

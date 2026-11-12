/**
 * `REJECTED` is unreachable, and `ClaimStatus` narrows on that premise — #2974.
 *
 * ## Why a test rather than a comment
 *
 * `listFarmClaims` reads the column and casts: `status: r.status as
 * ClaimStatus`. That is safe ONLY while nothing writes the enum's fourth
 * member, and a cast is precisely what removes the target a later mistake
 * would fail against — implement rejection, and a `REJECTED` row arrives
 * typed as one of three with every consumer's `switch` lacking an arm, and
 * nothing fails.
 *
 * A docblock asserting "nothing writes REJECTED" is a safety argument whose
 * premise goes false silently. This makes the premise a CHECK: the day
 * somebody adds a reject verb, this fails and names the narrowing to widen.
 *
 * Owner ruling 2026-11-10: document the value as reserved rather than delete
 * it or implement it. So the value stays, the narrowing stays, and this holds
 * the join between them.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { FarmIdentityClaimStatus } from '@prisma/client';

import { collectSourceFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = join(__dirname, '../..');

describe('REJECTED is a reserved, unreachable claim status', () => {
    it('is still a member of the Prisma enum', () => {
        // THE CONTROL. Without it every assertion below also passes if the
        // value were deleted or renamed — and then this file would be
        // asserting nothing while reading as protection. If this fails because
        // #2974 chose deletion after all, delete this suite with it.
        expect(Object.values(FarmIdentityClaimStatus)).toContain('REJECTED');
    });

    it('`ClaimStatus` narrows to the three reachable members', () => {
        const src = readFileSync(
            join(ROOT, 'src/app-layer/usecases/farm-identity-review.ts'),
            'utf8',
        );
        const code = blankNonCode(src);
        const match = /export type ClaimStatus =([^;]+);/.exec(code);
        expect(match).not.toBeNull();
        const members = [...match![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
        expect(members.sort()).toEqual(['DISPUTED', 'PENDING', 'VERIFIED']);
    });

    it('NOTHING writes REJECTED to a CLAIM', () => {
        // ## The window is files that touch the claim model, not all of `src/`
        //
        // My first draft matched `status: 'REJECTED'` anywhere under `src/`
        // and reported FIVE offenders — all false: `REJECTED` is a common
        // enum member, and those were evidence reviews and news-derived
        // events. A detector that cannot tell one model's REJECTED from
        // another's is grading the wrong thing, however loudly it fails.
        //
        // So the population is files that mention the claim model at all, and
        // within those, any REJECTED write. Derived rather than listed, so a
        // new writer is caught including one in a file that does not exist
        // yet.
        const all = collectSourceFiles({
            roots: ['src'],
            extensions: ['.ts', '.tsx'],
            floor: 500,
        });

        const touching: { rel: string; code: string }[] = [];
        for (const abs of all) {
            // `collectSourceFiles` returns ABSOLUTE paths — joining them with
            // ROOT again produced `/repo/repo/src/...` and an ENOENT that read
            // as a missing file rather than a bad join.
            const code = blankNonCode(readFileSync(abs, 'utf8'));
            if (/farmIdentityClaim|FarmIdentityClaim/.test(code)) {
                touching.push({
                    rel: abs.startsWith(ROOT) ? abs.slice(ROOT.length + 1) : abs,
                    code,
                });
            }
        }

        // THE DENOMINATOR, and a floor on it. The whole check is an absence,
        // so a population of zero would pass while saying nothing — and this
        // population shrinks to zero the moment the model is renamed.
        console.log(
            `[rejected-unreachable] ${touching.length} file(s) touch the claim model, `
            + `of ${all.length} scanned.`,
        );
        expect(touching.length).toBeGreaterThan(2);

        const offenders = touching
            .filter(({ code }) =>
                // A WRITE, not a mention: `status: 'REJECTED'` is what a
                // Prisma `data` looks like. A comparison (`=== 'REJECTED'`)
                // would be a READ, which is not what the cast's safety turns
                // on.
                /\bstatus\s*:\s*'REJECTED'/.test(code),
            )
            .map(({ rel }) => rel);

        if (offenders.length > 0) {
            throw new Error(
                `REJECTED is now written by ${offenders.length} file(s):\n\n`
                + offenders.map((f) => `  ${f}`).join('\n')
                + '\n\nSo it is no longer unreachable, and `ClaimStatus` in '
                + 'farm-identity-review.ts narrows to three members while the column '
                + 'can hold four — with `status: r.status as ClaimStatus` casting the '
                + 'difference away. Widen that type and give every consumer an arm, '
                + 'or revisit #2974.',
            );
        }
        expect(offenders).toEqual([]);
    });

    it('CONTROL — the detector finds a write when there is one', () => {
        // Without this, the assertion above passes whether or not the regexes
        // match anything, which is the shape #2964 ratcheted.
        const positive = blankNonCode("const x = { status: 'REJECTED' };");
        expect(/\bstatus\s*:\s*'REJECTED'/.test(positive)).toBe(true);
        // And a COMMENT mentioning it is not a write — the schema's own
        // docblock says the word several times.
        const commented = blankNonCode("// status: 'REJECTED' is reserved\nconst y = 1;");
        expect(/\bstatus\s*:\s*'REJECTED'/.test(commented)).toBe(false);
    });
});

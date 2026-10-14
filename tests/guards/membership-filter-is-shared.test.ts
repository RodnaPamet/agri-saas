/**
 * The reader and the producer of `memberships` agree on the FILTER (#1738).
 *
 * ## Why this cannot be a type
 *
 * `applyMembershipClaims` in `src/auth.ts` is the single producer of the
 * `memberships` claim, and it is deliberately private — its own comment is
 * emphatic that a second producer missing the ACTIVE filter, the
 * deleted-tenant filter, the ordering or the cap "would be silently more (or
 * less) permissive than the cookie, in a population no fixture covers".
 *
 * `accessGrantingTenantSlugs` is not a second producer; it mints nothing. But
 * `/no-tenant` compares its answer against the claim to decide whether to tell
 * someone their session is stale, so the two must select the same rows. If the
 * producer gained a condition — a suspended tenant, a pending membership —
 * and the reader did not, the page would start telling people to sign in again
 * to reach a farm the gate will still refuse: a loop, recommended by the
 * product, with no way out.
 *
 * TypeScript cannot express that agreement, because the producer's copy of the
 * filter lives inside a private function's `include`. So this compares the
 * text, with comments blanked and with a mutation proof, which is the strongest
 * available check short of exporting the producer — and exporting it is exactly
 * what `src/auth.ts` argues against.
 *
 * ## Deliberately NOT compared: the cap
 *
 * `MAX_JWT_MEMBERSHIPS` keeps the cookie bounded. The reader must not apply
 * it, because a capped token is the one case where the database most clearly
 * holds more than the token does, and slicing would hide it.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

/** The predicate both sites must carry, verbatim. */
const SHARED_FILTER = "status: 'ACTIVE', tenant: { deletedAt: null }";

const PRODUCER = 'src/auth.ts';
const READER = 'src/lib/auth/membership-presence.ts';

function code(rel: string): string {
    return blankNonCode(readFileSync(path.join(ROOT, rel), 'utf8'));
}

describe('the membership filter is shared between the claim producer and the page reader', () => {
    it('the producer still exists under the name this guard tracks', () => {
        // A needle loses the thread at a rename: if `applyMembershipClaims`
        // were renamed, every assertion below could still pass against a file
        // that no longer mints anything, and the guard would be watching a
        // ghost. Named explicitly so the rename fails HERE.
        expect(code(PRODUCER)).toContain('async function applyMembershipClaims(');
        expect(code(READER)).toContain('export async function accessGrantingTenantSlugs(');
    });

    it('both carry the same filter, in CODE and not in prose', () => {
        // Comments blanked, because both files discuss the filter at length —
        // this guard must grade the query, not the explanation of it. A scar
        // is not a wound.
        const producer = code(PRODUCER);
        const reader = code(READER);

        expect(producer).toContain(SHARED_FILTER);
        expect(reader).toContain(SHARED_FILTER);
    });

    it('the reader applies it exactly once', () => {
        // Two copies inside the reader would be the same drift hazard one
        // level down.
        const occurrences = code(READER).split(SHARED_FILTER).length - 1;
        expect(occurrences).toBe(1);
    });

    it('the reader does NOT apply the JWT cap', () => {
        // The one thing it must not share. Slicing here would hide precisely
        // the farms a capped token cannot see.
        expect(code(READER)).not.toContain('MAX_JWT_MEMBERSHIPS');
    });

    it('mutation proof — a changed filter is detected', () => {
        // In memory, not on disk. If the detector still found the filter in a
        // file where it had been altered, the comparison above would be
        // decoration.
        const mutated = code(READER).replace(SHARED_FILTER, "status: 'ACTIVE'");
        expect(mutated).not.toContain(SHARED_FILTER);

        // And the inverse: the needle is specific enough that a near miss is
        // not a match.
        expect(SHARED_FILTER.includes("deletedAt: null")).toBe(true);
        expect("status: 'ACTIVE', tenant: { deletedAt: undefined }").not.toContain(SHARED_FILTER);
    });
});

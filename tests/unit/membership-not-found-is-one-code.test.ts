/**
 * Every membership lookup on the admin surface refuses with ONE code (#1712).
 *
 * ## Why one and not four
 *
 * The five sites carry four different English sentences — "not found or not
 * active", "not found", "not found or already active", "not found or already
 * removed" — and each is honest about its own query. But every one of those
 * queries is a SINGLE `findFirst` with a status predicate, so an absent
 * membership and one in the wrong state both come back null.
 *
 * The server therefore cannot tell them apart, and a code per sentence would
 * advertise a distinction it cannot make. That is the shape that makes a
 * client's error handling confidently wrong: it would branch on a cause the
 * server guessed.
 *
 * So: one code, and `params.requiredStatus` carries the state the operation
 * needed. A client says "that member is no longer active" instead of a
 * category, which is the same arrangement as `WRITE_FORBIDDEN_FOR_ROLE`'s
 * `params.role`.
 *
 * ## The absence of the param is information too
 *
 * `updateMemberCertificates` is the one lookup with NO status predicate, so it
 * carries no `requiredStatus`. A client seeing the code without the param
 * knows any state would have been accepted — the membership really is gone,
 * rather than merely in the wrong state.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src/app-layer/usecases/tenant-admin.ts');

/** Comments blanked: this file now DISCUSSES the code at length. */
const code = blankNonCode(fs.readFileSync(SRC, 'utf8'));

describe('the admin membership surface uses one code', () => {
    it('has no uncoded membership notFound left', () => {
        // The thing the batch was for. `(?<!coded)` so `codedNotFound` does
        // not match its own suffix.
        const uncoded = [...code.matchAll(/(?<!coded)\bnotFound\(\s*['"`]/g)];
        expect(uncoded).toHaveLength(0);
    });

    it('raises MEMBERSHIP_NOT_FOUND at every one of the five lookups', () => {
        const hits = [...code.matchAll(/MEMBERSHIP_NOT_FOUND/g)];
        // Five, measured — and asserted as an exact count so a sixth lookup
        // added later without a code is visible here rather than only in the
        // copy ratchet's total.
        expect(hits).toHaveLength(5);
    });

    it('uses no OTHER membership code — the distinction the server cannot make', () => {
        // A code per sentence is the mistake this guards against. If someone
        // adds `MEMBERSHIP_ALREADY_REMOVED`, the server still cannot tell that
        // from an absent row, so the new code would be a claim it cannot
        // support.
        const others = [...code.matchAll(/'MEMBERSHIP_[A-Z_]+'/g)]
            .map((m) => m[0])
            .filter((c) => c !== "'MEMBERSHIP_NOT_FOUND'");
        expect(others).toEqual([]);
    });

    it('carries requiredStatus on the four lookups that have a status predicate', () => {
        const params = [...code.matchAll(/requiredStatus: '([A-Z,_]+)'/g)].map((m) => m[1]);
        // Two ACTIVE (role update, deactivate), one for reactivate, one for
        // remove. Sorted so the assertion does not depend on file order.
        expect(params.sort()).toEqual([
            'ACTIVE',
            'ACTIVE',
            'ACTIVE,DEACTIVATED,INVITED',
            'DEACTIVATED,REMOVED',
        ]);
    });

    it('leaves the fifth WITHOUT the param, deliberately', () => {
        // Five codes, four params. The gap is the certificates lookup, whose
        // query has no status filter — so a client that sees the code and no
        // param learns the row is genuinely absent.
        const codes = [...code.matchAll(/MEMBERSHIP_NOT_FOUND/g)].length;
        const params = [...code.matchAll(/requiredStatus:/g)].length;
        expect(codes - params).toBe(1);
    });

    it('keeps each English sentence as its own fallback', () => {
        // `coded-message-is-displayed-copy`: the four distinct sentences are
        // what a client with no entry for the code still shows, so collapsing
        // them to one generic string would lose the detail the param exists to
        // carry — in the one case where the client cannot read the param.
        for (const sentence of [
            'Membership not found or not active.',
            'Membership not found.',
            'Membership not found or already active.',
            'Membership not found or already removed.',
        ]) {
            expect(code).toContain(sentence);
        }
    });
});

describe('the spec names the code', () => {
    it('appears in the published contract', () => {
        // Documented rather than baselined — all five admin-member paths are
        // described, so there was no reason to add debt.
        const spec = fs.readFileSync(path.join(ROOT, 'src/generated/openapi.json'), 'utf8');
        expect(spec).toContain('MEMBERSHIP_NOT_FOUND');
        expect(spec).toContain('params.requiredStatus');
    });
});

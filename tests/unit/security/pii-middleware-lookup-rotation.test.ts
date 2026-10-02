/**
 * P1.1 — what the WHERE rewriter does while the LOOKUP key is rotating.
 *
 * A ciphertext can be tried under the previous key and the attempt tells you
 * whether it worked, because AES-GCM authenticates. A HASH cannot: under the
 * wrong key `hashForLookup` returns a well-formed hex string that matches no
 * row, so a read has no failure to catch and retry on. The only expressible
 * form of "either key" is a wider QUERY — which is what makes this a middleware
 * concern rather than a key-derivation one, and which brings a second problem
 * with it: `findUnique` cannot take an `in`.
 *
 * Four properties, and the last two are the ones a reviewer should look at
 * hardest because they are where this change could break a working product:
 *
 *   1. With no rotation configured, nothing changes — the predicate is still a
 *      bare hash string and `findUnique` stays `findUnique`.
 *   2. With a rotation configured, reads widen to `{ in: [primary, previous] }`.
 *   3. `findUnique` is DOWNGRADED to `findFirst` exactly when it widens.
 *   4. A write addressed by a unique where NEVER widens.
 */
import {
    piiEncryptionMiddleware,
    _rewriteWhereForHash,
    _rewriteWhereForHashWidened,
} from '@/lib/security/pii-middleware';
import {
    hashForLookup,
    hashForLookupCandidates,
    _resetKeyCache,
} from '@/lib/security/encryption';

export {};

const PRIMARY = 'a-pinned-primary-lookup-key-at-least-32-chars'; // pragma: allowlist secret -- test fixture
const PREVIOUS = 'the-outgoing-previous-lookup-key-32-chars+'; // pragma: allowlist secret -- test fixture

function noRotation(): void {
    delete process.env.LOOKUP_HMAC_KEY;
    delete process.env.LOOKUP_HMAC_KEY_PREVIOUS;
    _resetKeyCache();
}

function rotating(): void {
    process.env.LOOKUP_HMAC_KEY = PRIMARY;
    process.env.LOOKUP_HMAC_KEY_PREVIOUS = PREVIOUS;
    _resetKeyCache();
}

afterEach(noRotation);

describe('the steady state is untouched', () => {
    beforeEach(noRotation);

    it('a bare equality is still a single hash, not a one-element `in`', () => {
        // A one-element `in` would be CORRECT and would still force the
        // findUnique downgrade on every query forever. The collapse in
        // `hashForLookupCandidates` is what keeps the common path identical.
        const { where, widened } = _rewriteWhereForHashWidened({ email: 'a@b.com' }, 'User');
        expect(where).toEqual({ emailHash: hashForLookup('a@b.com') });
        expect(widened).toBe(false);
    });

    it('findUnique stays findUnique', async () => {
        const seen: string[] = [];
        await piiEncryptionMiddleware(
            { model: 'User', action: 'findUnique', args: { where: { email: 'a@b.com' } } } as never,
            async (p: { action: string }) => {
                seen.push(p.action);
                return null;
            },
        );
        expect(seen).toEqual(['findUnique']);
    });
});

describe('a lookup-key rotation widens READS', () => {
    beforeEach(rotating);

    it('bare equality becomes `{ in: [primary, previous] }`, in that order', () => {
        const { where, widened } = _rewriteWhereForHashWidened({ email: 'a@b.com' }, 'User');
        const candidates = hashForLookupCandidates('a@b.com');
        expect(candidates).toHaveLength(2);
        // Order matters for a reader, not for correctness: primary first says
        // which key the row SHOULD be under once the sweep has run.
        expect(where).toEqual({ emailHash: { in: candidates } });
        expect(widened).toBe(true);
    });

    it('{ equals: x } widens the same way', () => {
        const { where, widened } = _rewriteWhereForHashWidened(
            { email: { equals: 'a@b.com' } },
            'User',
        );
        expect(where).toEqual({ emailHash: { in: hashForLookupCandidates('a@b.com') } });
        expect(widened).toBe(true);
    });

    it('an existing `in` gets a FLAT, longer list — never a nested array', () => {
        // `flatMap`, not `map`. One value contributes two candidates, and a
        // nested array here is an invalid Prisma predicate rather than a wider
        // match — it would throw at query time, not silently miss.
        const { where, widened } = _rewriteWhereForHashWidened(
            { email: { in: ['a@b.com', 'c@d.com'] } },
            'User',
        );
        const expected = [
            ...hashForLookupCandidates('a@b.com'),
            ...hashForLookupCandidates('c@d.com'),
        ];
        expect(where).toEqual({ emailHash: { in: expected } });
        expect(expected).toHaveLength(4);
        for (const h of expected) expect(typeof h).toBe('string');
        // An `in` was never unique-addressable, so this shape forces no
        // downgrade — and must not claim one.
        expect(widened).toBe(false);
    });

    it('widening inside a nested OR comes back OUT of the recursion', () => {
        // The failure this prevents: a nested widen that the dispatcher never
        // hears about, so `findUnique` keeps its action and Prisma rejects the
        // `in` at query time.
        const { widened } = _rewriteWhereForHashWidened(
            { OR: [{ email: 'a@b.com' }, { id: 'x' }] },
            'User',
        );
        expect(widened).toBe(true);
    });

    it('UserIdentityLink widens too — it is the second hashed kind', () => {
        const { where, widened } = _rewriteWhereForHashWidened(
            { emailAtLinkTime: 'a@b.com' },
            'UserIdentityLink',
        );
        expect(where).toEqual({
            emailAtLinkTimeHash: { in: hashForLookupCandidates('a@b.com') },
        });
        expect(widened).toBe(true);
    });
});

describe('findUnique is downgraded exactly when it widens', () => {
    beforeEach(rotating);

    it.each([
        ['findUnique', 'findFirst'],
        ['findUniqueOrThrow', 'findFirstOrThrow'],
    ])('%s -> %s', async (action, expected) => {
        // Safe because the hash column is `@unique` and the candidate list
        // holds at most one hash per key generation, so at most one row can
        // match — which is the guarantee findUnique was providing.
        const seen: Array<{ action: string; where: unknown }> = [];
        await piiEncryptionMiddleware(
            { model: 'User', action, args: { where: { email: 'a@b.com' } } } as never,
            async (p: { action: string; args: { where: unknown } }) => {
                seen.push({ action: p.action, where: p.args.where });
                return null;
            },
        );
        expect(seen[0].action).toBe(expected);
        expect(seen[0].where).toEqual({ emailHash: { in: hashForLookupCandidates('a@b.com') } });
    });

    it('findFirst and findMany are left alone — nothing to downgrade', async () => {
        for (const action of ['findFirst', 'findMany', 'count']) {
            const seen: string[] = [];
            await piiEncryptionMiddleware(
                { model: 'User', action, args: { where: { email: 'a@b.com' } } } as never,
                async (p: { action: string }) => {
                    seen.push(p.action);
                    return null;
                },
            );
            expect(seen).toEqual([action]);
        }
    });

    it('a query with no PII predicate is not downgraded', async () => {
        // The downgrade must key on the WIDENING, not on the rotation being
        // configured. Otherwise every findUnique in the product changes shape
        // the moment an operator sets one env var.
        const seen: string[] = [];
        await piiEncryptionMiddleware(
            { model: 'User', action: 'findUnique', args: { where: { id: 'u1' } } } as never,
            async (p: { action: string }) => {
                seen.push(p.action);
                return null;
            },
        );
        expect(seen).toEqual(['findUnique']);
    });
});

describe('unique-where WRITES never widen', () => {
    beforeEach(rotating);

    it.each(['update', 'delete', 'upsert', 'updateMany', 'deleteMany'])(
        '%s addresses the PRIMARY hash only',
        async (action) => {
            // Prisma rejects an `in` in a unique where, and there is no
            // `upsertMany` to downgrade to. `updateMany`/`deleteMany` COULD
            // take it and are excluded deliberately: widening them changes
            // which rows a write touches, and mid-rotation the conservative
            // behaviour is that writes address the primary while the P1.3
            // sweep moves the remainder.
            const seen: Array<{ action: string; where: unknown }> = [];
            await piiEncryptionMiddleware(
                { model: 'User', action, args: { where: { email: 'a@b.com' } } } as never,
                async (p: { action: string; args: { where: unknown } }) => {
                    seen.push({ action: p.action, where: p.args.where });
                    return null;
                },
            );
            expect(seen[0].action).toBe(action);
            expect(seen[0].where).toEqual({ emailHash: hashForLookup('a@b.com') });
        },
    );

    it('the pure hook honours allowMultiple: false', () => {
        const { where, widened } = _rewriteWhereForHashWidened({ email: 'a@b.com' }, 'User', false);
        expect(where).toEqual({ emailHash: hashForLookup('a@b.com') });
        expect(widened).toBe(false);
    });
});

describe('the default-argument hook still behaves as its callers expect', () => {
    it('_rewriteWhereForHash defaults to allowing multiple', () => {
        // The pre-existing hook took two arguments and its callers still do.
        // Defaulting to `true` keeps those tests measuring the READ path, which
        // is what they were written against.
        rotating();
        const where: Record<string, unknown> = { email: 'a@b.com' };
        _rewriteWhereForHash(where, 'User');
        expect(where).toEqual({ emailHash: { in: hashForLookupCandidates('a@b.com') } });
    });
});

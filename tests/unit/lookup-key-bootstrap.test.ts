import crypto from 'crypto';
import { hashForLookup, hashForLookupCandidates, isLookupKeyPinned, _resetKeyCache } from '@/lib/security/encryption';

/** The pre-P1.1 derivation, spelled out independently. */
function legacyHash(value: string, material: string): string {
    const salt = Buffer.from('inflect-data-protection-salt-v1', 'utf8');
    const prk = crypto.createHmac('sha256', salt).update(Buffer.from(material, 'utf8')).digest();
    const key = crypto.createHmac('sha256', prk)
        .update(Buffer.concat([Buffer.from('inflect-data-lookup-hash', 'utf8'), Buffer.from([1])]))
        .digest();
    return crypto.createHmac('sha256', key).update(value.toLowerCase().trim(), 'utf8').digest('hex');
}

const KEK = 'k'.repeat(48);   // pragma: allowlist secret -- test fixture
const PINNED = 'p'.repeat(48); // pragma: allowlist secret -- test fixture

describe('the bootstrap reproduces the pre-P1.1 bytes exactly', () => {
    beforeEach(() => {
        delete process.env.LOOKUP_HMAC_KEY;
        delete process.env.LOOKUP_HMAC_KEY_PREVIOUS;
        process.env.DATA_ENCRYPTION_KEY = KEK;
        _resetKeyCache();
    });

    it('unset LOOKUP_HMAC_KEY -> byte-identical to the old derivation', () => {
        expect(isLookupKeyPinned()).toBe(false);
        expect(hashForLookup('User@Example.com')).toBe(legacyHash('User@Example.com', KEK));
    });

    it('pinned to the KEK material -> still byte-identical', () => {
        // This is what the VM now holds: the SAME material, written down.
        process.env.LOOKUP_HMAC_KEY = KEK;
        _resetKeyCache();
        expect(isLookupKeyPinned()).toBe(true);
        expect(hashForLookup('user@example.com')).toBe(legacyHash('user@example.com', KEK));
    });

    it('THE POINT: pinned, the hash survives a KEK rotation', () => {
        process.env.LOOKUP_HMAC_KEY = KEK;
        _resetKeyCache();
        const before = hashForLookup('user@example.com');
        process.env.DATA_ENCRYPTION_KEY = 'rotated-to-something-else-entirely-min32!!';
        _resetKeyCache();
        expect(hashForLookup('user@example.com')).toBe(before);
    });

    it('bootstrapped, it does NOT — which is why pinning is the fix', () => {
        const before = hashForLookup('user@example.com');
        process.env.DATA_ENCRYPTION_KEY = 'rotated-to-something-else-entirely-min32!!';
        _resetKeyCache();
        expect(hashForLookup('user@example.com')).not.toBe(before);
    });

    it('a short pinned value reads as ABSENT, not as an error', () => {
        process.env.LOOKUP_HMAC_KEY = 'too-short';
        _resetKeyCache();
        expect(isLookupKeyPinned()).toBe(false);
        expect(hashForLookup('user@example.com')).toBe(legacyHash('user@example.com', KEK));
    });

    it('candidates is one element until a lookup rotation starts', () => {
        expect(hashForLookupCandidates('user@example.com')).toHaveLength(1);
        process.env.LOOKUP_HMAC_KEY = PINNED;
        process.env.LOOKUP_HMAC_KEY_PREVIOUS = KEK;
        _resetKeyCache();
        const c = hashForLookupCandidates('user@example.com');
        expect(c).toHaveLength(2);
        expect(c[0]).toBe(legacyHash('user@example.com', PINNED));
        expect(c[1]).toBe(legacyHash('user@example.com', KEK));
    });

    it('identical primary and previous collapse to one candidate', () => {
        process.env.LOOKUP_HMAC_KEY = KEK;
        process.env.LOOKUP_HMAC_KEY_PREVIOUS = KEK;
        _resetKeyCache();
        expect(hashForLookupCandidates('user@example.com')).toEqual([legacyHash('user@example.com', KEK)]);
    });
});

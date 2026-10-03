/**
 * The platform chain's hash covers every field it claims to. P1.9.
 *
 * A hash chain's whole value is that changing the history changes the hash. A
 * field present on the row but absent from the payload is therefore
 * tamper-evident in APPEARANCE only: it can be rewritten and every hash still
 * verifies. So the test that matters is not "the hash is stable" — it is "each
 * field, changed alone, moves the hash", driven from the declared field list so
 * a new field cannot be added to the model and quietly left outside.
 */
import {
    PLATFORM_HASH_FIELDS,
    buildPlatformHashPayload,
    computePlatformEntryHash,
    type PlatformHashInput,
} from '@/lib/audit/platform-canonical-hash';

const BASE: PlatformHashInput = {
    scope: 'feature-flags',
    actorType: 'PLATFORM_ADMIN',
    actorUserId: null,
    action: 'FEATURE_FLAG_UPSERTED',
    occurredAt: '2026-10-03T09:00:00.000Z',
    detailsJson: { key: 'social.profiles', enabled: true },
    previousHash: null,
    version: 1,
};

describe('the payload and the declared field list agree', () => {
    it('every declared field appears in the payload, and nothing else does', () => {
        // Both directions. A field in the list but not the payload is a claim
        // the hash does not keep; a field in the payload but not the list makes
        // the list useless as documentation.
        expect(Object.keys(buildPlatformHashPayload(BASE)).sort()).toEqual(
            [...PLATFORM_HASH_FIELDS].sort(),
        );
    });

    it('`id` and `requestId` are deliberately NOT hashed', () => {
        // `id` is a per-insert cuid, so hashing it would make the chain
        // unverifiable from logical content. `requestId` is correlation
        // metadata, not part of what happened.
        expect(PLATFORM_HASH_FIELDS).not.toContain('id');
        expect(PLATFORM_HASH_FIELDS).not.toContain('requestId');
    });

    it('the chain KEY is inside the hash', () => {
        // Without `scope` in the payload, two entries in different chains with
        // otherwise-identical fields hash the same — so an entry could be moved
        // between chains undetectably.
        expect(PLATFORM_HASH_FIELDS).toContain('scope');
        expect(computePlatformEntryHash(BASE)).not.toBe(
            computePlatformEntryHash({ ...BASE, scope: 'key-rotation' }),
        );
    });
});

describe('each field moves the hash', () => {
    const variants: Array<[string, Partial<PlatformHashInput>]> = [
        ['action', { action: 'FEATURE_FLAG_COHORT_ADDED' }],
        ['actorType', { actorType: 'SYSTEM' }],
        ['actorUserId', { actorUserId: 'usr_1' }],
        ['detailsJson', { detailsJson: { key: 'social.profiles', enabled: false } }],
        ['occurredAt', { occurredAt: '2026-10-03T09:00:00.001Z' }],
        ['previousHash', { previousHash: 'a'.repeat(64) }],
        ['scope', { scope: 'key-rotation' }],
        ['version', { version: 2 }],
    ];

    it('covers every declared field — no field is left unexercised', () => {
        // The denominator. Without this, adding a field to the list and
        // forgetting a variant leaves it silently unchecked below.
        expect(variants.map(([f]) => f).sort()).toEqual([...PLATFORM_HASH_FIELDS].sort());
    });

    it.each(variants)('changing %s changes the hash', (_field, patch) => {
        expect(computePlatformEntryHash({ ...BASE, ...patch })).not.toBe(
            computePlatformEntryHash(BASE),
        );
    });
});

describe('stability and the two null shapes', () => {
    it('the same input hashes the same, twice', () => {
        expect(computePlatformEntryHash(BASE)).toBe(computePlatformEntryHash(BASE));
    });

    it('is lowercase hex, 64 chars', () => {
        expect(computePlatformEntryHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('an explicit null detailsJson hashes as an omitted one', () => {
        // The two call shapes are the same event. Without the `?? null` they
        // would hash differently, so replaying a history written by one caller
        // would fail against the other.
        const explicit = computePlatformEntryHash({ ...BASE, detailsJson: null });
        const omitted = computePlatformEntryHash({
            ...BASE,
            detailsJson: undefined as unknown as null,
        });
        expect(explicit).toBe(omitted);
    });

    it('key ORDER in detailsJson does not change the hash', () => {
        // The canonical serialiser sorts keys. Without that, two writers
        // recording the same event with different literal order would produce
        // different hashes and a chain that cannot be reproduced.
        expect(
            computePlatformEntryHash({ ...BASE, detailsJson: { a: 1, b: 2 } }),
        ).toBe(computePlatformEntryHash({ ...BASE, detailsJson: { b: 2, a: 1 } }));
    });

    it('ARRAY order DOES change the hash', () => {
        // The other direction, and the correct one: an array is ordered data.
        // Sorting arrays would make `cohorts: ['a','b']` and `['b','a']`
        // indistinguishable, and cohort order is caller-visible.
        expect(
            computePlatformEntryHash({ ...BASE, detailsJson: { cohorts: ['a', 'b'] } }),
        ).not.toBe(computePlatformEntryHash({ ...BASE, detailsJson: { cohorts: ['b', 'a'] } }));
    });
});

/**
 * Audit Chain Verification — Unit Tests
 *
 * Tests the chain verification logic using pure functions from
 * canonical-hash.ts, ensuring that:
 *   1. Valid chains pass verification
 *   2. Tampered entries are detected (hash_mismatch)
 *   3. Broken links are detected (chain_discontinuity)
 *   4. Verification reports contain useful diagnostics
 *
 * These tests exercise the SAME canonical serialization used by
 * the audit writer, ensuring verify and write are in lockstep.
 */
import {
    computeEntryHash,
    canonicalJsonStringify,
    toCanonicalTimestamp,
    HashInput,
} from '../../src/lib/audit/canonical-hash';

// ─── Helpers ────────────────────────────────────────────────────────

/** Build a minimal valid hash input for testing. */
function makeInput(overrides: Partial<HashInput> = {}): HashInput {
    return {
        tenantId: 'tenant-test-001',
        actorType: 'USER',
        actorUserId: 'user-001',
        eventType: 'CONTROL_CREATED',
        entityType: 'Practice',
        entityId: 'ctrl-001',
        occurredAt: '2024-06-15T10:30:00.000Z',
        detailsJson: { category: 'entity_lifecycle', entityName: 'Practice', operation: 'created', summary: 'Created practice' },
        previousHash: null,
        version: 1,
        ...overrides,
    };
}

/**
 * Simulate a chain of N entries, each linked to the previous via hash.
 * Returns array of { input, entryHash } pairs.
 */
function buildChain(count: number, tenantId = 'tenant-test-001'): Array<{ input: HashInput; entryHash: string }> {
    const chain: Array<{ input: HashInput; entryHash: string }> = [];
    let previousHash: string | null = null;

    for (let i = 0; i < count; i++) {
        const input = makeInput({
            tenantId,
            eventType: `EVENT_${i}`,
            entityId: `entity-${i}`,
            occurredAt: `2024-06-15T10:${String(30 + i).padStart(2, '0')}:00.000Z`,
            detailsJson: { category: 'custom', index: i },
            previousHash,
            version: 1,
        });

        const entryHash = computeEntryHash(input);
        chain.push({ input, entryHash });
        previousHash = entryHash;
    }

    return chain;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Audit Chain Verification Logic', () => {

    // ── Happy Path ──

    describe('Valid Chain', () => {
        test('single entry with previousHash=null verifies', () => {
            const input = makeInput({ previousHash: null });
            const entryHash = computeEntryHash(input);

            // Re-verify: same input produces same hash
            const recomputed = computeEntryHash(input);
            expect(recomputed).toBe(entryHash);
            expect(entryHash).toHaveLength(64); // SHA-256 hex
        });

        test('chain of 5 entries all verify correctly', () => {
            const chain = buildChain(5);

            // Verify each link
            for (let i = 0; i < chain.length; i++) {
                const { input, entryHash } = chain[i];
                const recomputed = computeEntryHash(input);
                expect(recomputed).toBe(entryHash);

                // Verify linkage
                if (i === 0) {
                    expect(input.previousHash).toBeNull();
                } else {
                    expect(input.previousHash).toBe(chain[i - 1].entryHash);
                }
            }
        });

        test('two different tenants have independent chains', () => {
            const chainA = buildChain(3, 'tenant-a');
            const chainB = buildChain(3, 'tenant-b');

            // Same entry index should have different hashes (different tenantId)
            expect(chainA[0].entryHash).not.toBe(chainB[0].entryHash);

            // Each chain still verifies independently
            for (const { input, entryHash } of chainA) {
                expect(computeEntryHash(input)).toBe(entryHash);
            }
            for (const { input, entryHash } of chainB) {
                expect(computeEntryHash(input)).toBe(entryHash);
            }
        });
    });

    // ── Hash Mismatch (Tampering Detection) ──

    describe('Hash Mismatch Detection', () => {
        test('modifying detailsJson invalidates hash', () => {
            const input = makeInput();
            const originalHash = computeEntryHash(input);

            // Tamper with detailsJson
            const tampered = { ...input, detailsJson: { category: 'custom', tampered: true } };
            const tamperedHash = computeEntryHash(tampered);

            expect(tamperedHash).not.toBe(originalHash);
        });

        test('modifying eventType invalidates hash', () => {
            const input = makeInput();
            const originalHash = computeEntryHash(input);

            const tampered = { ...input, eventType: 'CONTROL_DELETED' };
            expect(computeEntryHash(tampered)).not.toBe(originalHash);
        });

        test('modifying entityId invalidates hash', () => {
            const input = makeInput();
            const originalHash = computeEntryHash(input);

            const tampered = { ...input, entityId: 'ctrl-999' };
            expect(computeEntryHash(tampered)).not.toBe(originalHash);
        });

        test('modifying actorUserId invalidates hash', () => {
            const input = makeInput();
            const originalHash = computeEntryHash(input);

            const tampered = { ...input, actorUserId: 'user-hacker' };
            expect(computeEntryHash(tampered)).not.toBe(originalHash);
        });

        test('modifying occurredAt invalidates hash', () => {
            const input = makeInput();
            const originalHash = computeEntryHash(input);

            const tampered = { ...input, occurredAt: '2024-12-25T00:00:00.000Z' };
            expect(computeEntryHash(tampered)).not.toBe(originalHash);
        });

        test('modifying version invalidates hash', () => {
            const input = makeInput();
            const originalHash = computeEntryHash(input);

            const tampered = { ...input, version: 2 };
            expect(computeEntryHash(tampered)).not.toBe(originalHash);
        });
    });

    // ── Chain Discontinuity ──

    describe('Chain Discontinuity Detection', () => {
        test('wrong previousHash detected', () => {
            const chain = buildChain(3);

            // Tamper entry 2's previousHash (should be chain[1].entryHash)
            const tamperedInput = { ...chain[2].input, previousHash: 'deadbeef00000000' };
            const tamperedHash = computeEntryHash(tamperedInput);

            // The hash changes because previousHash is part of the hash input
            expect(tamperedHash).not.toBe(chain[2].entryHash);

            // And the previousHash doesn't match the expected chain[1].entryHash
            expect(tamperedInput.previousHash).not.toBe(chain[1].entryHash);
        });

        test('removing previousHash (setting to null) on non-first entry detected', () => {
            const chain = buildChain(3);

            const tamperedInput = { ...chain[2].input, previousHash: null };
            const tamperedHash = computeEntryHash(tamperedInput);

            expect(tamperedHash).not.toBe(chain[2].entryHash);
        });

        test('swapping two entries in a chain breaks verification', () => {
            const chain = buildChain(4);

            // After building, verify that entry[2] depends on entry[1]
            expect(chain[2].input.previousHash).toBe(chain[1].entryHash);

            // If we reorder (put entry[2] where entry[1] is), the previousHash
            // of what-was-entry-2 won't match what-was-entry-0
            expect(chain[2].input.previousHash).not.toBe(chain[0].entryHash);
        });
    });

    // ── Canonical Stability ──

    describe('Canonical Serialization Stability', () => {
        test('same input always produces same hash (deterministic)', () => {
            const input = makeInput();
            const hash1 = computeEntryHash(input);
            const hash2 = computeEntryHash(input);
            const hash3 = computeEntryHash(input);

            expect(hash1).toBe(hash2);
            expect(hash2).toBe(hash3);
        });

        test('field order in detailsJson does not affect hash', () => {
            const input1 = makeInput({
                detailsJson: { category: 'custom', alpha: 1, beta: 2 },
            });
            const input2 = makeInput({
                detailsJson: { beta: 2, category: 'custom', alpha: 1 },
            });

            expect(computeEntryHash(input1)).toBe(computeEntryHash(input2));
        });

        test('canonical JSON sorts nested object keys', () => {
            const obj = { z: { b: 2, a: 1 }, a: { d: 4, c: 3 } };
            const canonical = canonicalJsonStringify(obj);
            expect(canonical).toBe('{"a":{"c":3,"d":4},"z":{"a":1,"b":2}}');
        });

        test('timestamp canonicalization is consistent', () => {
            const date = new Date('2024-06-15T10:30:00.000Z');
            const ts1 = toCanonicalTimestamp(date);
            const ts2 = toCanonicalTimestamp('2024-06-15T10:30:00.000Z');
            const ts3 = toCanonicalTimestamp(new Date(date.getTime()));

            expect(ts1).toBe(ts2);
            expect(ts2).toBe(ts3);
            expect(ts1).toBe('2024-06-15T10:30:00.000Z');
        });

        test('null previousHash produces different hash than a string previousHash', () => {
            const input1 = makeInput({ previousHash: null });
            const input2 = makeInput({ previousHash: 'abc123' });

            expect(computeEntryHash(input1)).not.toBe(computeEntryHash(input2));
        });
    });

    // ── Report Format Validation ──

    describe('Report Structure', () => {
        test('chain verification produces correct entry count', () => {
            const chain = buildChain(5);

            // Walk the chain and count verified entries
            let verified = 0;
            let valid = true;
            let previousHash: string | null = null;

            for (const { input, entryHash } of chain) {
                const recomputed = computeEntryHash(input);
                if (recomputed !== entryHash) {
                    valid = false;
                    break;
                }
                if (input.previousHash !== previousHash) {
                    // Allow null for first entry
                    if (verified > 0) {
                        valid = false;
                        break;
                    }
                }
                previousHash = entryHash;
                verified++;
            }

            expect(verified).toBe(5);
            expect(valid).toBe(true);
        });

        test('tampering at position 3 reports correct break position', () => {
            const chain = buildChain(5);

            // Tamper entry at index 3
            const tampered = {
                ...chain[3].input,
                detailsJson: { category: 'custom', tampered: true },
            };

            // Walk chain and find first break
            let breakPosition = -1;
            let previousHash: string | null = null;

            for (let i = 0; i < chain.length; i++) {
                const input = i === 3 ? tampered : chain[i].input;
                const storedHash = chain[i].entryHash;

                const recomputed = computeEntryHash(input);
                if (recomputed !== storedHash) {
                    breakPosition = i;
                    break;
                }
                if (i > 0 && input.previousHash !== previousHash) {
                    breakPosition = i;
                    break;
                }
                previousHash = storedHash;
            }

            expect(breakPosition).toBe(3);
        });
    });
});

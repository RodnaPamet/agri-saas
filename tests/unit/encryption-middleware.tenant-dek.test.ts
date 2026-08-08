/**
 * Unit Test: Epic B.2 tenant-DEK integration in the encryption middleware.
 *
 * Builds on the Epic B.1 baseline (existing
 * `encryption-middleware.test.ts`) to pin the v2 / tenant-DEK behaviour:
 *
 *   - With an audit-context tenantId, writes produce **v2** ciphertext
 *     using the tenant's DEK.
 *   - Without context, writes fall back to **v1** under the global KEK.
 *   - Reads dispatch per-value: v1 → global KEK, v2 → tenant DEK.
 *   - **Cross-tenant isolation**: tenant A's v2 ciphertext is NOT
 *     decryptable with tenant B's DEK; the middleware catches the
 *     GCM failure, logs a warning, and returns the raw ciphertext.
 *   - Bypass sources (seed / job / system) fall back to v1 so
 *     cross-tenant sweeps don't end up encrypting under the wrong
 *     tenant's DEK.
 *   - `Tenant` model queries never resolve a DEK (recursion guard).
 *   - Mixed v1/v2 rows in a single result are handled correctly.
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

// Mock the audit-context stack so we can script tenant context for
// specific tests without spinning up the real request pipeline.
const currentAuditCtx: { tenantId?: string; source?: string } = {};
jest.mock('@/lib/audit-context', () => ({
    getAuditContext: () => ({ ...currentAuditCtx }),
}));

// Mock the tenant key manager. We script DEKs per tenantId so the
// test can ask "did we encrypt under tenant A's key?" by attempting
// a decrypt with the same DEK.
const tenantDekMap = new Map<string, Buffer>();
const tenantPreviousDekMap = new Map<string, Buffer>();
const getTenantDekMock = jest.fn(async (tenantId: string) => {
    const dek = tenantDekMap.get(tenantId);
    if (!dek) throw new Error(`no DEK for ${tenantId}`);
    return dek;
});
const getTenantPreviousDekMock = jest.fn(async (tenantId: string) => {
    return tenantPreviousDekMap.get(tenantId) ?? null;
});
jest.mock('@/lib/security/tenant-key-manager', () => ({
    getTenantDek: (tenantId: string) => getTenantDekMock(tenantId),
    getTenantPreviousDek: (tenantId: string) =>
        getTenantPreviousDekMock(tenantId),
}));

import {
    encryptField,
    encryptWithKey,
    decryptField,
    decryptWithKey,
    getCiphertextVersion,
    isEncryptedValue,
} from '@/lib/security/encryption';
import { generateDek } from '@/lib/security/tenant-keys';
import { _internals } from '@/lib/db/encryption-middleware';
import { logger } from '@/lib/observability/logger';

const { walkWriteArgument, walkReadResult, resolveTenantDekPair } = _internals;

// Test helper — wrap a Buffer | null primary DEK in the pair shape
// the read path now expects. Most existing tests don't exercise the
// previous-DEK fallback, so previous is null.
function pair(primary: Buffer | null, previous: Buffer | null = null) {
    return { primary, previous };
}

// Small helper — run a block with a specific audit context in play,
// then reset. Keeps tests independent of ordering.
async function withAuditCtx<T>(
    ctx: { tenantId?: string; source?: string },
    fn: () => Promise<T> | T,
): Promise<T> {
    Object.assign(currentAuditCtx, ctx);
    try {
        return await fn();
    } finally {
        delete currentAuditCtx.tenantId;
        delete currentAuditCtx.source;
    }
}

beforeEach(() => {
    tenantDekMap.clear();
    tenantPreviousDekMap.clear();
    getTenantDekMock.mockClear();
    getTenantPreviousDekMock.mockClear();
    jest.clearAllMocks();
    delete currentAuditCtx.tenantId;
    delete currentAuditCtx.source;
});

describe('resolveTenantDekPair (middleware hook)', () => {
    it('returns empty pair when no audit context is set (v1 fallback)', async () => {
        const deks = await resolveTenantDekPair('Finding');
        expect(deks.primary).toBeNull();
        expect(deks.previous).toBeNull();
    });

    it('returns empty pair for Tenant model regardless of context (recursion guard)', async () => {
        tenantDekMap.set('tenant-A', generateDek());
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Tenant');
            expect(deks.primary).toBeNull();
            expect(deks.previous).toBeNull();
        });
        // Most importantly — we never called either side of the manager.
        expect(getTenantDekMock).not.toHaveBeenCalled();
        expect(getTenantPreviousDekMock).not.toHaveBeenCalled();
    });

    it.each(['seed', 'job', 'system'])(
        'returns empty pair for bypass source=%s (v1 fallback, multi-tenant scoped code)',
        async (source) => {
            tenantDekMap.set('tenant-A', generateDek());
            await withAuditCtx(
                { tenantId: 'tenant-A', source },
                async () => {
                    const deks = await resolveTenantDekPair('Finding');
                    expect(deks.primary).toBeNull();
                    expect(deks.previous).toBeNull();
                },
            );
            expect(getTenantDekMock).not.toHaveBeenCalled();
            expect(getTenantPreviousDekMock).not.toHaveBeenCalled();
        },
    );

    it('returns the primary DEK when audit context is a regular api request', async () => {
        const dek = generateDek();
        tenantDekMap.set('tenant-A', dek);
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Finding');
            expect(deks.primary).not.toBeNull();
            expect(deks.primary!.equals(dek)).toBe(true);
            expect(deks.previous).toBeNull();
        });
    });

    it('returns BOTH primary and previous DEKs when a rotation is in flight', async () => {
        const primaryDek = generateDek();
        const previousDek = generateDek();
        tenantDekMap.set('tenant-A', primaryDek);
        tenantPreviousDekMap.set('tenant-A', previousDek);
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Finding');
            expect(deks.primary!.equals(primaryDek)).toBe(true);
            expect(deks.previous!.equals(previousDek)).toBe(true);
        });
    });

    it('returns empty pair + logs warn when the primary key manager throws', async () => {
        // No DEK set → primary mock throws.
        await withAuditCtx({ tenantId: 'tenant-missing', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Finding');
            expect(deks.primary).toBeNull();
            expect(deks.previous).toBeNull();
        });
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.dek_resolve_failed',
            expect.objectContaining({ tenantId: 'tenant-missing' }),
        );
    });

    it('survives a previous-DEK lookup throw — primary stays valid', async () => {
        const dek = generateDek();
        tenantDekMap.set('tenant-A', dek);
        getTenantPreviousDekMock.mockImplementationOnce(async () => {
            throw new Error('transient db blip');
        });
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Finding');
            expect(deks.primary!.equals(dek)).toBe(true);
            expect(deks.previous).toBeNull();
        });
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.previous_dek_resolve_failed',
            expect.objectContaining({ tenantId: 'tenant-A' }),
        );
    });
});

describe('write path — v2 when DEK present, v1 fallback otherwise', () => {
    it('with a tenant DEK, writes produce v2 ciphertext', () => {
        const dek = generateDek();
        const data = { rootCause: 'secret-notes' };
        walkWriteArgument(data, 'Finding', dek);
        expect(getCiphertextVersion(data.rootCause as string)).toBe('v2');
        // Round-trip under the tenant DEK recovers the plaintext.
        expect(decryptWithKey(dek, data.rootCause as string)).toBe(
            'secret-notes',
        );
    });

    it('without a tenant DEK (null), writes produce v1 ciphertext', () => {
        const data = { rootCause: 'fallback-notes' };
        walkWriteArgument(data, 'Finding', null);
        expect(getCiphertextVersion(data.rootCause as string)).toBe('v1');
        expect(decryptField(data.rootCause as string)).toBe(
            'fallback-notes',
        );
    });

    it('nested writes inherit the DEK (comments under a Task create)', () => {
        const dek = generateDek();
        const data = {
            title: 'plain-title',
            description: 'parent-desc',
            comments: {
                create: [{ body: 'c1' }, { body: 'c2' }],
            },
        };
        walkWriteArgument(data, 'Task', dek);
        expect(getCiphertextVersion(data.description as string)).toBe('v2');
        const comments = (data.comments as { create: Array<{ body: string }> })
            .create;
        for (const c of comments) {
            expect(getCiphertextVersion(c.body)).toBe('v2');
            expect(decryptWithKey(dek, c.body)).toMatch(/^c[12]$/);
        }
    });

    it('is idempotent — a value that is already v2 is not double-encrypted', () => {
        const dek = generateDek();
        const already = encryptWithKey(dek, 'already encrypted');
        const data = { rootCause: already };
        walkWriteArgument(data, 'Finding', dek);
        expect(data.rootCause).toBe(already);
    });

    it('is idempotent — a value that is already v1 is not double-encrypted with v2', () => {
        const dek = generateDek();
        const alreadyV1 = encryptField('v1 legacy value');
        const data = { rootCause: alreadyV1 };
        walkWriteArgument(data, 'Finding', dek);
        // Still v1 — mixed-state tolerance.
        expect(data.rootCause).toBe(alreadyV1);
    });
});

describe('read path — per-value dispatch on v1 / v2', () => {
    it('decrypts v2 with the supplied tenant DEK', () => {
        const dek = generateDek();
        const node = {
            rootCause: encryptWithKey(dek, 'notes-under-v2'),
        };
        walkReadResult(node, 'Finding', pair(dek));
        expect(node.rootCause).toBe('notes-under-v2');
    });

    it('decrypts v1 using the global KEK, regardless of the supplied DEK', () => {
        const dek = generateDek();
        const node = {
            rootCause: encryptField('legacy-v1-value'),
        };
        walkReadResult(node, 'Finding', pair(dek));
        expect(node.rootCause).toBe('legacy-v1-value');
    });

    it('handles MIXED v1 + v2 rows in a single findMany result', () => {
        const dek = generateDek();
        const rows = [
            { rootCause: encryptField('v1-row') },
            { rootCause: encryptWithKey(dek, 'v2-row') },
            { rootCause: null },
            { rootCause: 'pre-encryption plaintext legacy' },
        ];
        walkReadResult(rows, 'Finding', pair(dek));
        expect(rows[0].rootCause).toBe('v1-row');
        expect(rows[1].rootCause).toBe('v2-row');
        expect(rows[2].rootCause).toBeNull();
        expect(rows[3].rootCause).toBe(
            'pre-encryption plaintext legacy',
        );
    });

    it('included relations inherit the DEK on recursive decrypt', () => {
        const dek = generateDek();
        const row = {
            description: encryptWithKey(dek, 'parent-desc'),
            comments: [
                { body: encryptWithKey(dek, 'comment-1') },
                { body: encryptWithKey(dek, 'comment-2') },
            ],
        };
        walkReadResult(row, 'Task', pair(dek));
        expect(row.description).toBe('parent-desc');
        expect(row.comments[0].body).toBe('comment-1');
        expect(row.comments[1].body).toBe('comment-2');
    });

    it('v2 with no DEK available — logs warn, returns raw (never throws)', () => {
        const dek = generateDek();
        const node = {
            rootCause: encryptWithKey(dek, 'should-not-decrypt'),
        };
        // Pass null — simulates a cross-tenant bypass read.
        expect(() => walkReadResult(node, 'Finding', pair(null))).not.toThrow();
        // Value preserved (still ciphertext).
        expect(getCiphertextVersion(node.rootCause as string)).toBe('v2');
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({
                version: 'v2',
                field: 'rootCause',
            }),
        );
    });
});

describe('mid-rotation read fallback to previous DEK', () => {
    it('decrypts a v2 row written under the PREVIOUS DEK using the fallback', () => {
        const previousDek = generateDek();
        const newPrimaryDek = generateDek();
        // Row was written before the rotation — under the (now)
        // previous DEK.
        const oldRow = {
            rootCause: encryptWithKey(previousDek, 'pre-rotation-value'),
        };
        // Reader has the new primary DEK + the previous (mid-rotation
        // pair). The middleware's decryptValue falls back on AES-GCM
        // auth failure.
        walkReadResult(oldRow, 'Finding', pair(newPrimaryDek, previousDek));
        expect(oldRow.rootCause).toBe('pre-rotation-value');
    });

    it('mixed batch of pre- and post-rotation rows decrypts cleanly under the pair', () => {
        const previousDek = generateDek();
        const newPrimaryDek = generateDek();
        const rows = [
            {
                rootCause: encryptWithKey(previousDek, 'pre-row'),
            },
            {
                rootCause: encryptWithKey(newPrimaryDek, 'post-row'),
            },
        ];
        walkReadResult(rows, 'Finding', pair(newPrimaryDek, previousDek));
        expect(rows[0].rootCause).toBe('pre-row');
        expect(rows[1].rootCause).toBe('post-row');
    });

    it('without a previous DEK, a pre-rotation row fails safely (warn + ciphertext preserved)', () => {
        const previousDek = generateDek();
        const newPrimaryDek = generateDek();
        // Reader does NOT have the previous DEK — simulates the
        // post-rotation steady state where Tenant.previousEncryptedDek
        // is now NULL but a stale row still carries the old ciphertext.
        const oldRow = {
            rootCause: encryptWithKey(previousDek, 'pre-rotation-value'),
        };
        walkReadResult(oldRow, 'Finding', pair(newPrimaryDek, null));
        // Decryption failed; ciphertext preserved, warn emitted.
        expect(getCiphertextVersion(oldRow.rootCause as string)).toBe('v2');
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({ version: 'v2' }),
        );
    });
});

describe('cross-tenant isolation', () => {
    it("tenant A's v2 ciphertext is NOT decryptable with tenant B's DEK", () => {
        const dekA = generateDek();
        const dekB = generateDek();
        expect(dekA.equals(dekB)).toBe(false); // sanity

        const aCipher = encryptWithKey(dekA, 'tenant-A-secret');
        const node = { rootCause: aCipher };

        // Reader has tenant B's DEK only — GCM tag should fail.
        walkReadResult(node, 'Finding', pair(dekB));

        // Ciphertext preserved (decryption failed safely).
        expect(node.rootCause).toBe(aCipher);
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({ version: 'v2' }),
        );
    });

    it('two tenants writing the same plaintext produce different ciphertexts', () => {
        const dekA = generateDek();
        const dekB = generateDek();
        const plaintext = 'identical value';
        const a = { rootCause: plaintext };
        const b = { rootCause: plaintext };
        walkWriteArgument(a, 'Finding', dekA);
        walkWriteArgument(b, 'Finding', dekB);
        expect(a.rootCause).not.toBe(b.rootCause);
        // Each is only decryptable with its own DEK.
        expect(decryptWithKey(dekA, a.rootCause as string)).toBe(plaintext);
        expect(decryptWithKey(dekB, b.rootCause as string)).toBe(plaintext);
        // Swapping keys does NOT produce plaintext — verified by the
        // GCM auth failure (thrown by decryptWithKey, not swallowed).
        expect(() =>
            decryptWithKey(dekA, b.rootCause as string),
        ).toThrow();
    });

    it('isEncryptedValue recognises BOTH v1 and v2 so idempotency gates work across tenants', () => {
        const dekA = generateDek();
        const v1 = encryptField('v1');
        const v2 = encryptWithKey(dekA, 'v2');
        expect(isEncryptedValue(v1)).toBe(true);
        expect(isEncryptedValue(v2)).toBe(true);
        expect(isEncryptedValue('not an envelope')).toBe(false);
        expect(isEncryptedValue(null)).toBe(false);
    });
});

describe('never leaks DEK material or plaintext in logs', () => {
    it('decrypt failure logs carry no plaintext and no DEK bytes', () => {
        const dek = generateDek();
        const plaintext = 'SECRET_SAUCE_xyz_123';
        const node = {
            // v2 ciphertext, but we pass a different DEK to force a
            // GCM tag failure.
            rootCause: encryptWithKey(dek, plaintext),
        };
        const wrongDek = generateDek();
        walkReadResult(node, 'Finding', pair(wrongDek));

        // Every warn call should be value-free.
        const allLogs = JSON.stringify(
            (logger.warn as jest.Mock).mock.calls,
        );
        expect(allLogs).not.toContain(plaintext);
        expect(allLogs).not.toContain(dek.toString('hex'));
        expect(allLogs).not.toContain(dek.toString('base64'));
        expect(allLogs).not.toContain(wrongDek.toString('hex'));
    });
});

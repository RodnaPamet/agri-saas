/**
 * Unit Test: Epic B.1 field-level encryption middleware.
 *
 * Pins the transparent encrypt-on-write / decrypt-on-read contract:
 *   - manifest fields round-trip (plaintext → ciphertext → plaintext)
 *   - non-manifest fields are never touched
 *   - null / undefined / '' are passthrough
 *   - already-encrypted values are NOT re-encrypted (idempotent)
 *   - legacy plaintext on read passes through (rollout-safe)
 *   - malformed ciphertext on read logs + returns raw (never throws)
 *   - nested relation writes encrypt descendant models
 *   - included relations on reads get decrypted recursively
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

import {
    encryptField,
    isEncryptedValue,
} from '@/lib/security/encryption';
import {
    ENCRYPTED_FIELDS,
    isEncryptedModel,
    getEncryptedFields,
} from '@/lib/security/encrypted-fields';
import {
    _internals,
    withEncryptionExtension,
} from '@/lib/db/encryption-middleware';
import { logger } from '@/lib/observability/logger';

const NO_DEKS = { primary: null, previous: null } as const;
const { walkWriteArgument, walkReadResult, encryptDataNode, decryptResultNode } =
    _internals;

describe('ENCRYPTED_FIELDS manifest', () => {
    it('contains the core Epic B.1 models', () => {
        for (const m of [
            'Task',
            'EvidenceReview',
            'TaskComment',
            'Contract',
            // PracticeTestRun was in this list until the compliance uproot
            // dropped the model; its manifest entry went with it. The
            // Finding / Vendor / PolicyVersion / Audit / AuditChecklistItem
            // entries went the same way in GRC teardown phase 2 — these
            // suites now exercise the manifest through Task / TaskComment,
            // which are KEEP models with the same two-field shape.
        ]) {
            expect(isEncryptedModel(m)).toBe(true);
        }
    });

    it('deliberately excludes search-load-bearing fields', () => {
        // Flagged in the manifest as "omit until product decision on
        // dropping substring search". These must stay off until that
        // decision + the repo search removal land together.
        // The Risk example went with the risk register and the Vendor /
        // Policy examples with GRC teardown phase 2; Task.title is the
        // remaining searched-and-deliberately-plaintext column.
        expect(ENCRYPTED_FIELDS.Task).not.toContain('title');
        expect(ENCRYPTED_FIELDS.Contract).not.toContain('counterparty');
    });

    it('excludes non-tenant global library tables', () => {
        for (const m of [
            'Framework',
            'Clause',
            'PolicyTemplate',
            'QuestionnaireTemplate',
        ]) {
            expect(isEncryptedModel(m)).toBe(false);
        }
    });

    it('returns undefined for unknown models', () => {
        expect(getEncryptedFields('DoesNotExist')).toBeUndefined();
        expect(getEncryptedFields(undefined)).toBeUndefined();
    });

    it('registers the БАБХ FarmProfile identifiers (egn/eik)', () => {
        expect(isEncryptedModel('FarmProfile')).toBe(true);
        expect(getEncryptedFields('FarmProfile')).toEqual(['egn', 'eik']);
    });

    it('round-trips FarmProfile egn/eik plaintext → ciphertext → plaintext', () => {
        const data: Record<string, unknown> = {
            producerName: 'ЕТ Иван Петров',
            egn: '7501011234',
            eik: '203456789',
            tenantId: 'tenant-1',
        };
        encryptDataNode(data, 'FarmProfile', null);
        // Sensitive identifiers encrypted; producerName left plaintext.
        expect(isEncryptedValue(data.egn as string)).toBe(true);
        expect(isEncryptedValue(data.eik as string)).toBe(true);
        expect(data.producerName).toBe('ЕТ Иван Петров');

        decryptResultNode(data, 'FarmProfile', NO_DEKS);
        expect(data.egn).toBe('7501011234');
        expect(data.eik).toBe('203456789');
    });
});

describe('encryptDataNode', () => {
    it('encrypts listed fields and leaves others alone', () => {
        const data: Record<string, unknown> = {
            description: 'sensitive remediation plan',
            resolution: 'rework the drainage channel',
            status: 'OPEN',
            score: 12,
            tenantId: 'tenant-1',
        };
        encryptDataNode(data, 'Task', null);

        expect(isEncryptedValue(data.description as string)).toBe(true);
        expect(isEncryptedValue(data.resolution as string)).toBe(true);
        expect(data.status).toBe('OPEN'); // not in manifest
        expect(data.score).toBe(12);
        expect(data.tenantId).toBe('tenant-1');
    });

    it('is idempotent — re-encrypting a ciphertext is a no-op', () => {
        const alreadyEncrypted = encryptField('existing ciphertext');
        const data = { description: alreadyEncrypted };
        encryptDataNode(data, 'Task', null);
        expect(data.description).toBe(alreadyEncrypted);
    });

    it('passes null / undefined / empty string through unchanged', () => {
        const data: Record<string, unknown> = {
            description: null,
            threat: undefined,
            vulnerability: '',
        };
        encryptDataNode(data, 'Task', null);
        expect(data.description).toBeNull();
        expect(data.threat).toBeUndefined();
        expect(data.vulnerability).toBe('');
    });

    it('skips non-string values defensively', () => {
        const data: Record<string, unknown> = {
            description: 42, // not a realistic Prisma shape but the
                                // middleware must not crash on it
        };
        encryptDataNode(data, 'Task', null);
        expect(data.description).toBe(42);
    });

    it('ignores models not in the manifest', () => {
        const data = { secret: 'should-stay-plain' }; // pragma: allowlist secret — test fixture, asserts non-manifest pass-through
        encryptDataNode(data, 'Framework', null);
        expect(data.secret).toBe('should-stay-plain');
    });
});

describe('decryptResultNode', () => {
    it('decrypts listed fields and leaves others alone', () => {
        const encrypted = encryptField('nuclear launch codes');
        const node: Record<string, unknown> = {
            description: encrypted,
            status: 'CLOSED',
            score: 1,
        };
        decryptResultNode(node, 'Task', NO_DEKS);
        expect(node.description).toBe('nuclear launch codes');
        expect(node.status).toBe('CLOSED');
    });

    it('passes legacy plaintext (no v1: prefix) through unchanged', () => {
        const node: Record<string, unknown> = {
            description: 'legacy plaintext row',
        };
        decryptResultNode(node, 'Task', NO_DEKS);
        expect(node.description).toBe('legacy plaintext row');
    });

    it('logs warn + returns raw on malformed ciphertext', () => {
        // Valid prefix, but payload is gibberish — AES-GCM decrypt
        // will throw. The middleware swallows, logs, and returns raw.
        const node: Record<string, unknown> = {
            description: 'v1:garbage-that-is-not-valid-base64-or-ciphertext',
        };
        expect(() => decryptResultNode(node, 'Task', NO_DEKS)).not.toThrow();
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({ model: 'Task', field: 'description' }),
        );
        // Raw value preserved.
        expect(node.description).toBe(
            'v1:garbage-that-is-not-valid-base64-or-ciphertext',
        );
    });

    it('handles null / empty gracefully', () => {
        const node: Record<string, unknown> = {
            description: null,
            resolution: '',
        };
        decryptResultNode(node, 'Task', NO_DEKS);
        expect(node.description).toBeNull();
        expect(node.resolution).toBe('');
    });
});

describe('walkWriteArgument — end-to-end encrypt', () => {
    it('encrypts a single create payload', () => {
        const data: Record<string, unknown> = {
            title: 'Bad thing',
            description: 'sensitive', // Task.description IS in manifest
            resolution: 'insider',    // Task.resolution IS in manifest
        };
        walkWriteArgument(data, 'Task', null);
        expect(isEncryptedValue(data.description as string)).toBe(true);
        expect(isEncryptedValue(data.resolution as string)).toBe(true);
        expect(data.title).toBe('Bad thing'); // not in manifest
    });

    it('encrypts an array payload (createMany.data)', () => {
        const rows = [
            { body: 'comment one' },
            { body: 'comment two' },
            { body: null },
        ];
        walkWriteArgument(rows, 'TaskComment', null);
        expect(isEncryptedValue(rows[0].body as string)).toBe(true);
        expect(isEncryptedValue(rows[1].body as string)).toBe(true);
        expect(rows[2].body).toBeNull();
    });

    it('descends into nested create under a relation', () => {
        // Task with nested comment.create — Task has `description`
        // (manifest), the nested TaskComment has `body` (manifest).
        const data: Record<string, unknown> = {
            title: 'Fix thing',
            description: 'parent description',
            comments: {
                create: [{ body: 'first comment' }, { body: 'second comment' }],
            },
        };
        walkWriteArgument(data, 'Task', null);
        expect(isEncryptedValue(data.description as string)).toBe(true);
        const comments = (data.comments as { create: Array<{ body: string }> })
            .create;
        expect(isEncryptedValue(comments[0].body)).toBe(true);
        expect(isEncryptedValue(comments[1].body)).toBe(true);
    });

    it('descends into createMany.data inside a relation nest', () => {
        const data: Record<string, unknown> = {
            title: 'Bulk parent',
            comments: {
                createMany: {
                    data: [{ body: 'bulk 1' }, { body: 'bulk 2' }],
                },
            },
        };
        walkWriteArgument(data, 'Task', null);
        const created = (
            data.comments as { createMany: { data: Array<{ body: string }> } }
        ).createMany.data;
        expect(isEncryptedValue(created[0].body)).toBe(true);
        expect(isEncryptedValue(created[1].body)).toBe(true);
    });

    it('descends into upsert.create + upsert.update', () => {
        const data: Record<string, unknown> = {
            title: 'X',
            comments: {
                upsert: {
                    where: { id: 'c1' },
                    create: { body: 'upsert-create' },
                    update: { body: 'upsert-update' },
                },
            },
        };
        walkWriteArgument(data, 'Task', null);
        const upsert = (
            data.comments as {
                upsert: { create: { body: string }; update: { body: string } };
            }
        ).upsert;
        expect(isEncryptedValue(upsert.create.body)).toBe(true);
        expect(isEncryptedValue(upsert.update.body)).toBe(true);
    });

    it('does NOT touch non-manifest fields under nested writes', () => {
        const data: Record<string, unknown> = {
            title: 'title stays plain',
            comments: {
                create: [
                    {
                        body: 'manifest field',
                        createdByUserId: 'user-1', // NOT in manifest
                    },
                ],
            },
        };
        walkWriteArgument(data, 'Task', null);
        const created = (data.comments as { create: Array<Record<string, unknown>> })
            .create;
        expect(created[0].createdByUserId).toBe('user-1');
    });

    it('passes through null / empty on all nested paths', () => {
        const data: Record<string, unknown> = {
            title: null,
            comments: { create: [{ body: null }, { body: '' }] },
        };
        walkWriteArgument(data, 'Task', null);
        const created = (data.comments as { create: Array<{ body: unknown }> })
            .create;
        expect(created[0].body).toBeNull();
        expect(created[1].body).toBe('');
    });
});

describe('walkReadResult — end-to-end decrypt', () => {
    it('decrypts a single read result', () => {
        const node = {
            id: 'r-1',
            description: encryptField('plan'),
            resolution: encryptField('rework the drainage channel'),
            status: 'OPEN',
        };
        walkReadResult(node, 'Task', NO_DEKS);
        expect(node.description).toBe('plan');
        expect(node.resolution).toBe('rework the drainage channel');
        expect(node.status).toBe('OPEN');
    });

    it('decrypts an array of findMany results', () => {
        const results = [
            { description: encryptField('A') },
            { description: encryptField('B') },
            { description: null },
            { description: 'legacy plaintext — passes through' },
        ];
        walkReadResult(results, 'Task', NO_DEKS);
        expect(results[0].description).toBe('A');
        expect(results[1].description).toBe('B');
        expect(results[2].description).toBeNull();
        expect(results[3].description).toBe(
            'legacy plaintext — passes through',
        );
    });

    it('decrypts included relations recursively', () => {
        const node = {
            id: 't-1',
            description: encryptField('parent task description'),
            comments: [
                { body: encryptField('comment 1') },
                { body: encryptField('comment 2') },
            ],
        };
        walkReadResult(node, 'Task', NO_DEKS);
        expect(node.description).toBe('parent task description');
        expect(node.comments[0].body).toBe('comment 1');
        expect(node.comments[1].body).toBe('comment 2');
    });

    it('decrypts deeply nested included relations', () => {
        const node = {
            id: 't-1',
            description: encryptField('top'),
            comments: [
                {
                    body: encryptField('mid'),
                    nestedExtra: {
                        body: encryptField('deep'),
                    },
                },
            ],
        };
        walkReadResult(node, 'Task', NO_DEKS);
        expect(node.description).toBe('top');
        expect(node.comments[0].body).toBe('mid');
        // The nestedExtra node is walked via the fan-out path.
        // Since `TaskComment` is in the manifest with `body`, the
        // nested body also gets decrypted.
        expect(
            (node.comments[0].nestedExtra as { body: string }).body,
        ).toBe('deep');
    });

    it('handles null / undefined / empty result shapes', () => {
        expect(() => walkReadResult(null, 'Task', NO_DEKS)).not.toThrow();
        expect(() => walkReadResult(undefined, 'Task', NO_DEKS)).not.toThrow();
        expect(() => walkReadResult([], 'Task', NO_DEKS)).not.toThrow();
        expect(() => walkReadResult({}, 'Task', NO_DEKS)).not.toThrow();
    });

    it('does NOT decrypt non-manifest model results', () => {
        const node = { description: 'stays plaintext forever' };
        walkReadResult(node, 'Framework', NO_DEKS); // not in manifest
        expect(node.description).toBe('stays plaintext forever');
    });
});

describe('withEncryptionExtension', () => {
    // Build a fake client whose `$extends` captures the registered
    // `$allOperations` handler so the tests can drive it directly,
    // mirroring how the equivalent v5 tests grabbed the `$use` callback.
    type Op = (p: {
        model: string;
        operation: string;
        args?: unknown;
        query: (a: unknown) => Promise<unknown>;
    }) => Promise<unknown>;

    function captureHandler(): { handler: Op } {
        const captured: { handler: Op } = {
            handler: (async ({ query, args }) => query(args)) as Op,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fake: any = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            $extends: (cfg: any) => {
                captured.handler = cfg.query.$allModels.$allOperations as Op;
                return fake;
            },
        };
        withEncryptionExtension(fake);
        return captured;
    }

    it('encrypts write args then decrypts read result — full round trip', async () => {
        const { handler } = captureHandler();

        // Capture the args observed by `query` (what Prisma would
        // have sent to the DB). Clone eagerly — real Prisma returns
        // a fresh row from the DB, NOT the same object the caller
        // passed in; without the clone, the middleware's subsequent
        // result-decrypt pass would mutate our captured snapshot.
        let seenDbArgs: unknown;
        const query = jest.fn(async (args: unknown) => {
            seenDbArgs = JSON.parse(JSON.stringify(args));
            // Simulate DB returning the written row, still ciphertext.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return JSON.parse(JSON.stringify((args as any).data));
        });

        const plaintext = 'mitigation strategy details';
        const result = (await handler({
            model: 'Task',
            operation: 'create',
            args: {
                data: { title: 'X', description: plaintext, status: 'OPEN' },
            },
            query,
        })) as { title: string; description: string; status: string };

        // What the DB saw: ciphertext.
        expect(
            isEncryptedValue(
                (seenDbArgs as { data: { description: string } }).data
                    .description,
            ),
        ).toBe(true);

        // What the caller saw: plaintext.
        expect(result.description).toBe(plaintext);
        expect(result.status).toBe('OPEN');
    });

    it('does not touch non-encrypted models', async () => {
        const { handler } = captureHandler();

        let seen: unknown;
        const query = jest.fn(async (args: unknown) => {
            seen = args;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (args as any).data;
        });

        const data = { key: 'ISO27001', name: 'ISO 27001' };
        await handler({
            model: 'Framework',
            operation: 'create',
            args: { data },
            query,
        });
        expect((seen as { data: Record<string, unknown> }).data).toEqual(data);
    });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/auto-evidence.ts`.
 *
 * `attachAutoEvidenceFromLogEntry(db, ctx, logEntryId)` walks a farm
 * LogEntry → the scheme requirement(s) it satisfies → the tenant's
 * Controls mapped to those requirements → one Evidence row per control
 * (status SUBMITTED, back-referenced via sourceLogEntryId). Mocks the
 * tenant-bound `db` handle, the audit emitter, and the sanitiser.
 *
 * Covers:
 *   - rule match for INPUT_APPLICATION → resolves requirements + controls,
 *     creates SUBMITTED evidence with sourceLogEntryId + sanitised title.
 *   - no-op for an unmapped LogEntry type.
 *   - no-op when there is no ControlRequirementLink (scheme not installed).
 *   - idempotency: existing (sourceLogEntryId, controlId) → skipped.
 *   - logEvent emitted per evidence created with the entity-lifecycle shape.
 */

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => `SAN::${s}`),
}));

import { logEvent } from '@/app-layer/events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    attachAutoEvidenceFromLogEntry,
    AUTO_EVIDENCE_RULES,
} from '@/app-layer/usecases/auto-evidence';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR', {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
});

/** Build a mock tenant-bound Prisma handle with controllable returns. */
function makeDb(overrides: {
    logEntry?: any;
    requirements?: any[];
    links?: any[];
    existingEvidence?: any[];
} = {}) {
    return {
        logEntry: {
            findFirst: jest.fn().mockResolvedValue(
                'logEntry' in overrides
                    ? overrides.logEntry
                    : { id: 'log-1', type: 'INPUT_APPLICATION', title: 'Sprayed Field A', occurredAt: new Date('2026-06-15T00:00:00Z') },
            ),
        },
        frameworkRequirement: {
            findMany: jest.fn().mockResolvedValue(overrides.requirements ?? [{ id: 'req-1' }, { id: 'req-2' }]),
        },
        controlRequirementLink: {
            findMany: jest.fn().mockResolvedValue(overrides.links ?? [{ controlId: 'ctrl-1' }, { controlId: 'ctrl-1' }, { controlId: 'ctrl-2' }]),
        },
        evidence: {
            findMany: jest.fn().mockResolvedValue(overrides.existingEvidence ?? []),
            create: jest.fn().mockImplementation((args: any) =>
                Promise.resolve({ id: `ev-${args.data.controlId}` }),
            ),
        },
        controlEvidenceLink: {
            // createMany, not create — the bridge resolves duplicates with
            // ON CONFLICT DO NOTHING rather than by catching a 23505 that
            // would already have aborted the enclosing transaction.
            createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
    } as any;
}

beforeEach(() => {
    jest.clearAllMocks();
    (sanitizePlainText as jest.Mock).mockImplementation((s: string) => `SAN::${s}`);
});

describe('AUTO_EVIDENCE_RULES', () => {
    it('maps INPUT_APPLICATION to the GlobalG.A.P. + EU-Organic input requirement codes', () => {
        const rules = AUTO_EVIDENCE_RULES.INPUT_APPLICATION;
        expect(rules).toBeDefined();
        const gg = rules!.find((r) => r.frameworkKey === 'GLOBALGAP-IFA-DEMO');
        expect(gg?.requirementCodes).toEqual(['CB.7.1', 'CB.7.6', 'CB.7.9']);
        const euo = rules!.find((r) => r.frameworkKey === 'EU-ORGANIC-2018-848-DEMO');
        expect(euo?.requirementCodes).toEqual(['EUO.2', 'EUO.3']);
    });
});

describe('attachAutoEvidenceFromLogEntry', () => {
    it('creates SUBMITTED evidence per distinct control with sourceLogEntryId + sanitised title', async () => {
        const db = makeDb();
        const result = await attachAutoEvidenceFromLogEntry(db, ctx, 'log-1');

        // Two distinct controls (ctrl-1 deduped) → two evidence rows.
        expect(result).toEqual({ created: 2 });
        expect(db.evidence.create).toHaveBeenCalledTimes(2);

        const firstData = db.evidence.create.mock.calls[0][0].data;
        expect(firstData).toMatchObject({
            tenantId: 'tenant-1',
            controlId: 'ctrl-1',
            sourceLogEntryId: 'log-1',
            type: 'LINK',
            title: 'SAN::Farm record — Sprayed Field A',
            content: '/t/acme/journal/log-1',
            category: 'AUTO_FARM_RECORD',
            status: 'SUBMITTED',
        });
        expect(firstData.dateCollected).toEqual(new Date('2026-06-15T00:00:00Z'));

        // Title ran through the sanitiser.
        expect(sanitizePlainText).toHaveBeenCalledWith('Farm record — Sprayed Field A');

        // Requirement resolution is a single findMany (no per-requirement loop).
        expect(db.frameworkRequirement.findMany).toHaveBeenCalledTimes(1);
        // Control resolution is a single findMany.
        expect(db.controlRequirementLink.findMany).toHaveBeenCalledTimes(1);
    });

    it('mirrors the control↔evidence bridge link', async () => {
        const db = makeDb();
        await attachAutoEvidenceFromLogEntry(db, ctx, 'log-1');
        expect(db.controlEvidenceLink.createMany).toHaveBeenCalledTimes(2);
        const first = db.controlEvidenceLink.createMany.mock.calls[0][0];
        expect(first.data[0]).toMatchObject({
            tenantId: 'tenant-1',
            controlId: 'ctrl-1',
            kind: 'LINK',
            url: '/t/acme/journal/log-1',
        });
        expect(first.skipDuplicates).toBe(true);
    });

    it('emits a logEvent per evidence created with the entity-lifecycle shape', async () => {
        const db = makeDb();
        await attachAutoEvidenceFromLogEntry(db, ctx, 'log-1');

        expect(logEvent).toHaveBeenCalledTimes(2);
        const [, ctxArg, payload] = (logEvent as jest.Mock).mock.calls[0];
        expect(ctxArg).toBe(ctx);
        expect(payload.action).toBe('AUTO_EVIDENCE_ATTACHED');
        expect(payload.entityType).toBe('Evidence');
        expect(payload.detailsJson).toMatchObject({
            category: 'entity_lifecycle',
            entityName: 'Evidence',
            operation: 'created',
            after: { sourceLogEntryId: 'log-1', controlId: 'ctrl-1', status: 'SUBMITTED' },
        });
    });

    it('is a no-op for an unmapped LogEntry type', async () => {
        const db = makeDb({ logEntry: { id: 'log-9', type: 'OBSERVATION', title: 'Walked the field', occurredAt: new Date() } });
        const result = await attachAutoEvidenceFromLogEntry(db, ctx, 'log-9');
        expect(result).toEqual({ created: 0 });
        // Never even queries requirements for an unmapped type.
        expect(db.frameworkRequirement.findMany).not.toHaveBeenCalled();
        expect(db.evidence.create).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('is a no-op when the LogEntry is missing', async () => {
        const db = makeDb({ logEntry: null });
        const result = await attachAutoEvidenceFromLogEntry(db, ctx, 'log-missing');
        expect(result).toEqual({ created: 0 });
        expect(db.frameworkRequirement.findMany).not.toHaveBeenCalled();
    });

    it('is a no-op when no ControlRequirementLink exists (scheme not installed)', async () => {
        const db = makeDb({ links: [] });
        const result = await attachAutoEvidenceFromLogEntry(db, ctx, 'log-1');
        expect(result).toEqual({ created: 0 });
        // Resolved requirements but found no mapped controls → never creates.
        expect(db.frameworkRequirement.findMany).toHaveBeenCalledTimes(1);
        expect(db.evidence.findMany).not.toHaveBeenCalled();
        expect(db.evidence.create).not.toHaveBeenCalled();
    });

    it('is a no-op when requirement codes resolve to no rows', async () => {
        const db = makeDb({ requirements: [] });
        const result = await attachAutoEvidenceFromLogEntry(db, ctx, 'log-1');
        expect(result).toEqual({ created: 0 });
        expect(db.controlRequirementLink.findMany).not.toHaveBeenCalled();
    });

    it('skips controls that already carry auto-evidence for this LogEntry (idempotent)', async () => {
        const db = makeDb({ existingEvidence: [{ controlId: 'ctrl-1' }] });
        const result = await attachAutoEvidenceFromLogEntry(db, ctx, 'log-1');

        // ctrl-1 already attached → only ctrl-2 gets new evidence.
        expect(result).toEqual({ created: 1 });
        expect(db.evidence.create).toHaveBeenCalledTimes(1);
        expect(db.evidence.create.mock.calls[0][0].data.controlId).toBe('ctrl-2');
    });

    it('tolerates a duplicate control↔evidence link — in the statement, not in a catch', async () => {
        // The old version of this test mocked the create as REJECTING and
        // asserted the attach survived, which is the behaviour a mock can
        // produce and a real transaction cannot: a 23505 aborts the
        // transaction at the database, so the audit write on the next line
        // died with 25P02. The duplicate is now absorbed by ON CONFLICT DO
        // NOTHING — the statement succeeds and inserts zero rows.
        const db = makeDb();
        db.controlEvidenceLink.createMany.mockResolvedValue({ count: 0 });
        const result = await attachAutoEvidenceFromLogEntry(db, ctx, 'log-1');
        expect(result).toEqual({ created: 2 });
        expect(db.evidence.create).toHaveBeenCalledTimes(2);
        for (const call of db.controlEvidenceLink.createMany.mock.calls) {
            expect(call[0].skipDuplicates).toBe(true);
        }
    });

    it('does NOT swallow a real bridge failure', async () => {
        // The other half of the contract. `skipDuplicates` absorbs exactly
        // one thing — a unique collision. A bad FK or an RLS denial must
        // still take the attach down rather than leave evidence rows behind
        // that the control tab will never show.
        const db = makeDb();
        db.controlEvidenceLink.createMany.mockRejectedValue(new Error('FK violation'));
        await expect(attachAutoEvidenceFromLogEntry(db, ctx, 'log-1')).rejects.toThrow(
            /FK violation/,
        );
    });
});

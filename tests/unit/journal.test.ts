/* eslint-disable @typescript-eslint/no-explicit-any -- standard test-mock pattern. */

/**
 * Unit tests for `src/app-layer/usecases/journal.ts`.
 *
 * Mocks the JournalRepository + db-context + audit, and uses the REAL
 * sanitiser so the XSS-strip assertions exercise the actual allowlist.
 * Covers create (ACTIVITY / OBSERVATION / INPUT_APPLICATION / HARVEST
 * with quantities), notes sanitisation, audit emission, and basic
 * list/get + authorization.
 */

// The mock db carries the model methods `attachAutoEvidenceFromLogEntry`
// (the INPUT_APPLICATION auto-evidence hook in createLogEntry) touches.
// `logEntry.findFirst` defaults to null so the hook short-circuits to a
// no-op — these tests assert the repository-call + audit shape, not the
// auto-evidence path (which has its own suite in auto-evidence.test.ts).
const mockDb = {
    logEntry: { findFirst: jest.fn().mockResolvedValue(null) },
    frameworkRequirement: { findMany: jest.fn().mockResolvedValue([]) },
    practiceRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
    evidence: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        // Derived scheme evidence follows the entry: a title edit re-titles it
        // and a soft-delete withdraws it, so update/delete/restore each touch
        // this. Before that, an edited entry left its evidence claiming the
        // old title and a deleted one left the claim standing entirely.
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    practiceEvidenceLink: { create: jest.fn(), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/JournalRepository', () => ({
    JournalRepository: {
        list: jest.fn(),
        listPaginated: jest.fn(),
        getById: jest.fn(),
        getByIdWithDeleted: jest.fn(),
        validLocationIds: jest.fn(),
        validEquipmentIds: jest.fn(),
        createLogEntry: jest.fn(),
        updateLogEntry: jest.fn(),
        listDeleted: jest.fn(),
        softDelete: jest.fn(),
        restore: jest.fn(),
        purge: jest.fn(),
        attachFile: jest.fn(),
        getFileLink: jest.fn(),
        detachFile: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/FileRepository', () => ({
    FileRepository: {
        getById: jest.fn(),
        findBySha256: jest.fn(),
        createPending: jest.fn(),
        markStored: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

// NOTE: the sanitiser is intentionally NOT mocked — the XSS-strip
// assertions below rely on the real allowlist behaviour.

import { JournalRepository } from '@/app-layer/repositories/JournalRepository';
import { logEvent } from '@/app-layer/events/audit';
import {
    listLogEntries,
    getLogEntry,
    createLogEntry,
    updateLogEntry,
    deleteLogEntry,
    listDeletedLogEntries,
    restoreLogEntry,
    purgeLogEntry,
    attachLogEntryFile,
    detachLogEntryFile,
} from '@/app-layer/usecases/journal';
import { makeRequestContext } from '../helpers/make-context';

const editorCtx = makeRequestContext('EDITOR', { userId: 'user-1', tenantId: 'tenant-1' });
const adminCtx = makeRequestContext('ADMIN', { userId: 'user-1', tenantId: 'tenant-1' });
const readerCtx = makeRequestContext('READER', { userId: 'user-2', tenantId: 'tenant-1' });

beforeEach(() => {
    jest.clearAllMocks();
    (JournalRepository.validLocationIds as jest.Mock).mockResolvedValue(new Set());
    (JournalRepository.validEquipmentIds as jest.Mock).mockResolvedValue(new Set());
    // Re-arm the auto-evidence no-op (clearAllMocks wiped the default).
    mockDb.logEntry.findFirst.mockResolvedValue(null);
    mockDb.frameworkRequirement.findMany.mockResolvedValue([]);
    mockDb.practiceRequirementLink.findMany.mockResolvedValue([]);
    mockDb.evidence.findMany.mockResolvedValue([]);
});

// ─── create ─────────────────────────────────────────────────────────

describe('createLogEntry', () => {
    it('creates an ACTIVITY entry and audits', async () => {
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({
            id: 'log-1', type: 'ACTIVITY', title: 'Mowed the south block', status: 'DONE',
        });

        const out = await createLogEntry(editorCtx, {
            type: 'ACTIVITY',
            title: 'Mowed the south block',
        });

        expect(out).toEqual({ id: 'log-1', type: 'ACTIVITY', title: 'Mowed the south block', status: 'DONE' });
        expect(JournalRepository.createLogEntry).toHaveBeenCalledWith(
            mockDb,
            editorCtx,
            expect.objectContaining({ type: 'ACTIVITY', title: 'Mowed the south block' }),
        );
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect(logEvent).toHaveBeenCalledWith(
            mockDb,
            editorCtx,
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'LogEntry',
                entityId: 'log-1',
                detailsJson: expect.objectContaining({ category: 'entity_lifecycle', operation: 'created' }),
            }),
        );
    });

    it('creates an OBSERVATION entry', async () => {
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({
            id: 'log-2', type: 'OBSERVATION', title: 'Aphids on row 4', status: 'DONE',
        });
        const out = await createLogEntry(editorCtx, { type: 'OBSERVATION', title: 'Aphids on row 4' });
        expect(out.type).toBe('OBSERVATION');
        expect(JournalRepository.createLogEntry).toHaveBeenCalledWith(
            mockDb, editorCtx, expect.objectContaining({ type: 'OBSERVATION' }),
        );
    });

    it('creates an INPUT_APPLICATION entry with a quantity line (the spray record)', async () => {
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({
            id: 'log-3', type: 'INPUT_APPLICATION', title: 'Glyphosate pass', status: 'DONE',
        });

        await createLogEntry(editorCtx, {
            type: 'INPUT_APPLICATION',
            title: 'Glyphosate pass',
            quantities: [{ measure: 'VOLUME', value: 42.5, unitId: 'unit-l', label: 'L applied' }],
        });

        const passed = (JournalRepository.createLogEntry as jest.Mock).mock.calls[0][2];
        expect(passed.quantities).toHaveLength(1);
        expect(passed.quantities[0]).toMatchObject({ measure: 'VOLUME', value: 42.5, unitId: 'unit-l', label: 'L applied' });
        // detailsJson records the quantity count.
        expect(logEvent).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({
                detailsJson: expect.objectContaining({ after: expect.objectContaining({ quantityCount: 1 }) }),
            }),
        );
    });

    it('creates a HARVEST entry with a weight quantity', async () => {
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({
            id: 'log-4', type: 'HARVEST', title: 'Tomato harvest', status: 'DONE',
        });
        await createLogEntry(editorCtx, {
            type: 'HARVEST',
            title: 'Tomato harvest',
            quantities: [{ measure: 'WEIGHT', value: 1200, unitId: 'unit-kg', label: 'kg picked' }],
        });
        const passed = (JournalRepository.createLogEntry as jest.Mock).mock.calls[0][2];
        expect(passed.quantities[0]).toMatchObject({ measure: 'WEIGHT', value: 1200 });
    });

    it('sanitizes title (plain text) and notes (rich text) — XSS stripped', async () => {
        (JournalRepository.createLogEntry as jest.Mock).mockResolvedValue({
            id: 'log-5', type: 'OBSERVATION', title: 'clean', status: 'DONE',
        });

        await createLogEntry(editorCtx, {
            type: 'OBSERVATION',
            title: 'Hello <script>alert(1)</script>',
            notes: '<p>Safe <strong>bold</strong></p><script>alert(2)</script><img src=x onerror=alert(3)>',
        });

        const passed = (JournalRepository.createLogEntry as jest.Mock).mock.calls[0][2];
        // Title — script tag + body removed entirely.
        expect(passed.title).not.toMatch(/<script>/i);
        expect(passed.title).not.toMatch(/alert\(1\)/);
        expect(passed.title).toContain('Hello');
        // Notes — script stripped, dangerous onerror handler stripped,
        // but safe formatting preserved.
        expect(passed.notes).not.toMatch(/<script>/i);
        expect(passed.notes).not.toMatch(/alert\(2\)/);
        expect(passed.notes).not.toMatch(/onerror/i);
        expect(passed.notes).toContain('<strong>bold</strong>');
    });

    it('validates location links belong to the tenant', async () => {
        (JournalRepository.validLocationIds as jest.Mock).mockResolvedValue(new Set(['loc-ok']));
        await expect(
            createLogEntry(editorCtx, {
                type: 'ACTIVITY',
                title: 'x',
                locationIds: ['loc-ok', 'loc-foreign'],
            }),
        ).rejects.toThrow(/INVALID_LOCATION/);
        expect(JournalRepository.createLogEntry).not.toHaveBeenCalled();
    });

    it('forbids a READER from creating', async () => {
        await expect(
            createLogEntry(readerCtx, { type: 'ACTIVITY', title: 'x' }),
        ).rejects.toThrow(/permission/i);
        expect(JournalRepository.createLogEntry).not.toHaveBeenCalled();
    });

    it('rejects an all-markup title that sanitizes to empty', async () => {
        await expect(
            createLogEntry(editorCtx, { type: 'ACTIVITY', title: '<script>bad()</script>' }),
        ).rejects.toThrow(/Title is required/);
    });
});

// ─── list / get ─────────────────────────────────────────────────────

describe('listLogEntries', () => {
    it('returns rows from the repository', async () => {
        (JournalRepository.list as jest.Mock).mockResolvedValue([
            { id: 'log-1', type: 'ACTIVITY', title: 'a', occurredAt: new Date() },
        ]);
        const out = await listLogEntries(readerCtx, { type: ['ACTIVITY'] });
        expect(out).toHaveLength(1);
        expect(JournalRepository.list).toHaveBeenCalledWith(mockDb, readerCtx, { type: ['ACTIVITY'] });
    });
});

describe('getLogEntry', () => {
    it('returns the hydrated entry', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue({ id: 'log-1', title: 'a', quantities: [], locations: [], equipment: [], files: [] });
        const out = await getLogEntry(readerCtx, 'log-1');
        expect(out.id).toBe('log-1');
    });

    it('throws notFound for a missing entry', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getLogEntry(readerCtx, 'nope')).rejects.toThrow(/not found/i);
    });
});

// ─── update ─────────────────────────────────────────────────────────

describe('updateLogEntry', () => {
    it('updates and audits', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue({ id: 'log-1', title: 'old' });
        (JournalRepository.updateLogEntry as jest.Mock).mockResolvedValue({ id: 'log-1', type: 'ACTIVITY', title: 'new', status: 'DONE' });

        const out = await updateLogEntry(editorCtx, 'log-1', { title: 'new' });
        expect(out.title).toBe('new');
        expect(logEvent).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({ action: 'UPDATE', entityType: 'LogEntry', entityId: 'log-1' }),
        );
    });

    it('throws notFound when the entry is missing', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(updateLogEntry(editorCtx, 'nope', { title: 'x' })).rejects.toThrow(/not found/i);
        expect(JournalRepository.updateLogEntry).not.toHaveBeenCalled();
    });

    it('sanitizes notes on update', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue({ id: 'log-1', title: 'old' });
        (JournalRepository.updateLogEntry as jest.Mock).mockResolvedValue({ id: 'log-1', type: 'ACTIVITY', title: 'old', status: 'DONE' });
        await updateLogEntry(editorCtx, 'log-1', { notes: 'ok<script>evil()</script>' });
        const passed = (JournalRepository.updateLogEntry as jest.Mock).mock.calls[0][3];
        expect(passed.notes).not.toMatch(/<script>/i);
        expect(passed.notes).not.toMatch(/evil\(\)/);
    });
});

// ─── delete / restore / purge ───────────────────────────────────────

describe('deleteLogEntry', () => {
    it('soft-deletes and audits', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue({ id: 'log-1', title: 'a' });
        (JournalRepository.softDelete as jest.Mock).mockResolvedValue({ id: 'log-1' });
        const out = await deleteLogEntry(editorCtx, 'log-1');
        expect(out).toEqual({ success: true });
        expect(JournalRepository.softDelete).toHaveBeenCalledWith(mockDb, editorCtx, 'log-1');
        expect(logEvent).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({ action: 'SOFT_DELETE', entityType: 'LogEntry' }),
        );
    });
});

describe('listDeletedLogEntries', () => {
    it('lists soft-deleted entries for an ADMIN (the Trash view)', async () => {
        (JournalRepository.listDeleted as jest.Mock).mockResolvedValue([
            { id: 'log-1', title: 'Old entry', deletedAt: new Date('2026-06-01') },
        ]);
        const out = await listDeletedLogEntries(adminCtx);
        expect(out).toHaveLength(1);
        expect(JournalRepository.listDeleted).toHaveBeenCalledWith(mockDb, adminCtx);
    });

    // Restore and purge are the only actions reachable from the Trash, and
    // both are ADMIN — so listing it is too.
    it('forbids a non-admin', async () => {
        await expect(listDeletedLogEntries(editorCtx)).rejects.toThrow(/permission/i);
    });
});

describe('restoreLogEntry', () => {
    it('restores a soft-deleted entry (ADMIN) and audits', async () => {
        (JournalRepository.getByIdWithDeleted as jest.Mock).mockResolvedValue({ id: 'log-1', deletedAt: new Date('2026-06-01') });
        (JournalRepository.restore as jest.Mock).mockResolvedValue({ id: 'log-1', deletedAt: null });
        const out = await restoreLogEntry(adminCtx, 'log-1');
        expect(out).toMatchObject({ id: 'log-1', deletedAt: null });
        expect(logEvent).toHaveBeenCalledWith(
            mockDb, adminCtx,
            expect.objectContaining({ action: 'ENTITY_RESTORED', entityType: 'LogEntry' }),
        );
    });

    it('forbids a non-admin', async () => {
        await expect(restoreLogEntry(editorCtx, 'log-1')).rejects.toThrow(/permission/i);
    });

    it('throws when the entry is not deleted', async () => {
        (JournalRepository.getByIdWithDeleted as jest.Mock).mockResolvedValue({ id: 'log-1', deletedAt: null });
        await expect(restoreLogEntry(adminCtx, 'log-1')).rejects.toThrow(/not deleted/i);
    });
});

describe('purgeLogEntry', () => {
    it('hard-deletes a soft-deleted entry (ADMIN) and audits', async () => {
        (JournalRepository.getByIdWithDeleted as jest.Mock).mockResolvedValue({ id: 'log-1', deletedAt: new Date('2026-06-01') });
        (JournalRepository.purge as jest.Mock).mockResolvedValue(true);
        const out = await purgeLogEntry(adminCtx, 'log-1');
        expect(out).toEqual({ success: true, purged: true });
        expect(logEvent).toHaveBeenCalledWith(
            mockDb, adminCtx,
            expect.objectContaining({ action: 'ENTITY_PURGED', entityType: 'LogEntry' }),
        );
    });

    it('refuses to purge a live (non-deleted) entry', async () => {
        (JournalRepository.getByIdWithDeleted as jest.Mock).mockResolvedValue({ id: 'log-1', deletedAt: null });
        await expect(purgeLogEntry(adminCtx, 'log-1')).rejects.toThrow(/must be soft-deleted/i);
    });
});

// ─── file attach / detach ───────────────────────────────────────────

describe('attachLogEntryFile / detachLogEntryFile', () => {
    it('attaches an existing FileRecord and audits', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue({ id: 'log-1' });
        const { FileRepository } = require('@/app-layer/repositories/FileRepository');
        (FileRepository.getById as jest.Mock).mockResolvedValue({ id: 'file-1', status: 'STORED' });
        (JournalRepository.getFileLink as jest.Mock).mockResolvedValue(null);
        (JournalRepository.attachFile as jest.Mock).mockResolvedValue({ id: 'link-1', fileRecordId: 'file-1' });

        const out = await attachLogEntryFile(editorCtx, 'log-1', 'file-1', 'wind drift');
        expect(out).toMatchObject({ id: 'link-1' });
        expect(logEvent).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({ action: 'LOG_ENTRY_FILE_ATTACHED', entityType: 'LogEntry' }),
        );
    });

    it('is idempotent — returns the existing link without re-auditing', async () => {
        (JournalRepository.getById as jest.Mock).mockResolvedValue({ id: 'log-1' });
        const { FileRepository } = require('@/app-layer/repositories/FileRepository');
        (FileRepository.getById as jest.Mock).mockResolvedValue({ id: 'file-1', status: 'STORED' });
        (JournalRepository.getFileLink as jest.Mock).mockResolvedValue({ id: 'link-existing' });

        const out = await attachLogEntryFile(editorCtx, 'log-1', 'file-1');
        expect(out).toEqual({ id: 'link-existing' });
        expect(JournalRepository.attachFile).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('detaches a file and audits', async () => {
        (JournalRepository.getFileLink as jest.Mock).mockResolvedValue({ id: 'link-1' });
        (JournalRepository.detachFile as jest.Mock).mockResolvedValue(true);
        const out = await detachLogEntryFile(editorCtx, 'log-1', 'file-1');
        expect(out).toEqual({ success: true });
        expect(logEvent).toHaveBeenCalledWith(
            mockDb, editorCtx,
            expect.objectContaining({ action: 'LOG_ENTRY_FILE_DETACHED', entityType: 'LogEntry' }),
        );
    });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/practice/tasks.ts` and
 * `src/app-layer/usecases/practice/evidence.ts`.
 *
 * Roadmap Q1 — Compliance core. Together these two files cover the
 * detail-page Tasks tab, Evidence tab (tab-lazy #102 payload), and
 * the contributor/asset linking surfaces. All are thin orchestration
 * over PracticeRepository — RBAC + repo-returns-null → notFound +
 * audit event shape is what we're locking.
 */

const mockDb = {
    practice: { findFirst: jest.fn() },
    evidence: { findMany: jest.fn() },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/PracticeRepository', () => ({
    PracticeRepository: {
        listTasks: jest.fn(),
        createTask: jest.fn(),
        updateTask: jest.fn(),
        deleteTask: jest.fn(),
        listEvidenceLinks: jest.fn(),
        linkEvidence: jest.fn(),
        unlinkEvidence: jest.fn(),
        linkAsset: jest.fn(),
        unlinkAsset: jest.fn(),
        listContributors: jest.fn(),
        addContributor: jest.fn(),
        removeContributor: jest.fn(),
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { PracticeRepository } from '@/app-layer/repositories/PracticeRepository';
import { logEvent } from '@/app-layer/events/audit';
import {
    listPracticeTasks,
    createPracticeTask,
    updatePracticeTask,
    deletePracticeTask,
} from '@/app-layer/usecases/practice/tasks';
import {
    listEvidenceLinks,
    getPracticeEvidenceTab,
    linkEvidence,
    unlinkEvidence,
    linkAssetToPractice,
    unlinkAssetFromPractice,
} from '@/app-layer/usecases/practice/evidence';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

// ─── practice/tasks.ts ──────────────────────────────────────────────

describe('listPracticeTasks', () => {
    it('delegates to PracticeRepository.listTasks under the read gate', async () => {
        (PracticeRepository.listTasks as jest.Mock).mockResolvedValue([{ id: 't-1' }]);
        const rows = await listPracticeTasks(readerCtx, 'c-1');
        expect(rows).toEqual([{ id: 't-1' }]);
        expect(PracticeRepository.listTasks).toHaveBeenCalledWith(mockDb, readerCtx, 'c-1');
    });
});

describe('createPracticeTask', () => {
    it('creates a task and emits CONTROL_TASK_CREATED audit', async () => {
        (PracticeRepository.createTask as jest.Mock).mockResolvedValue({ id: 't-1', title: 'X' });
        const res = await createPracticeTask(editorCtx, 'c-1', { title: 'X' });
        expect(res).toEqual({ id: 't-1', title: 'X' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_TASK_CREATED');
        expect(payload.entityId).toBe('c-1');
    });

    it('throws notFound when the practice does not exist', async () => {
        (PracticeRepository.createTask as jest.Mock).mockResolvedValue(null);
        await expect(createPracticeTask(editorCtx, 'missing', { title: 'X' })).rejects.toThrow(/Practice not found/i);
    });

    it('rejects READER (manage-tasks gate)', async () => {
        await expect(createPracticeTask(readerCtx, 'c-1', { title: 'X' })).rejects.toBeDefined();
        expect(PracticeRepository.createTask).not.toHaveBeenCalled();
    });
});

describe('updatePracticeTask', () => {
    it('emits CONTROL_TASK_COMPLETED when status set to DONE', async () => {
        (PracticeRepository.updateTask as jest.Mock).mockResolvedValue({ id: 't-1', practiceId: 'c-1', title: 'X' });

        await updatePracticeTask(editorCtx, 't-1', { status: 'DONE' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_TASK_COMPLETED');
    });

    it('emits CONTROL_TASK_UPDATED when status is not DONE', async () => {
        (PracticeRepository.updateTask as jest.Mock).mockResolvedValue({ id: 't-1', practiceId: 'c-1', title: 'X' });

        await updatePracticeTask(editorCtx, 't-1', { title: 'New' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_TASK_UPDATED');
    });

    it('throws notFound when the task is missing', async () => {
        (PracticeRepository.updateTask as jest.Mock).mockResolvedValue(null);
        await expect(updatePracticeTask(editorCtx, 'missing', { title: 'X' })).rejects.toThrow(/Task not found/i);
    });

    it('emits status_change category when status is in the payload', async () => {
        (PracticeRepository.updateTask as jest.Mock).mockResolvedValue({ id: 't-1', practiceId: 'c-1', title: 'X' });

        await updatePracticeTask(editorCtx, 't-1', { status: 'IN_PROGRESS' });

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.detailsJson.category).toBe('status_change');
        expect(payload.detailsJson.toStatus).toBe('IN_PROGRESS');
    });

    it('rejects READER (manage-tasks gate)', async () => {
        await expect(updatePracticeTask(readerCtx, 't-1', { title: 'X' })).rejects.toBeDefined();
    });
});

describe('deletePracticeTask', () => {
    it('returns success on delete', async () => {
        (PracticeRepository.deleteTask as jest.Mock).mockResolvedValue(true);
        const res = await deletePracticeTask(editorCtx, 't-1');
        expect(res).toEqual({ success: true });
    });

    it('throws notFound when the task does not exist', async () => {
        (PracticeRepository.deleteTask as jest.Mock).mockResolvedValue(null);
        await expect(deletePracticeTask(editorCtx, 'missing')).rejects.toThrow(/Task not found/i);
    });

    it('rejects READER (manage-tasks gate)', async () => {
        await expect(deletePracticeTask(readerCtx, 't-1')).rejects.toBeDefined();
    });
});

// ─── practice/evidence.ts ───────────────────────────────────────────

describe('listEvidenceLinks', () => {
    it('delegates to PracticeRepository.listEvidenceLinks under the read gate', async () => {
        (PracticeRepository.listEvidenceLinks as jest.Mock).mockResolvedValue([{ id: 'l-1' }]);
        const rows = await listEvidenceLinks(readerCtx, 'c-1');
        expect(rows).toEqual([{ id: 'l-1' }]);
    });
});

describe('getPracticeEvidenceTab', () => {
    it('returns links + direct evidence in a single bundled payload', async () => {
        (mockDb.practice.findFirst as jest.Mock).mockResolvedValue({ id: 'c-1' });
        (PracticeRepository.listEvidenceLinks as jest.Mock).mockResolvedValue([{ id: 'l-1' }]);
        (mockDb.evidence.findMany as jest.Mock).mockResolvedValue([{ id: 'e-1' }]);

        const res = await getPracticeEvidenceTab(readerCtx, 'c-1');

        expect(res).toEqual({ links: [{ id: 'l-1' }], evidence: [{ id: 'e-1' }] });
    });

    it('throws notFound when the practice is missing (neither query fires)', async () => {
        (mockDb.practice.findFirst as jest.Mock).mockResolvedValue(null);
        await expect(getPracticeEvidenceTab(readerCtx, 'missing')).rejects.toThrow(/Practice not found/i);
        expect(PracticeRepository.listEvidenceLinks).not.toHaveBeenCalled();
        expect(mockDb.evidence.findMany).not.toHaveBeenCalled();
    });
});

describe('linkEvidence', () => {
    it('creates a link and emits CONTROL_EVIDENCE_LINKED', async () => {
        (PracticeRepository.linkEvidence as jest.Mock).mockResolvedValue({ id: 'l-1' });

        const res = await linkEvidence(editorCtx, 'c-1', { kind: 'FILE', fileId: 'f-1' });

        expect(res).toEqual({ id: 'l-1' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_EVIDENCE_LINKED');
        expect(payload.detailsJson.relation).toBe('FILE');
    });

    it('throws notFound when the practice is missing', async () => {
        (PracticeRepository.linkEvidence as jest.Mock).mockResolvedValue(null);
        await expect(linkEvidence(editorCtx, 'missing', { kind: 'FILE' })).rejects.toThrow(/Practice not found/i);
    });

    it('rejects READER (link-evidence gate)', async () => {
        await expect(linkEvidence(readerCtx, 'c-1', { kind: 'FILE' })).rejects.toBeDefined();
    });
});

describe('unlinkEvidence', () => {
    it('removes link and emits CONTROL_EVIDENCE_UNLINKED', async () => {
        (PracticeRepository.unlinkEvidence as jest.Mock).mockResolvedValue(true);

        const res = await unlinkEvidence(editorCtx, 'c-1', 'l-1');

        expect(res).toEqual({ success: true });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('CONTROL_EVIDENCE_UNLINKED');
    });

    it('throws notFound when the link is missing', async () => {
        (PracticeRepository.unlinkEvidence as jest.Mock).mockResolvedValue(null);
        await expect(unlinkEvidence(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Evidence link not found/i);
    });

    it('rejects READER', async () => {
        await expect(unlinkEvidence(readerCtx, 'c-1', 'l-1')).rejects.toBeDefined();
    });
});

describe('linkAssetToPractice', () => {
    it('returns the link row when successful', async () => {
        (PracticeRepository.linkAsset as jest.Mock).mockResolvedValue({ practiceId: 'c-1', assetId: 'a-1' });
        const res = await linkAssetToPractice(editorCtx, 'c-1', 'a-1');
        expect(res).toEqual({ practiceId: 'c-1', assetId: 'a-1' });
    });

    it('throws notFound when the practice does not exist', async () => {
        (PracticeRepository.linkAsset as jest.Mock).mockResolvedValue(null);
        await expect(linkAssetToPractice(editorCtx, 'missing', 'a-1')).rejects.toThrow(/Practice not found/i);
    });

    it('rejects READER', async () => {
        await expect(linkAssetToPractice(readerCtx, 'c-1', 'a-1')).rejects.toBeDefined();
    });
});

describe('unlinkAssetFromPractice', () => {
    it('returns success on delete', async () => {
        (PracticeRepository.unlinkAsset as jest.Mock).mockResolvedValue(true);
        const res = await unlinkAssetFromPractice(editorCtx, 'c-1', 'a-1');
        expect(res).toEqual({ success: true });
    });

    it('throws notFound when the row is missing', async () => {
        (PracticeRepository.unlinkAsset as jest.Mock).mockResolvedValue(null);
        await expect(unlinkAssetFromPractice(editorCtx, 'c-1', 'missing')).rejects.toThrow(/Practice or asset link not found/i);
    });
});


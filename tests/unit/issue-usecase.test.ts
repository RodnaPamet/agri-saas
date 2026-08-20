/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/issue.ts`.
 *
 * Roadmap Q3 — Work items. `issue.ts` is the deprecated Issue usecase
 * that delegates to WorkItemRepository (tasks under the hood). Mocks
 * the repos + policies + audit + automation emitter + SLA helper +
 * work-item state machine.
 *
 * Covers:
 *   - listIssues / getIssue + SLA enrichment + notFound.
 *   - createIssue — repo create + ISSUE_CREATED audit +
 *     emitAutomationEvent dispatch with the right stableKey + payload.
 *   - updateIssue — patch shape + notFound + audit.
 *   - setIssueStatus — checkWorkItemTransition gate (rejects illegal
 *     transitions), resolution-required block on terminal statuses,
 *     fromStatus capture from prior row, stableKey shape, automation
 *     event payload.
 *   - assignIssue — assigneeUserId null clear + audit details branch.
 */

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: {
        list: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        setStatus: jest.fn(),
        assign: jest.fn(),
    },
    TaskLinkRepository: {
        listByTask: jest.fn(),
        link: jest.fn(),
        unlink: jest.fn(),
    },
    TaskCommentRepository: {
        listByTask: jest.fn(),
        create: jest.fn(),
    },
    TaskWatcherRepository: {
        listByTask: jest.fn(),
        add: jest.fn(),
        remove: jest.fn(),
    },
}));

jest.mock('@/app-layer/repositories/EvidenceBundleRepository', () => ({
    EvidenceBundleRepository: {},
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/app-layer/automation', () => ({
    emitAutomationEvent: jest.fn(),
}));

jest.mock('@/app-layer/domain/work-item-status', () => ({
    TERMINAL_WORK_ITEM_STATUSES: ['DONE', 'CLOSED', 'WONT_FIX', 'DUPLICATE'],
    checkWorkItemTransition: jest.fn(),
    formatTransitionError: jest.fn((err: any) => `Transition rejected: ${JSON.stringify(err)}`),
    isTerminalStatus: jest.fn((s: string) => ['DONE', 'CLOSED', 'WONT_FIX', 'DUPLICATE'].includes(s)),
}));

jest.mock('@/app-layer/services/sla', () => ({
    getSlaStatus: jest.fn(() => ({ label: 'on-track', breached: false })),
}));

jest.mock('@/lib/security/sanitize', () => ({
    // The repo-wide `SAN::` marker, but applied to the CONTENT rather than the
    // whole string. `setIssueStatus` now sanitises `resolution` BEFORE the
    // terminal-status emptiness gate (so markup-only text cannot pass as a
    // reason and then render as nothing), which means a stub that prefixes
    // unconditionally would turn '   ' into a non-empty value and silently
    // disable the whitespace-rejection assertion below. The real
    // `sanitizePlainText` returns whitespace unchanged and markup-only input
    // as '' — this stub honours both while still marking that it ran.
    sanitizePlainText: jest.fn((s: string) =>
        s.trim() === '' ? s : s.replace(/\S[\s\S]*\S|\S/, (m) => `SAN::${m}`),
    ),
}));

import { WorkItemRepository } from '@/app-layer/repositories/WorkItemRepository';
import { logEvent } from '@/app-layer/events/audit';
import { emitAutomationEvent } from '@/app-layer/automation';
import { checkWorkItemTransition, isTerminalStatus } from '@/app-layer/domain/work-item-status';
import { getSlaStatus } from '@/app-layer/services/sla';
import {
    listIssues,
    getIssue,
    createIssue,
    updateIssue,
    setIssueStatus,
    assignIssue,
} from '@/app-layer/usecases/issue';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
    (checkWorkItemTransition as jest.Mock).mockReturnValue(null);
    // `isTerminalStatus` is a type-guard (returns `status is "CLOSED" |
    // "RESOLVED" | "CANCELED"`), so a direct `as jest.Mock` cast triggers
    // TS2352 (the type guard doesn't sufficiently overlap with `Mock`).
    // The `as unknown as jest.Mock` two-step is the canonical workaround.
    (isTerminalStatus as unknown as jest.Mock).mockImplementation((s: string) =>
        ['DONE', 'CLOSED', 'WONT_FIX', 'DUPLICATE'].includes(s),
    );
    (getSlaStatus as jest.Mock).mockReturnValue({ label: 'on-track', breached: false });
});

const adminCtx = makeRequestContext('ADMIN');
const editorCtx = makeRequestContext('EDITOR');

// ─── listIssues / getIssue ─────────────────────────────────────────

describe('listIssues', () => {
    it('delegates to WorkItemRepository.list under the read gate', async () => {
        (WorkItemRepository.list as jest.Mock).mockResolvedValue([{ id: 'i-1' }]);
        const rows = await listIssues(editorCtx);
        expect(rows).toEqual([{ id: 'i-1' }]);
    });
});

describe('getIssue', () => {
    it('returns the row + SLA enrichment', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({
            id: 'i-1',
            severity: 'HIGH',
            status: 'OPEN',
            createdAt: new Date('2026-01-01'),
        });

        const res = await getIssue(editorCtx, 'i-1');

        expect(res).toMatchObject({
            id: 'i-1',
            sla: { label: 'on-track', breached: false },
        });
        expect(getSlaStatus).toHaveBeenCalledWith('HIGH', new Date('2026-01-01'), 'OPEN');
    });

    it('throws notFound on miss', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(getIssue(editorCtx, 'missing')).rejects.toThrow(/Issue not found/i);
    });
});

// ─── createIssue ───────────────────────────────────────────────────

describe('createIssue', () => {
    it('creates an issue, emits ISSUE_CREATED audit + automation event', async () => {
        (WorkItemRepository.create as jest.Mock).mockResolvedValue({
            id: 'i-1', key: 'TSK-1', title: 'X', severity: 'HIGH', status: 'OPEN', assigneeUserId: 'u-1',
        });

        const res = await createIssue(editorCtx, { title: 'X', type: 'GAP', severity: 'HIGH' });

        expect(res.id).toBe('i-1');
        const auditPayload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(auditPayload.action).toBe('ISSUE_CREATED');

        const eventPayload = (emitAutomationEvent as jest.Mock).mock.calls[0][1];
        expect(eventPayload.event).toBe('ISSUE_CREATED');
        expect(eventPayload.entityId).toBe('i-1');
        expect(eventPayload.stableKey).toBe('i-1');
        expect(eventPayload.data).toMatchObject({
            key: 'TSK-1',
            title: 'X',
            severity: 'HIGH',
            status: 'OPEN',
            assigneeUserId: 'u-1',
        });
    });
});

// ─── updateIssue ───────────────────────────────────────────────────

describe('updateIssue', () => {
    it('throws notFound when the issue is missing', async () => {
        (WorkItemRepository.update as jest.Mock).mockResolvedValue(null);
        await expect(updateIssue(editorCtx, 'missing', { title: 'X' })).rejects.toThrow(/Issue not found/i);
    });

    it('emits ISSUE_UPDATED audit on success', async () => {
        (WorkItemRepository.update as jest.Mock).mockResolvedValue({ id: 'i-1' });
        await updateIssue(editorCtx, 'i-1', { title: 'New' });
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('ISSUE_UPDATED');
    });

    it('forwards patch unchanged to the repository (no field stripping at this layer)', async () => {
        (WorkItemRepository.update as jest.Mock).mockResolvedValue({ id: 'i-1' });
        await updateIssue(editorCtx, 'i-1', { title: 'New', severity: 'HIGH', dueAt: '2027-01-01' });
        const args = (WorkItemRepository.update as jest.Mock).mock.calls[0][3];
        expect(args).toEqual({ title: 'New', severity: 'HIGH', dueAt: '2027-01-01' });
    });
});

// ─── setIssueStatus — state machine + resolution gate ──────────────

describe('setIssueStatus', () => {
    it('throws notFound when the issue does not exist', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue(null);
        await expect(setIssueStatus(adminCtx, 'missing', 'DONE', 'fixed'))
            .rejects.toThrow(/Issue not found/i);
        expect(WorkItemRepository.setStatus).not.toHaveBeenCalled();
    });

    it('rejects illegal transitions via checkWorkItemTransition', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({ id: 'i-1', status: 'OPEN' });
        (checkWorkItemTransition as jest.Mock).mockReturnValue({ reason: 'illegal' });

        await expect(setIssueStatus(adminCtx, 'i-1', 'DONE', 'fixed'))
            .rejects.toThrow(/Transition rejected/);

        expect(WorkItemRepository.setStatus).not.toHaveBeenCalled();
    });

    it('rejects terminal transitions without a resolution string', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({ id: 'i-1', status: 'IN_PROGRESS' });

        await expect(setIssueStatus(adminCtx, 'i-1', 'DONE'))
            .rejects.toThrow(/resolution is required when moving an issue to DONE/i);

        await expect(setIssueStatus(adminCtx, 'i-1', 'DONE', '   '))
            .rejects.toThrow(/resolution is required/i);

        expect(WorkItemRepository.setStatus).not.toHaveBeenCalled();
    });

    it('trims a supplied resolution and forwards it (terminal case)', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({ id: 'i-1', status: 'IN_PROGRESS' });
        (WorkItemRepository.setStatus as jest.Mock).mockResolvedValue({ id: 'i-1' });

        await setIssueStatus(adminCtx, 'i-1', 'DONE', '  finally fixed  ');

        const args = (WorkItemRepository.setStatus as jest.Mock).mock.calls[0];
        // `SAN::` proves the sanitiser ran on this path — `resolution` is an
        // ENCRYPTED_FIELDS column and used to reach the repository raw.
        expect(args[4]).toBe('SAN::finally fixed');
    });

    it('allows non-terminal transition with no resolution', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({ id: 'i-1', status: 'OPEN' });
        (WorkItemRepository.setStatus as jest.Mock).mockResolvedValue({ id: 'i-1' });

        await expect(setIssueStatus(adminCtx, 'i-1', 'IN_PROGRESS')).resolves.toMatchObject({ id: 'i-1' });
    });

    it('captures fromStatus before mutation and emits both audit and automation event', async () => {
        (WorkItemRepository.getById as jest.Mock).mockResolvedValue({ id: 'i-1', status: 'IN_PROGRESS' });
        (WorkItemRepository.setStatus as jest.Mock).mockResolvedValue({ id: 'i-1' });

        await setIssueStatus(adminCtx, 'i-1', 'DONE', 'fixed');

        const auditPayload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(auditPayload.action).toBe('ISSUE_STATUS_CHANGED');
        expect(auditPayload.detailsJson.fromStatus).toBe('IN_PROGRESS');
        expect(auditPayload.detailsJson.toStatus).toBe('DONE');

        const eventPayload = (emitAutomationEvent as jest.Mock).mock.calls[0][1];
        expect(eventPayload.event).toBe('ISSUE_STATUS_CHANGED');
        expect(eventPayload.stableKey).toBe('i-1:IN_PROGRESS:DONE');
        expect(eventPayload.data).toEqual({ fromStatus: 'IN_PROGRESS', toStatus: 'DONE' });
    });
});

// ─── assignIssue ───────────────────────────────────────────────────

describe('assignIssue', () => {
    it('throws notFound when the issue does not exist', async () => {
        (WorkItemRepository.assign as jest.Mock).mockResolvedValue(null);
        await expect(assignIssue(adminCtx, 'missing', 'u-1')).rejects.toThrow(/Issue not found/i);
    });

    it('emits ISSUE_ASSIGNED audit with "Assigned to" details on real assignee', async () => {
        (WorkItemRepository.assign as jest.Mock).mockResolvedValue({ id: 'i-1' });
        await assignIssue(adminCtx, 'i-1', 'u-1');

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('ISSUE_ASSIGNED');
        expect(payload.details).toBe('Assigned to u-1');
    });

    it('emits "Unassigned" details branch on null assignee (clear)', async () => {
        (WorkItemRepository.assign as jest.Mock).mockResolvedValue({ id: 'i-1' });
        await assignIssue(adminCtx, 'i-1', null);

        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.details).toBe('Unassigned');
    });
});

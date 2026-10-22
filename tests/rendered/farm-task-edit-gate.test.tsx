/**
 * The task EDIT control is offered on the same rule the server enforces (#2169).
 *
 * `assertCanEditTask` made editing creator-or-admin on the server. This page
 * gated its «Редактирай» button on `canWrite` alone, so a writer who did not
 * create the task was still offered the control and got a 403
 * `TASK_EDIT_NOT_PERMITTED` — after opening the form and typing into it. An
 * offered control that refuses is worse than an absent one.
 *
 * ## Why this is a RENDERED test and not a guard
 *
 * Every existing test naming this component is under `tests/guards/` and scans
 * source text. Sixteen of them match `FarmTaskDetailClient` and not one mounts
 * it, so a gate could be written, deleted, or inverted without any of them
 * moving. CLAUDE.md's own rule: a guard is right for "this pattern is present",
 * and a behavioural guarantee needs an executing test.
 *
 * ## The four cases, and why the fourth is the interesting one
 *
 * Creator-with-write sees it; a writer who is not the creator does not; an
 * admin sees it regardless of authorship. The fourth is an ABSENT
 * `createdByUserId`, which must PERMIT: the column is NOT NULL and
 * `WorkItemRepository.getById` uses `include`, so every live response carries
 * it — but this page reads through the persistent SWR cache, and treating a
 * missing field as "not yours" would hide the control from the one person
 * entitled to it. A stale permit costs one server refusal; a stale denial
 * costs a farmer their own task.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        refresh: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

let mockPermissions: Record<string, boolean> = {};
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ permissions: mockPermissions, role: 'EDITOR' }),
}));

let mockTask: Record<string, unknown> | null = null;
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        if (key && key.startsWith('/tasks/')) {
            return { data: mockTask, error: undefined, isLoading: false, mutate: jest.fn() };
        }
        return { data: undefined, error: undefined, isLoading: false, mutate: jest.fn() };
    },
}));

jest.mock('@/lib/api-client', () => ({
    apiPost: jest.fn(),
    apiPatch: jest.fn(),
    apiDelete: jest.fn(),
    apiGet: jest.fn(),
    isOfflineError: () => false,
}));

// The field-operation map and the evidence sub-surfaces have their own suites;
// stubbed so this one stays about the gate rather than about MapLibre.
jest.mock('@/components/ui/map/FieldOperationPanel', () => ({
    FieldOperationPanel: () => <div data-testid="field-operation-panel" />,
}));
jest.mock('@/components/EvidenceSubTable', () => ({
    EvidenceSubTable: () => <div data-testid="evidence-sub-table" />,
}));
jest.mock('@/components/EvidenceAddForm', () => ({
    EvidenceAddForm: () => <div data-testid="evidence-add-form" />,
}));
// `UserCombobox` reaches for a react-query QueryClient, which this suite does
// not provide and does not need — it has its own tests. Worth noting that
// WITHOUT this stub the only passing case was the `canWrite: false` one, which
// skips the region that mounts it: a suite can look partly green for a reason
// that has nothing to do with its subject.
jest.mock('@/components/ui/user-combobox', () => ({
    UserCombobox: () => <div data-testid="user-combobox" />,
}));

import { FarmTaskDetailClient } from '@/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient';

const CREATOR = 'user-creator';
const SOMEONE_ELSE = 'user-else';

function task(over: Record<string, unknown> = {}) {
    return {
        id: 'task-1',
        key: 'FT-1',
        title: 'Пръскане на блок А',
        type: 'FIELD_OPERATION',
        status: 'OPEN',
        severity: 'MEDIUM',
        description: null,
        resolution: null,
        assigneeUserId: null,
        reviewerUserId: null,
        createdByUserId: CREATOR,
        createdAt: '2026-03-04T08:00:00.000Z',
        updatedAt: '2026-03-04T08:00:00.000Z',
        links: [],
        comments: [],
        ...over,
    };
}

function mount(opts: {
    permissions: Record<string, boolean>;
    currentUserId: string | null;
    task: Record<string, unknown> | null;
}) {
    mockPermissions = opts.permissions;
    mockTask = opts.task;
    return render(
        <FarmTaskDetailClient tenantSlug="acme" taskId="task-1" currentUserId={opts.currentUserId} />,
    );
}

const editButton = () => screen.queryByTestId('task-edit-button');

describe('the farm-task edit control is offered on the server\'s rule (#2169)', () => {
    afterEach(() => {
        mockPermissions = {};
        mockTask = null;
    });

    it('OFFERS edit to the creator who can write', () => {
        mount({
            permissions: { canRead: true, canWrite: true, canAdmin: false },
            currentUserId: CREATOR,
            task: task(),
        });
        expect(editButton()).not.toBeNull();
    });

    it('WITHHOLDS edit from a writer who did not create the task', () => {
        // The case the server now refuses. Before this gate the button rendered
        // here and answered 403 after the farmer had filled the form in.
        mount({
            permissions: { canRead: true, canWrite: true, canAdmin: false },
            currentUserId: SOMEONE_ELSE,
            task: task(),
        });
        expect(editButton()).toBeNull();
    });

    it('OFFERS edit to an admin who did not create the task', () => {
        // The release valve. Without it a farm whose only admin is away cannot
        // correct anybody's task, which is the cost the owner accepted on #2169.
        mount({
            permissions: { canRead: true, canWrite: true, canAdmin: true },
            currentUserId: SOMEONE_ELSE,
            task: task(),
        });
        expect(editButton()).not.toBeNull();
    });

    it('OFFERS edit when createdByUserId is ABSENT, rather than hiding it', () => {
        // A cached response from before the field was read here. Permitting and
        // letting the server refuse costs one 403; denying would hide the
        // control from the creator, which is the failure that matters.
        mount({
            permissions: { canRead: true, canWrite: true, canAdmin: false },
            currentUserId: CREATOR,
            task: task({ createdByUserId: undefined }),
        });
        expect(editButton()).not.toBeNull();
    });

    it('WITHHOLDS edit from a role that cannot write at all, creator or not', () => {
        // `canWrite` stays the FIRST gate — this narrows it and never widens it,
        // so being the creator does not grant a READER the control.
        mount({
            permissions: { canRead: true, canWrite: false, canAdmin: false },
            currentUserId: CREATOR,
            task: task(),
        });
        expect(editButton()).toBeNull();
    });
});

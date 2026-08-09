/**
 * Regression tests for Epic 56's entity-metadata copy rollout.
 *
 * The primitive itself (`CopyText` / `useCopyToClipboard`) is exhaustively
 * tested in copy-primitives.test.tsx and use-copy-to-clipboard.test.tsx.
 * These tests verify the *integration shape* — that identifier headers
 * on detail pages expose their technical value via the shared primitive
 * without crowding the surrounding badge row.
 *
 * We mount small harnesses that mirror the JSX shape in the real pages
 * (task detail header, practice detail header, asset external-ref field).
 * This keeps the test decoupled from the heavyweight react-query + data-
 * fetching plumbing in those pages while pinning the layout contract.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

const toastMock = { success: jest.fn(), error: jest.fn() };
jest.mock('sonner', () => ({
    toast: toastMock,
    Toaster: () => null,
}));

import { CopyText } from '@/components/ui/copy-text';
import { TooltipProvider } from '@/components/ui/tooltip';

function Providers({ children }: { children: React.ReactNode }) {
    return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>;
}

function setupUserWithClipboard(writeText: jest.Mock) {
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
    });
    return user;
}

beforeEach(() => {
    toastMock.success.mockClear();
    toastMock.error.mockClear();
});

// ── Task detail header shape ────────────────────────────────────

function TaskDetailHeaderHarness({ taskKey }: { taskKey: string }) {
    return (
        <Providers>
            <div className="flex gap-tight mt-1 flex-wrap items-center">
                {taskKey && (
                    <CopyText
                        value={taskKey}
                        label={`Copy task key ${taskKey}`}
                        successMessage="Task key copied"
                        className="text-xs text-slate-500"
                    >
                        {taskKey}
                    </CopyText>
                )}
                <span data-testid="status-badge" className="badge">
                    OPEN
                </span>
                <span data-testid="severity-badge" className="badge">
                    HIGH
                </span>
                <span data-testid="overdue-badge" className="badge">
                    Overdue
                </span>
            </div>
        </Providers>
    );
}

describe('Task detail header — task.key copy affordance', () => {
    it('renders the task key as a CopyText button alongside the badge row', () => {
        render(<TaskDetailHeaderHarness taskKey="TASK-42" />);
        const trigger = screen.getByRole('button', {
            name: 'Copy task key TASK-42',
        });
        expect(trigger).toBeInTheDocument();
        expect(trigger).toHaveTextContent('TASK-42');
        // Badges still render — the CopyText hasn't pushed them out.
        expect(screen.getByTestId('status-badge')).toBeInTheDocument();
        expect(screen.getByTestId('severity-badge')).toBeInTheDocument();
        expect(screen.getByTestId('overdue-badge')).toBeInTheDocument();
    });

    it('copies the exact key value on click', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = setupUserWithClipboard(writeText);

        render(<TaskDetailHeaderHarness taskKey="TASK-42" />);

        await user.click(
            screen.getByRole('button', { name: 'Copy task key TASK-42' }),
        );

        expect(writeText).toHaveBeenCalledWith('TASK-42');
        expect(toastMock.success).toHaveBeenCalledWith('Task key copied');
    });
});

// ── Practice detail header shape ─────────────────────────────────

function PracticeDetailHeaderHarness({ code }: { code: string }) {
    return (
        <Providers>
            <div className="flex gap-tight mt-1 flex-wrap items-center">
                <CopyText
                    value={code}
                    label={`Copy practice code ${code}`}
                    successMessage="Practice code copied"
                    className="text-xs text-slate-500"
                >
                    {code}
                </CopyText>
                <span data-testid="status-badge" className="badge">
                    IMPLEMENTED
                </span>
                <span data-testid="applicability-badge" className="badge">
                    Applicable
                </span>
            </div>
        </Providers>
    );
}

describe('Practice detail header — practice.code copy affordance', () => {
    it('copies the framework-style code exactly as shown', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = setupUserWithClipboard(writeText);

        render(<PracticeDetailHeaderHarness code="ISO.A.5.1" />);

        const trigger = screen.getByRole('button', {
            name: 'Copy practice code ISO.A.5.1',
        });
        expect(trigger).toHaveTextContent('ISO.A.5.1');

        await user.click(trigger);
        expect(writeText).toHaveBeenCalledWith('ISO.A.5.1');
        expect(toastMock.success).toHaveBeenCalledWith('Practice code copied');
    });

    it('keeps status + applicability chips visible alongside the code', () => {
        render(<PracticeDetailHeaderHarness code="C-001" />);
        expect(screen.getByTestId('status-badge')).toBeInTheDocument();
        expect(screen.getByTestId('applicability-badge')).toBeInTheDocument();
    });
});

// ── Framework-mapping row shape ──────────────────────────────────

function MappingRowHarness({ code, title }: { code: string; title: string }) {
    return (
        <Providers>
            <table>
                <tbody>
                    <tr data-testid="mapping-row">
                        <td>ISO 27001:2022</td>
                        <td className="text-sm text-slate-300">
                            <CopyText
                                value={code}
                                label={`Copy requirement code ${code}`}
                                successMessage="Requirement code copied"
                                className="mr-2 text-slate-500"
                            >
                                {code}
                            </CopyText>
                            {title}
                        </td>
                    </tr>
                </tbody>
            </table>
        </Providers>
    );
}

describe('Practice mappings table — requirement code copy affordance', () => {
    it('renders the requirement code as copyable inside the row cell', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = setupUserWithClipboard(writeText);

        render(
            <MappingRowHarness
                code="A.5.1"
                title="Policies for information security"
            />,
        );

        const row = screen.getByTestId('mapping-row');
        expect(row).toHaveTextContent('Policies for information security');

        const trigger = within(row).getByRole('button', {
            name: 'Copy requirement code A.5.1',
        });
        await user.click(trigger);

        expect(writeText).toHaveBeenCalledWith('A.5.1');
    });
});

// ── Asset external-ref field shape ──────────────────────────────

function AssetExternalRefHarness({ externalRef }: { externalRef: string | null }) {
    return (
        <Providers>
            <div>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    External Ref
                </h3>
                {externalRef ? (
                    <CopyText
                        value={externalRef}
                        label={`Copy external reference ${externalRef}`}
                        successMessage="External reference copied"
                        className="text-sm text-content-default"
                    >
                        {externalRef}
                    </CopyText>
                ) : (
                    <p className="text-sm">—</p>
                )}
            </div>
        </Providers>
    );
}

describe('Asset external ref — CopyText integration', () => {
    it('renders copy affordance when the value is present', () => {
        render(<AssetExternalRefHarness externalRef="ASSET-DB-001" />);
        expect(
            screen.getByRole('button', {
                name: 'Copy external reference ASSET-DB-001',
            }),
        ).toBeInTheDocument();
    });

    it('falls back to a plain em-dash when the value is empty', () => {
        render(<AssetExternalRefHarness externalRef={null} />);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.getByText('—')).toBeInTheDocument();
    });
});

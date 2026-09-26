/**
 * @jest-environment jsdom
 *
 * StepWizard's contract, written when the primitive got its FIRST real
 * consumer (the insurance calculator, #1120).
 *
 * The primitive shipped with no consumers, so five gaps had never been
 * exercised by anything. Each one gets a test here, and each test is written to
 * fail if that fix is reverted:
 *
 *   1. a rejecting `onFinish` kept the wizard open but surfaced an UNHANDLED
 *      rejection, because `finish()` was try/finally with no catch and
 *      `onSubmit` called `void finish()`;
 *   2. the drawer could be swiped or Escaped away mid-send;
 *   3. focus stayed on the pressed button instead of following the step;
 *   4. there was no error slot, so a caller had nowhere to say why a send
 *      failed;
 *   5. two submits dispatched in one tick both reached `onFinish`, because the
 *      guard read `busy` — React STATE — which had not re-rendered yet.
 *
 * useMediaQuery is forced to desktop so Modal renders the Radix Dialog; Vaul's
 * drag handlers throw in jsdom.
 */
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return { ...actual, useMediaQuery: () => ({ device: 'desktop', width: 1024, height: 768, isMobile: false, isDesktop: true }) };
});

afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
});

import { StepWizard, type StepWizardStep } from '@/components/ui/step-wizard';

const STEPS: StepWizardStep[] = [
    { id: 'one', title: 'Step one', content: <div>first</div> },
    { id: 'two', title: 'Step two', content: <input aria-label="value" /> },
];

function Harness({
    onFinish,
    error,
    canAdvanceFirst = true,
}: {
    onFinish: () => Promise<{ queued?: boolean } | void>;
    error?: string;
    canAdvanceFirst?: boolean;
}) {
    const [open, setOpen] = useState(true);
    const steps = STEPS.map((s, i) => (i === 0 ? { ...s, canAdvance: canAdvanceFirst } : s));
    return (
        <StepWizard
            open={open}
            onOpenChange={setOpen}
            title="Wizard"
            steps={steps}
            onFinish={onFinish}
            finishLabel="Send"
            error={error}
        />
    );
}

const next = () => screen.getByTestId('wizard-next');
const finish = () => screen.getByTestId('wizard-finish');

describe('StepWizard — walking the steps', () => {
    it('advances with Next and returns with Back', async () => {
        render(<Harness onFinish={jest.fn().mockResolvedValue(undefined)} />);
        expect(screen.getByText('Step one')).toBeInTheDocument();

        await userEvent.click(next());
        expect(await screen.findByText('Step two')).toBeInTheDocument();

        await userEvent.click(screen.getByTestId('wizard-back'));
        expect(await screen.findByText('Step one')).toBeInTheDocument();
    });

    it('gates Next on canAdvance', () => {
        render(<Harness onFinish={jest.fn()} canAdvanceFirst={false} />);
        expect(next()).toBeDisabled();
    });

    it('advances on Enter in a field, not just the button', async () => {
        render(<Harness onFinish={jest.fn().mockResolvedValue(undefined)} />);
        // Submitting the wizard's own form is what Enter does on a phone
        // keyboard; the wizard owns the <form>, so this is the real path.
        fireEvent.submit(next().closest('form')!);
        expect(await screen.findByText('Step two')).toBeInTheDocument();
    });

    it('moves focus to the new step heading, so a screen reader follows', async () => {
        render(<Harness onFinish={jest.fn()} />);
        await userEvent.click(next());

        await waitFor(() => {
            // Focus lands on the title NODE, which sits inside Modal.Header's
            // own h2 — that is what gets announced.
            expect(document.activeElement?.textContent).toBe('Step two');
        });
    });
});

describe('StepWizard — finishing', () => {
    it('closes when onFinish resolves', async () => {
        const onFinish = jest.fn().mockResolvedValue(undefined);
        render(<Harness onFinish={onFinish} />);
        await userEvent.click(next());
        await userEvent.click(finish());

        await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByText('Step two')).not.toBeInTheDocument());
    });

    it('stays open with busy cleared when onFinish REJECTS, and raises no unhandled rejection', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        try {
            const onFinish = jest.fn().mockRejectedValue(new Error('send failed'));
            render(<Harness onFinish={onFinish} error="send failed" />);
            await userEvent.click(next());
            await userEvent.click(finish());

            await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
            // Still on the last step, with the caller's reason shown…
            expect(screen.getByText('Step two')).toBeInTheDocument();
            expect(screen.getByTestId('wizard-error')).toHaveTextContent('send failed');
            // …and the button usable again, or the farmer cannot retry.
            await waitFor(() => expect(finish()).toBeEnabled());

            // Let any stray rejection reach the process before asserting.
            await act(async () => {
                await new Promise((r) => setTimeout(r, 0));
            });
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('calls onFinish exactly once when two submits land in the same tick', async () => {
        let release: (() => void) | undefined;
        const onFinish = jest.fn(
            () => new Promise<void>((resolve) => { release = resolve; }),
        );
        render(<Harness onFinish={onFinish} />);
        await userEvent.click(next());

        const form = finish().closest('form')!;
        // Two submits with NO await between them: `busy` state has not
        // re-rendered, so only a ref-based guard can hold here.
        await act(async () => {
            fireEvent.submit(form);
            fireEvent.submit(form);
        });
        expect(onFinish).toHaveBeenCalledTimes(1);

        await act(async () => {
            release?.();
        });
    });

    it('refuses to close while the send is in flight', async () => {
        let release: (() => void) | undefined;
        const onFinish = jest.fn(
            () => new Promise<void>((resolve) => { release = resolve; }),
        );
        render(<Harness onFinish={onFinish} />);
        await userEvent.click(next());
        await act(async () => {
            fireEvent.submit(finish().closest('form')!);
        });

        // Escape is the cheap stand-in for the phone swipe: both arrive through
        // Modal's dismiss path, which `preventDefaultClose={busy}` blocks.
        fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
        expect(screen.getByText('Step two')).toBeInTheDocument();

        await act(async () => {
            release?.();
        });
    });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AsyncState } from '@/components/ui/async-state';

/**
 * The branch that produced the worst instance of #862 is the one a
 * hand-written ternary always forgets: **not loading, no error, no data**.
 *
 * That is what SWR leaves behind after it exhausts its retries offline, and
 * `{!data ? <Skeleton/> : <content/>}` renders `content` for it — which in My
 * work meant an operator with queued jobs was shown "no records".
 */

jest.mock('next-intl', () => ({
    useTranslations: () => (k: string) => k,
}));

function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

afterEach(() => setOnline(true));

describe('AsyncState', () => {
    it('renders children when data is present', () => {
        render(
            <AsyncState data={{ n: 1 }} skeleton={<p>skeleton</p>}>
                {(d) => <p>value {d.n}</p>}
            </AsyncState>,
        );
        expect(screen.getByText('value 1')).toBeInTheDocument();
    });

    it('renders the skeleton while a first load is genuinely in flight', () => {
        render(
            <AsyncState data={undefined} isLoading skeleton={<p>skeleton</p>}>
                {() => <p>never</p>}
            </AsyncState>,
        );
        expect(screen.getByText('skeleton')).toBeInTheDocument();
    });

    it('shows a failure — not a skeleton — once an error is present', () => {
        // isLoading stays true across SWR's retry window, so checking it first
        // would hide the failure behind a skeleton for as long as it retries.
        render(
            <AsyncState data={undefined} error={new Error('boom')} isLoading skeleton={<p>skeleton</p>}>
                {() => <p>never</p>}
            </AsyncState>,
        );
        expect(screen.queryByText('skeleton')).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('THE ONE THAT MATTERED: not loading, no error, no data is a FAILURE', () => {
        // SWR after it gives up. A ternary renders `content` here — which is
        // how "no records" reached an operator who had work queued.
        render(
            <AsyncState data={undefined} isLoading={false} skeleton={<p>skeleton</p>}>
                {() => <p>EMPTY STATE — THE LIE</p>}
            </AsyncState>,
        );
        expect(screen.queryByText('EMPTY STATE — THE LIE')).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('says "no signal" rather than "something went wrong" when offline', () => {
        setOnline(false);
        render(
            <AsyncState data={undefined} error={new Error('x')} skeleton={<p>s</p>}>
                {() => <p>never</p>}
            </AsyncState>,
        );
        // Different instruction to someone standing in a field.
        expect(screen.getByTestId('async-state-offline')).toBeInTheDocument();
        expect(screen.getByText('needsConnectionTitle')).toBeInTheDocument();
    });

    it('offers a retry that calls back', async () => {
        const onRetry = jest.fn();
        render(
            <AsyncState data={undefined} error={new Error('x')} skeleton={<p>s</p>} onRetry={onRetry}>
                {() => <p>never</p>}
            </AsyncState>,
        );
        await userEvent.click(screen.getByRole('button', { name: 'retry' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});

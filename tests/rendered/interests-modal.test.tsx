/** @jest-environment jsdom */
/**
 * Interests editor modal — chip add/remove + PUT-replace save. The Modal shell
 * (Radix) is stubbed to a simple pass-through so the test focuses on the chip
 * editor + the /me/interests PUT wiring; fetch + useTenantApiUrl are mocked.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

jest.mock('@/components/ui/modal', () => {
    function Modal({ showModal, children }: { showModal: boolean; children: React.ReactNode }) {
        return showModal ? <div data-testid="modal">{children}</div> : null;
    }
    Modal.Header = function Header({ title }: { title: string }) {
        return <h2>{title}</h2>;
    };
    Modal.Body = function Body({ children }: { children: React.ReactNode }) {
        return <div>{children}</div>;
    };
    Modal.Actions = function Actions({ children }: { children: React.ReactNode }) {
        return <div>{children}</div>;
    };
    return { Modal };
});

import { InterestsModal } from '@/components/trends/InterestsModal';

const okFetch = (keywords: string[]) =>
    jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ keywords }) });

beforeEach(() => {
    global.fetch = okFetch([]);
});

describe('InterestsModal', () => {
    it('renders the initial keywords as chips', () => {
        render(<InterestsModal open initial={['wheat', 'subsidy']} onClose={jest.fn()} onSaved={jest.fn()} />);
        expect(screen.getByText('wheat')).toBeInTheDocument();
        expect(screen.getByText('subsidy')).toBeInTheDocument();
    });

    it('adds a keyword on Enter (normalized) and removes one via its ×', () => {
        render(<InterestsModal open initial={['wheat']} onClose={jest.fn()} onSaved={jest.fn()} />);
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: '  Maize ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.getByText('maize')).toBeInTheDocument();

        // Two chips now (wheat, maize) → two remove buttons (same i18n-key name
        // under the mock). Remove the first (wheat); maize remains.
        const removes = screen.getAllByRole('button', { name: 'news.forYou.removeChip' });
        expect(removes).toHaveLength(2);
        fireEvent.click(removes[0]);
        expect(screen.getByText('maize')).toBeInTheDocument();
        expect(screen.queryByText('wheat')).not.toBeInTheDocument();
    });

    it('PUT-replaces on Save and reports the stored set', async () => {
        const onSaved = jest.fn();
        const onClose = jest.fn();
        global.fetch = okFetch(['wheat', 'maize']);
        render(<InterestsModal open initial={['wheat']} onClose={onClose} onSaved={onSaved} />);

        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: 'maize' } });
        fireEvent.click(screen.getByRole('button', { name: 'news.forYou.add' }));

        fireEvent.click(screen.getByRole('button', { name: 'news.forYou.save' }));

        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe('/api/t/acme/me/interests');
        expect(opts.method).toBe('PUT');
        expect(JSON.parse(opts.body)).toEqual({ keywords: ['wheat', 'maize'] });
        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(['wheat', 'maize']));
        expect(onClose).toHaveBeenCalled();
    });

    it('Cancel closes without a network call', () => {
        const onClose = jest.fn();
        render(<InterestsModal open initial={['wheat']} onClose={onClose} onSaved={jest.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'news.forYou.cancel' }));
        expect(onClose).toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('InterestsModal — a failed save must not look like a successful one', () => {
    it('keeps the modal OPEN and reports the failure on a non-ok response', async () => {
        // `onClose()` used to sit outside the `if (res.ok)` with no catch, so
        // a rejected save closed the modal exactly like a success and the
        // user's edits vanished with no signal at all. On a rural connection
        // that is the common case.
        const onClose = jest.fn();
        const onSaved = jest.fn();
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });

        render(<InterestsModal open initial={['wheat']} onClose={onClose} onSaved={onSaved} />);
        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

        expect(onClose).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
        // The draft survives, so retrying costs a click rather than retyping.
        expect(screen.getByText('wheat')).toBeInTheDocument();
    });

    it('keeps the modal open when the network throws outright', async () => {
        const onClose = jest.fn();
        global.fetch = jest.fn().mockRejectedValue(new Error('offline'));

        render(<InterestsModal open initial={['wheat']} onClose={onClose} onSaved={jest.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /save/i }));

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(onClose).not.toHaveBeenCalled();
    });
});

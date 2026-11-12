/**
 * #2989 — the composer's display-name prompt.
 *
 * The prompt is the ENTRY POINT, and the entry point is the part of this
 * feature that would otherwise have been left out: production held zero
 * `PersonProfile` rows because nothing ever wrote one, so without a way in
 * every channel post shows the farm alone for ever. `pages-are-reachable`
 * governs screens and this is not a screen, so no guard would notice.
 *
 * Which makes "it renders when there is no name, and NOT when there is" the
 * assertion worth having: a prompt that never appears is the defect, and a
 * prompt that always appears is furniture people learn to dismiss.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

jest.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        (t as unknown as { rich: (k: string) => string }).rich = (key: string) => key;
        return t;
    },
    useLocale: () => 'en',
}));

const apiGet = jest.fn();
const apiPut = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiPut: (...a: unknown[]) => apiPut(...a),
    apiPost: jest.fn(),
    apiDelete: jest.fn(),
    apiPatch: jest.fn(),
}));

// eslint-disable-next-line import/first
import { DisplayNamePrompt } from '@/app/t/[tenantSlug]/(app)/channels/[channelId]/DisplayNamePrompt';

const USER = 'u-1';

beforeEach(() => {
    apiGet.mockReset();
    apiPut.mockReset();
    window.localStorage.clear();
});

describe('#2989 — the display-name prompt', () => {
    it('asks when there is no published name', async () => {
        apiGet.mockResolvedValue({ displayName: null, published: false });
        render(<DisplayNamePrompt userId={USER} />);

        await waitFor(() => expect(screen.getByText('displayNameTitle')).toBeInTheDocument());
        // The hint is the consent: it is where the person learns the name goes
        // to other farms, which is what makes typing it the opt-in.
        expect(screen.getByText('displayNameHint')).toBeInTheDocument();
        expect(apiGet).toHaveBeenCalledWith('/api/social/profile');
    });

    it('stays silent when a name already exists', async () => {
        apiGet.mockResolvedValue({ displayName: 'Иван Петров', published: true });
        render(<DisplayNamePrompt userId={USER} />);

        await waitFor(() => expect(apiGet).toHaveBeenCalled());
        expect(screen.queryByText('displayNameTitle')).not.toBeInTheDocument();
    });

    it('a FAILED read asks nothing', async () => {
        // Asking somebody to re-enter a name they may already have is worse
        // than not asking, and the farm-alone line is a designed state.
        apiGet.mockRejectedValue(new Error('nope'));
        render(<DisplayNamePrompt userId={USER} />);

        await waitFor(() => expect(apiGet).toHaveBeenCalled());
        expect(screen.queryByText('displayNameTitle')).not.toBeInTheDocument();
    });

    it('«Запази» PUTs the name and then stops asking', async () => {
        apiGet.mockResolvedValue({ displayName: null, published: false });
        apiPut.mockResolvedValue({ displayName: 'Иван Петров', published: true });
        const onSaved = jest.fn();
        render(<DisplayNamePrompt userId={USER} onSaved={onSaved} />);

        await waitFor(() => expect(screen.getByText('displayNameTitle')).toBeInTheDocument());
        await userEvent.type(screen.getByRole('textbox'), 'Иван Петров');
        await userEvent.click(screen.getByRole('button', { name: 'displayNameSave' }));

        await waitFor(() =>
            expect(apiPut).toHaveBeenCalledWith('/api/social/profile', {
                displayName: 'Иван Петров',
            }),
        );
        expect(onSaved).toHaveBeenCalled();
        await waitFor(() =>
            expect(screen.queryByText('displayNameTitle')).not.toBeInTheDocument(),
        );
    });

    it('«Запази» is disabled until something is typed, and trims', async () => {
        apiGet.mockResolvedValue({ displayName: null, published: false });
        render(<DisplayNamePrompt userId={USER} />);
        await waitFor(() => expect(screen.getByText('displayNameTitle')).toBeInTheDocument());

        const save = screen.getByRole('button', { name: 'displayNameSave' });
        expect(save).toBeDisabled();
        await userEvent.type(screen.getByRole('textbox'), '   ');
        // Whitespace is not a name: enabling here would PUT a blank, which the
        // server reads as "clear it" — the opposite of what the person meant.
        expect(save).toBeDisabled();
    });

    it('a FAILED save keeps the text and shows the error', async () => {
        apiGet.mockResolvedValue({ displayName: null, published: false });
        apiPut.mockRejectedValue(new Error('nope'));
        render(<DisplayNamePrompt userId={USER} />);
        await waitFor(() => expect(screen.getByText('displayNameTitle')).toBeInTheDocument());

        await userEvent.type(screen.getByRole('textbox'), 'Иван');
        await userEvent.click(screen.getByRole('button', { name: 'displayNameSave' }));

        await waitFor(() => expect(screen.getByText('displayNameError')).toBeInTheDocument());
        // The words survive. A prompt that clears on failure asks the person
        // to type their own name twice.
        expect(screen.getByRole('textbox')).toHaveValue('Иван');
    });

    it('«Не сега» hides it and is REMEMBERED per user', async () => {
        apiGet.mockResolvedValue({ displayName: null, published: false });
        const first = render(<DisplayNamePrompt userId={USER} />);
        await waitFor(() => expect(screen.getByText('displayNameTitle')).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: 'displayNameSkip' }));
        await waitFor(() =>
            expect(screen.queryByText('displayNameTitle')).not.toBeInTheDocument(),
        );
        first.unmount();

        // Remounting is the real test: a prompt that reappears every visit is
        // one people learn to dismiss without reading.
        render(<DisplayNamePrompt userId={USER} />);
        await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
        expect(screen.queryByText('displayNameTitle')).not.toBeInTheDocument();
    });

    it('a DIFFERENT user on the same browser is still asked', async () => {
        // A shared device must not hide the prompt from the next person.
        apiGet.mockResolvedValue({ displayName: null, published: false });
        const first = render(<DisplayNamePrompt userId={USER} />);
        await waitFor(() => expect(screen.getByText('displayNameTitle')).toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: 'displayNameSkip' }));
        first.unmount();

        render(<DisplayNamePrompt userId="u-2" />);
        await waitFor(() => expect(screen.getByText('displayNameTitle')).toBeInTheDocument());
    });
});

/**
 * #2941 — the channel-digest switch, which IS the feature's entry point.
 *
 * `User.channelDigestOptIn` defaults to false, so without this control nobody
 * could ever turn the digest on and the job would run every 15 minutes over an
 * empty population for ever — green, silent, and indistinguishable from
 * working. `pages-are-reachable` governs screens and this is not a screen, so
 * no guard would notice. Same shape as #2989's display-name prompt.
 *
 * ## The assertion worth having is the REVERT
 *
 * The switch is optimistic, because waiting for a round-trip on rural LTE
 * feels broken. That makes "it flips BACK when the write fails" the load-
 * bearing half: a switch that stays flipped after a failed write tells the
 * person they are opted in while the column says otherwise, and they then
 * never receive a digest and have no reason to suspect why. It is the same
 * silent-success failure the route's required key exists to prevent,
 * reproduced on the client — and nothing about the DOM would show it.
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
    useLocale: () => 'bg',
}));

const apiPut = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: jest.fn(),
    apiPut: (...a: unknown[]) => apiPut(...a),
    apiPost: jest.fn(),
    apiDelete: jest.fn(),
    apiPatch: jest.fn(),
}));

const toastError = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...(jest.requireActual('@/components/ui/hooks') as object),
    useToast: () => ({
        error: (...a: unknown[]) => toastError(...a),
        success: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
    }),
}));

import { ChannelDigestCard } from '@/app/account/profile/ChannelDigestCard';

beforeEach(() => {
    apiPut.mockReset();
    toastError.mockReset();
});

/** The switch, by its accessible name — never by a test id. */
function sw(): HTMLElement {
    return screen.getByRole('switch');
}

describe('#2941 — the channel-digest switch', () => {
    it('renders the stored state rather than a default', () => {
        // Passed IN, because the route has no GET: the value rides
        // `/api/auth/me`, which the app already fetches at launch. A card
        // that always painted "off" would be the same defect as the silent
        // opt-in — it would invite a second click that turns it OFF.
        render(<ChannelDigestCard initialOptIn={true} />);
        expect(sw()).toBeChecked();
    });

    it('flips on and writes the opt-in', async () => {
        apiPut.mockResolvedValue({ optIn: true });
        render(<ChannelDigestCard initialOptIn={false} />);

        await userEvent.click(sw());

        await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
        expect(apiPut).toHaveBeenCalledWith(
            '/api/account/channel-digest',
            { optIn: true },
        );
        expect(sw()).toBeChecked();
    });

    it('flips off and writes the opt-OUT, rather than omitting the key', async () => {
        apiPut.mockResolvedValue({ optIn: false });
        render(<ChannelDigestCard initialOptIn={true} />);

        await userEvent.click(sw());

        // `{ optIn: false }` and not `{}`. The route REQUIRES the key, so a
        // body that omitted it on the off path would 400 — and the switch
        // would then revert, making opting out look broken while opting in
        // worked.
        await waitFor(() => expect(apiPut).toHaveBeenCalledWith(
            '/api/account/channel-digest',
            { optIn: false },
        ));
        expect(sw()).not.toBeChecked();
    });

    it('REVERTS and tells the person when the write fails', async () => {
        apiPut.mockRejectedValue(new Error('offline'));
        render(<ChannelDigestCard initialOptIn={false} />);

        await userEvent.click(sw());

        // The load-bearing case. Staying checked would report an opt-in the
        // column does not hold.
        await waitFor(() => expect(sw()).not.toBeChecked());
        expect(toastError).toHaveBeenCalledTimes(1);
    });

    it('reverts an opt-OUT too, in the other direction', async () => {
        apiPut.mockRejectedValue(new Error('offline'));
        render(<ChannelDigestCard initialOptIn={true} />);

        await userEvent.click(sw());

        // The control that stops `setOptIn(false)` hard-coded in the catch
        // from satisfying the case above: a revert must restore the PREVIOUS
        // value, not a constant.
        await waitFor(() => expect(sw()).toBeChecked());
        expect(toastError).toHaveBeenCalledTimes(1);
    });
});

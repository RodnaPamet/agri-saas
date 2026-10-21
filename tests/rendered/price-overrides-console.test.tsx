/**
 * «Цени», rendered — the superuser daily price override (#1587, the web half).
 *
 * Why this page is tested at the DOM rather than only at its API: every
 * dangerous outcome here is a shape the server would accept. A stale number
 * re-asserted as today's price, a comma silently dropped, a diesel figure
 * typed against a per-tonne label — the POST succeeds in all three, and the
 * damage is a wrong price on every farm's calculator. So the assertions below
 * are about what the FORM does with what a person typed.
 *
 * `useTranslations` is mocked to return the KEY, which is what makes the
 * two-warnings case assertable: `confirmClearNoFeed` and `confirmClearBody`
 * are distinguishable as keys without pinning any wording.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const t = (key: string) => key;
    t.has = () => true;
    t.rich = (k: string) => k;
    t.markup = (k: string) => k;
    t.raw = (k: string) => k;
    return { useLocale: () => 'bg', useTranslations: () => t };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => swr(...a),
}));

const apiPost = jest.fn();
const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => ({
    // requireActual, so `ApiClientError` stays the REAL class. A stub would
    // make every `instanceof` check in the component false and collapse all
    // four coded refusals into the generic message — with the test still
    // green, which is the trap this repo's partial-barrel-mock note describes.
    ...jest.requireActual('@/lib/api-client'),
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiDelete: (...a: unknown[]) => apiDelete(...a),
}));

const toastSuccess = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({ success: toastSuccess, error: jest.fn(), info: jest.fn() }),
}));

// A calendar popover is not what this suite is about; the day it yields is.
jest.mock('@/components/ui/date-picker', () => ({
    DatePicker: ({ value }: { value: Date | null }) => (
        <div data-testid="day-picker">{value ? value.toISOString() : 'none'}</div>
    ),
}));

/** Renders what it is GIVEN, so "which description" becomes assertable. */
jest.mock('@/components/ui/confirm-dialog', () => ({
    ConfirmDialog: ({
        showModal,
        title,
        description,
        onConfirm,
    }: {
        showModal: boolean;
        title: string;
        description?: React.ReactNode;
        onConfirm: () => void | Promise<unknown>;
    }) =>
        showModal ? (
            <div data-testid="confirm">
                <span>{title}</span>
                <span>{description}</span>
                <button onClick={() => void onConfirm()}>do-confirm</button>
            </div>
        ) : null,
}));

import { ApiClientError } from '@/lib/api-client';
import {
    PriceOverridesClient,
    parseTypedPrice,
} from '@/app/t/[tenantSlug]/(app)/admin/market-prices/PriceOverridesClient';

type Row = {
    commodity: string;
    entryUnit: string;
    entryCurrency: string;
    typed: { value: number; currency: string; unit: string; date: string } | null;
    api: { value: number; currency: string; unit: string; date: string; source: string } | null;
    apiFeed: string;
};

function row(over: Partial<Row> = {}): Row {
    return {
        commodity: 'wheat',
        entryUnit: 'EUR/t',
        entryCurrency: 'EUR',
        typed: null,
        api: null,
        apiFeed: 'ec-agrifood',
        ...over,
    };
}

const mutate = jest.fn();

function mount(rows: Row[], opts: { isLoading?: boolean } = {}) {
    swr.mockReturnValue({
        data: opts.isLoading ? undefined : { commodities: rows },
        error: undefined,
        isLoading: opts.isLoading ?? false,
        mutate,
    });
    return render(<PriceOverridesClient />);
}

beforeEach(() => {
    jest.clearAllMocks();
    apiPost.mockResolvedValue({ written: 1, series: [] });
    apiDelete.mockResolvedValue(undefined);
});

describe('the form does not re-assert yesterday', () => {
    // Break: a form prefilled with the live typed prices can be submitted
    // whole by pressing save, filing ten stale numbers as TODAY's observation
    // — each plausible, each moving every farm's calculator, with an audit row
    // saying a person entered them.
    it('leaves the input EMPTY even when a typed price is already live', () => {
        mount([row({ typed: { value: 190.5, currency: 'EUR', unit: 'EUR/t', date: '2026-10-20' } })]);
        expect(screen.getByRole('textbox')).toHaveValue('');
        // Shown as context, not as a value — the description names the key.
        expect(screen.getByText('liveTyped')).toBeInTheDocument();
    });

    it('sends nothing until something is typed, and the button is disabled', () => {
        mount([row(), row({ commodity: 'barley' })]);
        expect(screen.getByRole('button', { name: 'saveDay' })).toBeDisabled();
        expect(screen.getByText('willSend')).toBeInTheDocument();
    });
});

describe('what reaches the API', () => {
    it('sends only the rows actually filled', async () => {
        const user = userEvent.setup();
        mount([row(), row({ commodity: 'barley' }), row({ commodity: 'maize' })]);

        await user.type(screen.getByRole('textbox', { name: /wheat/ }), '190.5');
        await user.click(screen.getByRole('button', { name: 'saveDay' }));
        await user.click(screen.getByText('do-confirm'));

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        const [, body] = apiPost.mock.calls[0]!;
        expect(body.prices).toEqual([{ commodity: 'wheat', value: 190.5 }]);
    });

    it('sends a calendar DAY, never an instant', async () => {
        const user = userEvent.setup();
        mount([row()]);
        await user.type(screen.getByRole('textbox'), '190');
        await user.click(screen.getByRole('button', { name: 'saveDay' }));
        await user.click(screen.getByText('do-confirm'));

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        const [, body] = apiPost.mock.calls[0]!;
        // The point key is `(seriesId, date)` on a DATE column, so an ISO
        // instant would have its time silently dropped — or be refused.
        expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(String(body.date)).not.toContain('T');
    });

    // Break: a Bulgarian superuser types `1,95`. `Number('1,95')` is NaN, and
    // a native numeric input discards the comma outright, leaving an empty
    // value that reads as "nothing typed".
    it('accepts the Bulgarian decimal comma', async () => {
        const user = userEvent.setup();
        mount([row({ commodity: 'diesel', entryUnit: 'EUR/l' })]);

        await user.type(screen.getByRole('textbox'), '1,95');
        await user.click(screen.getByRole('button', { name: 'saveDay' }));
        await user.click(screen.getByText('do-confirm'));

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        const [, body] = apiPost.mock.calls[0]!;
        expect(body.prices).toEqual([{ commodity: 'diesel', value: 1.95 }]);
    });

    it('refuses to send a value it cannot read, and marks the row', async () => {
        const user = userEvent.setup();
        mount([row()]);
        await user.type(screen.getByRole('textbox'), 'около 190');
        expect(screen.getByRole('button', { name: 'saveDay' })).toBeDisabled();
        expect(screen.getByText('notANumber')).toBeInTheDocument();
        expect(apiPost).not.toHaveBeenCalled();
    });

    it('clears the draft and refetches after a successful day', async () => {
        const user = userEvent.setup();
        mount([row()]);
        await user.type(screen.getByRole('textbox'), '190');
        await user.click(screen.getByRole('button', { name: 'saveDay' }));
        await user.click(screen.getByText('do-confirm'));

        await waitFor(() => expect(mutate).toHaveBeenCalled());
        expect(toastSuccess).toHaveBeenCalledWith('savedToast');
        expect(screen.getByRole('textbox')).toHaveValue('');
    });
});

describe('parseTypedPrice is strict where a feed parser is lenient', () => {
    // This table is why the component does NOT reuse `parseEuroPrice`. That
    // one strips every non-digit by design, because it reads `"€178,00"` off a
    // feed — so it turns a typo into a plausible number. Written as a table
    // rather than driven through the DOM because the dangerous rows are the
    // ones a person would never think to try.
    it.each([
        ['190', 190],
        ['190,5', 190.5],
        ['190.50', 190.5],
        ['1 950', 1950],
        ['0', 0],
        ['0,01', 0.01],
    ])('reads %s', (raw, expected) => {
        expect(parseTypedPrice(raw as string)).toBe(expected);
    });

    it.each([
        ['19o'],
        ['около 190'],
        ['190 лв'],
        [''],
        ['-5'],
        ['190,555'],
        // Both of these are refused rather than guessed: a person typing a
        // grain price almost certainly meant 1950, and reading 1.95 would be
        // wrong by a factor of a thousand with nothing to show it.
        ['1.950'],
        ['1,950'],
    ])('refuses %s', (raw) => {
        expect(parseTypedPrice(raw as string)).toBeNull();
    });
});

describe('the unit comes from the server', () => {
    // Break: nine commodities are EUR/t and diesel alone is EUR/l. A
    // client-side copy of that table which drifted would not error — it would
    // label a per-litre field per-tonne, and the number typed against it is
    // wrong by a factor of a thousand.
    it('labels each row with the response entryUnit', () => {
        mount([row(), row({ commodity: 'diesel', entryUnit: 'EUR/l' })]);
        expect(screen.getByText(/diesel · EUR\/l/)).toBeInTheDocument();
        expect(screen.getByText(/wheat · EUR\/t/)).toBeInTheDocument();
    });
});

describe('clearing says what clearing means', () => {
    it('warns differently for a commodity with NO feed at all', async () => {
        const user = userEvent.setup();
        mount([
            row({
                commodity: 'map',
                apiFeed: 'none',
                typed: { value: 700, currency: 'EUR', unit: 'EUR/t', date: '2026-10-20' },
            }),
        ]);
        await user.click(screen.getByRole('button', { name: 'clearAction' }));
        // Three of the ten commodities have no feed anywhere, so clearing
        // leaves the calculator with nothing — which looks like data loss
        // unless it is said beforehand. The spec asks for this distinction.
        expect(screen.getByText('confirmClearNoFeed')).toBeInTheDocument();
        expect(screen.queryByText('confirmClearBody')).not.toBeInTheDocument();
    });

    it('warns about handing authority back when a feed exists', async () => {
        const user = userEvent.setup();
        mount([
            row({
                typed: { value: 190, currency: 'EUR', unit: 'EUR/t', date: '2026-10-20' },
            }),
        ]);
        await user.click(screen.getByRole('button', { name: 'clearAction' }));
        expect(screen.getByText('confirmClearBody')).toBeInTheDocument();
        expect(screen.queryByText('confirmClearNoFeed')).not.toBeInTheDocument();
    });

    it('offers no clear for a commodity with no typed price', () => {
        mount([row({ typed: null })]);
        expect(screen.getByRole('button', { name: 'clearAction' })).toBeDisabled();
    });

    it('calls the per-commodity endpoint', async () => {
        const user = userEvent.setup();
        mount([
            row({
                commodity: 'ammonium-nitrate',
                typed: { value: 400, currency: 'EUR', unit: 'EUR/t', date: '2026-10-20' },
            }),
        ]);
        await user.click(screen.getByRole('button', { name: 'clearAction' }));
        await user.click(screen.getByText('do-confirm'));
        await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(1));
        expect(apiDelete.mock.calls[0]![0]).toBe(
            '/api/t/acme/admin/market-prices/overrides/ammonium-nitrate',
        );
    });
});

describe('coded refusals get their own copy', () => {
    // Break: the API documents four codes precisely so a client can say which
    // thing to fix. Collapsing them into one message makes a typo and a
    // denomination clash look identical, and they need different actions.
    it.each([
        ['DUPLICATE_COMMODITY', 'errDuplicate'],
        ['UNKNOWN_COMMODITY', 'errUnknown'],
        ['COMMODITY_NOT_OVERRIDABLE', 'errNotOverridable'],
        ['OVERRIDE_DENOMINATION_CHANGED', 'errDenomination'],
    ])('%s renders %s', async (code, key) => {
        const user = userEvent.setup();
        apiPost.mockRejectedValue(
            new ApiClientError('server copy', code, 400, {
                commodity: 'wheat',
                stored: 'EUR EUR/t',
                expected: 'EUR EUR/l',
            }),
        );
        mount([row()]);
        await user.type(screen.getByRole('textbox'), '190');
        await user.click(screen.getByRole('button', { name: 'saveDay' }));
        await user.click(screen.getByText('do-confirm'));

        await waitFor(() => expect(screen.getByText(key)).toBeInTheDocument());
    });

    it('falls back to the server message for a code it does not know', async () => {
        const user = userEvent.setup();
        apiPost.mockRejectedValue(new ApiClientError('Rate limited, try shortly.', 'RATE_LIMITED', 429));
        mount([row()]);
        await user.type(screen.getByRole('textbox'), '190');
        await user.click(screen.getByRole('button', { name: 'saveDay' }));
        await user.click(screen.getByText('do-confirm'));

        await waitFor(() =>
            expect(screen.getByText('Rate limited, try shortly.')).toBeInTheDocument(),
        );
    });
});

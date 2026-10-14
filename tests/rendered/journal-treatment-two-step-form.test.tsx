/**
 * «Нов запис» is a two-step TREATMENT record, and the request it sends carries
 * an `Idempotency-Key` (#1740).
 *
 * ## Why the header is the load-bearing assertion
 *
 * `apiPost(url, body, schema?, init?)` takes a Zod schema THIRD and the
 * `RequestInit` fourth. The first version of this form passed
 * `{ headers: { 'Idempotency-Key': … } }` third, so the header was never
 * sent. On this route the key IS the treatment handle
 * (`idempotencyKey?.trim() || randomUUID()`), so without one the server mints
 * a fresh UUID per attempt: a retry after a lost answer writes a SECOND
 * treatment into a regulated register, and the farm record then shows the
 * same spray twice over the same parcels.
 *
 * ## The typecheck is NOT what this test stands in for
 *
 * `tsc` rejects that mistake — `TS2353: 'headers' does not exist in type
 * ZodType<…>` — measured by putting it back while trying to mutation-prove
 * this file. What hid it was a stale `tsconfig.tsbuildinfo` reporting 0
 * errors on a file that had 12 (#1829).
 *
 * So the gap this test covers is not "the compiler cannot see it". It is
 * that the compiler's answer is only as good as its cache, and that nothing
 * else in the suite would notice a request losing a header — a 200 with the
 * key dropped looks exactly like a 200 with it present, until the second
 * attempt. Asserted against a real `fetch` for that reason.
 *
 * ## Which presentation this exercises
 *
 * Rendered tests answer `matches: false` to every media query, so `<Modal>`
 * takes its mobile DRAWER branch here, not the desktop Dialog. That is the
 * presentation a farmer in a field gets, and the form inside is the same
 * tree — but it means the desktop Dialog's chrome is NOT covered by this
 * file. `journal-treatment-pdf-action.test.tsx` sets the desktop viewport for
 * the list table; this one deliberately does not.
 *
 * ## Why this drives the whole form rather than calling a handler
 *
 * The key is derived from the draft and the selection
 * (`web:<draft>:<sorted parcel ids>`), so a test that reached `submit()`
 * directly would be asserting a key computed from state no person could have
 * produced. Filling both steps is what makes the assertion about the feature.
 */
import * as React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), back: jest.fn(),
        forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/journal',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantName: 'Acme Farms', tenantSlug: 'acme', currencySymbol: '€' }),
}));

/** MapLibre/WebGL has no place in jsdom; the selection contract is what matters. */
jest.mock('@/components/ui/map/MapCanvas', () => ({
    MapCanvas: ({ selectedIds }: { selectedIds: string[] }) => (
        <div data-testid="map-canvas" data-selected={selectedIds.join(',')} />
    ),
}));

/**
 * Reference data, keyed by the URL the component asks for.
 *
 * Keyed rather than a single blanket value because the component's four reads
 * are CONDITIONAL — `/parcels/by-crop?crop=…` is requested only once a crop is
 * chosen, and a blanket mock would hand the parcel list to the catalogue
 * combobox too, so a step-2 assertion could pass with step 2 never reached.
 */
const swrData: Record<string, unknown> = {
    '/catalog/items?category=PESTICIDE,FERTILIZER': {
        items: [{ id: 'item-1', name: 'Тест Препарат' }],
    },
    '/catalog/units?measure=RATE': {
        units: [{ id: 'unit-1', symbol: 'л/ха' }],
    },
    // TWO crops, because "the crop changes" is a change — and because
    // re-choosing the SAME option in a `Combobox` DESELECTS it (cmdk
    // toggles), which clears the crop rather than changing it. The first
    // version of this file picked Пшеница twice and the map unmounted,
    // since step 2's picker renders only while a crop is chosen.
    '/parcels/by-crop': {
        crops: [
            { cropType: 'Пшеница', parcelCount: 2, areaHaTotal: 5 },
            { cropType: 'Слънчоглед', parcelCount: 1, areaHaTotal: 4 },
        ],
    },
    [`/parcels/by-crop?crop=${encodeURIComponent('Пшеница')}`]: {
        parcels: [
            { id: 'p-1', name: 'Парцел 1', areaHa: 2, locationId: 'b-1', locationName: 'Блок А', geometry: null },
            { id: 'p-2', name: 'Парцел 2', areaHa: 3, locationId: 'b-2', locationName: 'Блок Б', geometry: null },
        ],
    },
    [`/parcels/by-crop?crop=${encodeURIComponent('Слънчоглед')}`]: {
        parcels: [
            { id: 'p-9', name: 'Парцел 9', areaHa: 4, locationId: 'b-1', locationName: 'Блок А', geometry: null },
        ],
    },
};

jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => ({
        data: key == null ? undefined : (swrData as Record<string, unknown>)[key],
        isLoading: false,
        error: undefined,
        mutate: jest.fn(),
    }),
    usePrefetchTenant: () => () => undefined,
}));

import { TreatmentEntryModal } from '@/app/t/[tenantSlug]/(app)/journal/TreatmentEntryModal';
import { TooltipProvider } from '@/components/ui/tooltip';

const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

function mount() {
    const onSaved = jest.fn();
    const setOpen = jest.fn();
    const view = render(
        <TooltipProvider>
            <TreatmentEntryModal open setOpen={setOpen} onSaved={onSaved} />
        </TooltipProvider>,
    );
    return { ...view, onSaved, setOpen };
}

/**
 * Pick an option from one of the form's comboboxes, BY ITS FIELD LABEL.
 *
 * Deliberately a role query rather than `#treatment-product`. `Combobox`
 * renders its trigger with `role="combobox"` and takes its accessible name
 * from the `FormField` label, so this asks for the control the way a screen
 * reader finds it — and it fails loudly if the label wiring breaks, which an
 * id selector would sail straight past.
 */
async function pickFrom(fieldLabel: string, optionText: RegExp) {
    const u = user();
    await u.click(screen.getByRole('combobox', { name: fieldLabel }));
    // The OPTION, found by role rather than by text.
    //
    // `Combobox` is built on cmdk, whose `Command.Item` carries
    // `role="option"`. Searching by text instead matches the TRIGGER too
    // once something is chosen — re-opening the crop picker to change the
    // crop made `findByText(/Пшеница/)` ambiguous, because the trigger then
    // reads "Пшеница · 2 parcels" as well. Role scopes it to the list.
    const options = await screen.findAllByRole('option');
    const option = options.find((o) => optionText.test(o.textContent ?? ''));
    expect(option).toBeDefined();
    await u.click(option as HTMLElement);
}

/**
 * Fill step 1 completely, which is what un-disables «Next».
 *
 * The date goes through the real `DatePicker` popover — it is Date-valued and
 * the draft holds `YYYY-MM-DD`, and that conversion is the thing that would
 * shift a day for a farmer east of UTC, so it is exercised rather than
 * bypassed.
 */
async function fillStepOne() {
    const u = user();
    // The DATE trigger is reached by its visible text, not by an id.
    //
    // `<DatePicker id="treatment-day">` inside a `FormField` puts that id on
    // the LABEL's `htmlFor` and spreads `{...props}` onto the Calendar inside
    // the popover — never onto the trigger button. So `#treatment-day` does
    // not exist in the closed state, and the label labels nothing (#1839).
    // By the FIELD LABEL, which is the trigger's accessible name — the
    // `DatePicker` Trigger takes `aria-labelledby` from the `FormField`,
    // while its visible text is only the placeholder.
    await u.click(screen.getByRole('button', { name: 'Date carried out' }));
    // react-day-picker renders each day as a button named by its number; any
    // day in the shown month will do, and the 15th is never a leading or
    // trailing day of an adjacent month.
    // NOT scoped to `findByRole('dialog')`: once the calendar popover opens
    // there are TWO dialogs on screen — the modal itself and the popover —
    // and the query is ambiguous. A button whose trimmed text is exactly a
    // day number exists only inside the calendar, so it needs no scope.
    //
    // Selected by VISIBLE TEXT, not by accessible name.
    //
    // react-day-picker 10 labels a day button with the fully formatted date
    // (`labelDayButton` → `format(date, 'PPPP')`, prefixed "Today, " and
    // suffixed ", selected" when those modifiers apply), and the format
    // follows the calendar's locale — which is Bulgarian in the running app.
    // So `getByRole('button', { name: '15' })` finds nothing, which is how
    // the first version of this file failed. The day NUMBER is the one thing
    // that is the same in every locale.
    const findDay = () =>
        screen.getAllByRole('button').find((b) => b.textContent?.trim() === '15');
    await waitFor(() => expect(findDay()).toBeDefined());
    await u.click(findDay() as HTMLElement);

    await pickFrom('Product', /Тест Препарат/);
    // By LABEL, not by a query against the render root. `<Modal>` renders
    // into a portal on `document.body`, so the root holds none of this — the
    // first version looked there and got `null`, which surfaces as "Unable to
    // fire a change event - please provide a DOM element" rather than as a
    // field that could not be found.
    // A REGEX, because `FormField`'s `required` appends an asterisk to the
    // label text — the rendered label is "Application dose*", so an exact
    // match finds nothing.
    fireEvent.change(screen.getByLabelText(/Application dose/), {
        target: { value: '2' },
    });
    await pickFrom('Unit', /л\/ха/);
}

/** A POST double that records what `apiPost` handed to `fetch`. */
function postDouble() {
    return jest.fn((input: unknown, init?: RequestInit) => {
        if (String(input).includes('/journal/treatments')) {
            return Promise.resolve({
                ok: true,
                status: 201,
                headers: { get: () => null },
                json: async () => ({
                    treatmentGroupId: 'handle-xyz',
                    parcelCount: 1,
                    taskIds: ['task-1'],
                    replayed: false,
                }),
            } as unknown as Response);
        }
        void init;
        return Promise.resolve({
            ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
        } as unknown as Response);
    });
}

describe('the two-step treatment form', () => {
    it('opens on step one, which is the treatment and not a free-form note', async () => {
        mount();
        // The step-1 heading, and the fields that make this a TREATMENT: a
        // product and a dose. A free-form journal entry has neither.
        // `findAllByText`, not `findByText`: every modal in this app ships
        // TWO `Dialog.Title` elements with the same text and the same DOM id
        // — the visually-hidden fallback `Modal` always renders plus the one
        // `Modal.Header` renders (#1836, platform-wide and pre-existing).
        // `findByText` therefore throws "found multiple elements" on a
        // perfectly correct modal.
        expect((await screen.findAllByText('New entry — the treatment')).length)
            .toBeGreaterThan(0);
        expect(document.querySelector('#treatment-product')).not.toBeNull();
        expect(document.querySelector('#treatment-dose')).not.toBeNull();
        // And the crop picker belongs to step TWO — it must not be reachable
        // before the treatment is described.
        expect(document.querySelector('#treatment-crop')).toBeNull();
    });

    it('will not advance until the treatment is fully described', async () => {
        mount();
        const next = await screen.findByRole('button', { name: 'Next' });
        // Nothing filled: the day, the product, the dose and its unit are all
        // required, so the step cannot be left half-described.
        expect(next).toBeDisabled();

        await fillStepOne();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    });

    it('clears the parcel selection when the crop changes', async () => {
        mount();
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));

        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await user().click(boxes[0]);
        await waitFor(() =>
            expect(screen.getByText(/Selected: 1 parcel/)).toBeInTheDocument(),
        );

        // Switching to a DIFFERENT crop drops the ticks. The list is
        // crop-scoped, so a kept selection would submit parcels no longer on
        // screen — and the register would record a treatment on a crop
        // nobody picked. This is the assertion that fails if `chooseCrop`
        // stops clearing.
        await pickFrom('Crop', /Слънчоглед/);
        await waitFor(() =>
            expect(screen.queryByText(/Selected: 1 parcel/)).not.toBeInTheDocument(),
        );
        // The new crop's own parcel is on screen, so this is a CHANGE of crop
        // and not the crop being cleared — which would also empty the
        // selection, for a different reason, and make the assertion above
        // pass without telling us anything.
        expect(screen.getByText(/Парцел 9/)).toBeInTheDocument();
        expect(screen.queryByText(/Парцел 1/)).not.toBeInTheDocument();
        // The map is told too, since selection is shared both ways.
        expect(screen.getByTestId('map-canvas')).toHaveAttribute('data-selected', '');
    });

    it('sends an Idempotency-Key, without which a retry writes a second treatment', async () => {
        const fetchMock = postDouble();
        global.fetch = fetchMock as unknown as typeof fetch;

        const { onSaved } = mount();
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await user().click(boxes[0]);
        await user().click(await screen.findByRole('button', { name: 'Save' }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const call = fetchMock.mock.calls.find((c) =>
            String(c[0]).includes('/journal/treatments'),
        );
        expect(call).toBeDefined();
        expect(call?.[0]).toBe('/api/t/acme/journal/treatments');

        const headers = (call?.[1] as RequestInit | undefined)?.headers as
            | Record<string, string>
            | undefined;
        // The header itself. `apiPost` MERGES a caller's headers into its own
        // `Content-Type` rather than replacing them, so both must survive.
        expect(headers?.['Idempotency-Key']).toBeTruthy();
        expect(headers?.['Content-Type']).toBe('application/json');

        // And the body is the treatment, with the parcel the farmer ticked.
        const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
        expect(body.parcelIds).toEqual(['p-1']);
        expect(body.productItemId).toBe('item-1');
        expect(body.doseValue).toBe(2);
        expect(body.doseUnitId).toBe('unit-1');
        // A real day, in the API's own `YYYY-MM-DD` form — not an ISO instant,
        // whose UTC slice is the wrong day for a farmer in Sofia near midnight.
        expect(body.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // The handle reaches the page, which is what the list reload and the
        // «Изтегли PDF» button are keyed on.
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(onSaved.mock.calls[0][0]).toMatchObject({ treatmentGroupId: 'handle-xyz' });
    });

    it('keys the same treatment identically, so a double-click cannot write twice', async () => {
        const fetchMock = postDouble();
        global.fetch = fetchMock as unknown as typeof fetch;
        mount();
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        // BOTH parcels, ticked in reverse order, to pin the one property that
        // makes the key stable: it sorts the ids. Ticking p-2 then p-1 must
        // produce the same key as p-1 then p-2, or the same treatment
        // retried after a reorder would be written twice.
        await user().click(boxes[1]);
        await user().click(boxes[0]);
        await user().click(await screen.findByRole('button', { name: 'Save' }));

        await waitFor(() =>
            expect(
                fetchMock.mock.calls.filter((c) => String(c[0]).includes('/journal/treatments')),
            ).toHaveLength(1),
        );
        const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/journal/treatments'));
        const headers = (call?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
        const key = headers['Idempotency-Key'];
        expect(key).toContain('p-1,p-2');
        expect(key).not.toContain('p-2,p-1');
    });
});

/**
 * «Нов запис» is a two-step TREATMENT record, and the request it sends carries
 * an `Idempotency-Key` (#1740).
 *
 * ## What this file asserts, after the write moved to the outbox
 *
 * The treatment is handed to the offline outbox (#1830, owner ruling
 * 2026-10-14), not to `fetch`. So the `Idempotency-Key` is no longer this
 * component's to send: `submit` mints an outbox id BEFORE the first attempt
 * and reuses it on every replay (#924), and on this route that key IS the
 * treatment handle. Asserting the header here would be asserting the outbox's
 * contract in the wrong file.
 *
 * What IS this component's responsibility, and is asserted:
 *
 *   • the url, method and BODY it hands over — trimmed, with empties omitted,
 *     and `parcelIds` sorted so ticking two parcels in either order is one
 *     treatment;
 *   • the queue LABEL, which is what the OfflineSyncBar shows a farmer while
 *     the write waits;
 *   • relaying the outcome, because 'queued' and 'sent' have opposite
 *     consequences on the page — a queued treatment gets an optimistic row
 *     and NO «Изтегли PDF», since the server has never seen it.
 *
 * The history is worth keeping: this form first passed its `RequestInit` as
 * `apiPost`'s THIRD argument, which is the Zod schema, so the header was
 * never sent at all. `tsc` rejects that (TS2353) — a stale
 * `tsconfig.tsbuildinfo` reporting 0 errors on a file with 12 is what hid it
 * (#1829).
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

/**
 * MapLibre/WebGL has no place in jsdom; the selection contract is what matters.
 *
 * `next/dynamic` is mocked too, because the component loads the map through it
 * — the same pair the location-page suite uses. Without the second mock the
 * module mock is simply never consulted and the real MapLibre is pulled in.
 */
jest.mock('@/components/ui/map/MapCanvas', () => ({
    MapCanvas: ({ selectedIds }: { selectedIds: string[] }) => (
        <div data-testid="map-canvas" data-selected={selectedIds.join(',')} />
    ),
}));
jest.mock('next/dynamic', () => () => {
    const mod = require('@/components/ui/map/MapCanvas');
    return mod.MapCanvas;
});

/**
 * Reference data, keyed by the URL the component asks for.
 *
 * Keyed rather than a single blanket value because the component's four reads
 * are CONDITIONAL — `/parcels/by-crop?crop=…` is requested only once a crop is
 * chosen, and a blanket mock would hand the parcel list to the catalogue
 * combobox too, so a step-2 assertion could pass with step 2 never reached.
 */
const swrData: Record<string, unknown> = {
    // The paths the API actually serves. These were `/catalog/items` and
    // `/catalog/units`, which exist nowhere in the repository — and this
    // double happily answered them, so ten green tests ran against a form
    // that would have shown a farmer two empty pickers. CI's E2E caught it.
    // `/items` carries every category and the component narrows to the two
    // it treats with, because the route takes a SINGLE category.
    '/items': [
        { id: 'item-1', name: 'Тест Препарат', category: 'PESTICIDE' },
        { id: 'item-9', name: 'Тест Семена', category: 'SEED' },
    ],
    '/units?measure=RATE': {
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

/**
 * The double THROWS on a key it does not know, which is the point.
 *
 * Returning `undefined` for an unknown key is what let this suite pass while
 * the component read `/catalog/items` — a path no route serves. A double that
 * cannot express "nobody serves that" is green forever, so every key here is
 * a claim that the API serves it, and an unrecognised one fails loudly.
 */
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        if (key != null && !(key in swrData)) {
            throw new Error(
                `useTenantSWR('${key}') is not a path this double serves. ` +
                    `Either the component invented an endpoint, or this fixture ` +
                    `needs the real one adding: ${Object.keys(swrData).join(', ')}`,
            );
        }
        return {
            data: key == null ? undefined : (swrData as Record<string, unknown>)[key],
            isLoading: false,
            error: undefined,
            mutate: jest.fn(),
        };
    },
    usePrefetchTenant: () => () => undefined,
}));

import { TreatmentEntryModal } from '@/app/t/[tenantSlug]/(app)/journal/TreatmentEntryModal';
import { TooltipProvider } from '@/components/ui/tooltip';

/** The subset of `EnqueueInput` this component is responsible for filling. */
interface EnqueuedWrite {
    url: string;
    method: string;
    body: Record<string, unknown>;
    label: string;
    supersedes?: unknown;
}

const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

/**
 * `outcome` is what the outbox answers: 'sent' online, 'queued' when the
 * network failed, 'conflict' when the server parked it — or 'throw' for a
 * terminal 4xx, which `submit` raises rather than returns.
 */
function mount(outcome: 'sent' | 'queued' | 'conflict' | 'throw' = 'sent') {
    const onSaved = jest.fn();
    const setOpen = jest.fn();
    const submit = jest.fn((_input: EnqueuedWrite) =>
        outcome === 'throw'
            ? Promise.reject(
                  new Error('"Sample product" is a sample product, not a registered one.'),
              )
            : Promise.resolve(outcome),
    );
    const view = render(
        <TooltipProvider>
            <TreatmentEntryModal
                open
                setOpen={setOpen}
                offlineSubmit={submit as unknown as React.ComponentProps<typeof TreatmentEntryModal>['offlineSubmit']}
                onSaved={onSaved}
            />
        </TooltipProvider>,
    );
    return { ...view, onSaved, setOpen, submit };
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
 * The DATE is deliberately not touched: a fresh draft is dated TODAY, because
 * the ДНЕВНИК records work already done and the server refuses a future farm
 * day. The picker's own conversion gets its own case below, which chooses the
 * 1st of the month — never a future day, which is what a fixed "15" would be
 * for the first half of every month.
 */
async function fillStepOne() {
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

/** Step 1 filled, a crop picked, one parcel ticked — stopped ON the review. */
async function reachReview(u = user()) {
    await fillStepOne();
    await u.click(screen.getByRole('button', { name: 'Next' }));
    await pickFrom('Crop', /Пшеница/);
    const boxes = await screen.findAllByRole('checkbox');
    await u.click(boxes[0]);
    await u.click(await screen.findByRole('button', { name: 'Next' }));
}

/**
 * Step 2 → the review → saved.
 *
 * A review step sits between the parcels and the write: a recorded treatment
 * stays final, so this is the only place to catch a mistyped dose. There is no
 * confirmation tick — the step itself is the confirmation, matching the phone's
 * `TreatmentCheckView` — so this is one extra Next and then Save.
 *
 * Shared rather than repeated, because SEVEN tests here drive the form to a
 * write and each would otherwise carry the same extra hop.
 *
 * Takes the userEvent instance because one caller shares a single `u` across a
 * fake-timer run rather than setting one up per click.
 */
async function confirmReviewAndSave(u = user()) {
    await u.click(await screen.findByRole('button', { name: 'Next' }));
    await u.click(await screen.findByRole('button', { name: 'Save' }));
}

// The FILENAME still says two-step; the form has three. Kept because
// `rendered-coverage-floor.test.ts` names this file in a written comment and
// the churn of renaming both buys nothing — the describe is where a reader
// looks for what is under test.
describe('the three-step treatment form', () => {
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

    it('offers only products a treatment can apply, not the whole catalogue', async () => {
        mount();
        await user().click(screen.getByRole('combobox', { name: 'Product' }));
        const options = await screen.findAllByRole('option');
        const labels = options.map((o) => o.textContent ?? '');
        expect(labels.some((l) => l.includes('Тест Препарат'))).toBe(true);
        // `/items` serves every category because the route takes only ONE,
        // so the narrowing happens here — a seed is not something you spray.
        expect(labels.some((l) => l.includes('Тест Семена'))).toBe(false);
    });

    it('dates a fresh treatment TODAY, so the common case needs no tap', async () => {
        const { submit } = mount();
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await user().click(boxes[0]);
        await confirmReviewAndSave();

        await waitFor(() => expect(submit).toHaveBeenCalled());
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        // LOCAL parts, not a UTC slice: between 00:00 and 03:00 in Sofia the
        // UTC day is YESTERDAY, which is the mistake this issue has now made
        // three times elsewhere.
        expect(submit.mock.calls[0][0].body.occurredOn).toBe(today);
    });

    it('keeps the picker’s own day when one is chosen', async () => {
        const { submit } = mount();
        const u = user();
        // The trigger's accessible name now ENDS WITH its value: WCAG 2.5.3
        // requires the name to contain the visible text, so #2449 extends
        // `aria-labelledby` with the value slot («Date carried out 15 Jan 2026»,
        // or the placeholder when empty). An exact-name query therefore cannot
        // match, and pinning the full string would re-couple this test to a
        // formatted date. Substring is the right granularity: it asserts WHICH
        // control, which is all this line ever meant.
        await u.click(screen.getByRole('button', { name: /Date carried out/ }));
        /**
         * The 1st of the PREVIOUS month, and the month step is load-bearing.
         *
         * "The 1st — a day that is never in the future" was the right
         * instinct and the wrong day: react-day-picker in single mode TOGGLES,
         * so clicking a day that is already selected clears it. The field
         * defaults to today, so on the 1st of any month this test clicked
         * today, deselected the date, left step one incomplete, and failed at
         * `pickFrom('Crop', …)` — because `Next` never advanced and the Crop
         * combobox does not exist on step one. Once a month, in every
         * timezone, with an error naming neither the date nor the picker.
         *
         * Stepping back a month makes the day unambiguously in the past AND
         * never the already-selected one, so the click can only ever SET a
         * date. It keeps the `-01$` assertion the test was written around.
         */
        await u.click(screen.getByTestId('calendar-prev-month'));
        const first = () =>
            screen.getAllByRole('button').find((b) => b.textContent?.trim() === '1');
        await waitFor(() => expect(first()).toBeDefined());
        await u.click(first() as HTMLElement);
        // The popover must have CLOSED, which is what a successful selection
        // does. If the click toggled the date off instead, the calendar stays
        // open and every later query below lands on it rather than the form —
        // which is exactly how the original failure presented.
        await waitFor(() =>
            expect(screen.queryByTestId('calendar-prev-month')).not.toBeInTheDocument(),
        );

        await fillStepOne();
        await u.click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await u.click(boxes[0]);
        await confirmReviewAndSave(u);

        await waitFor(() => expect(submit).toHaveBeenCalled());
        expect(submit.mock.calls[0][0].body.occurredOn).toMatch(/^\d{4}-\d{2}-01$/);
    });

    /**
     * On a fresh open the calendar HIGHLIGHTS today — the day the draft is
     * dated (#2614).
     *
     * Asserted on `aria-selected`, and the choice of observable is the whole
     * point. The trigger's TEXT goes through `format-date.ts`, which pins
     * `FARM_TIME_ZONE` — so for a Sofia host it renders the correct day even
     * when the `value` prop carries the wrong instant, and a trigger-text
     * assertion passes while the defect is live. Measured: my first version of
     * this test did exactly that.
     *
     * RDP derives the highlight from the input Date's LOCAL parts, which is
     * what the `value` prop actually drives, so this is the one observable the
     * bug cannot hide from.
     */
    it('highlights today on a fresh open, in every timezone', async () => {
        mount();
        const u = user();
        await u.click(screen.getByRole('button', { name: /Date carried out/ }));

        const selected = await waitFor(() => {
            const el = document.querySelector('[aria-selected="true"]');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });

        const expected = String(new Date().getDate());
        expect(selected.textContent?.trim()).toBe(expected);
    });

    /**
     * The picker shows BACK the day it was given (#2614).
     *
     * This is the other half of the off-by-one, and nothing tested it: the
     * `value` prop built LOCAL midnight where the picker's contract is UTC
     * midnight, and `toRDPSingle` reads UTC parts off whatever it is handed.
     * East of UTC that lands a day early, so a Sofia farmer who picked the 1st
     * and reopened the picker saw the previous month's last day highlighted.
     *
     * Measured: dropping the `Z` from that prop fails NOTHING in any timezone
     * — UTC, Sofia, Kiritimati and Los_Angeles all stayed green — which is why
     * this test exists rather than the fix being left on review alone.
     *
     * Asserted through the TRIGGER's accessible name, which #2449 extends with
     * the value slot, because that is the only place the chosen day is
     * observable without reaching into the calendar's internals.
     */
    it('shows back the day it was given, not the day before it', async () => {
        mount();
        const u = user();

        await u.click(screen.getByRole('button', { name: /Date carried out/ }));
        await u.click(screen.getByTestId('calendar-prev-month'));
        const first = () =>
            screen.getAllByRole('button').find((b) => b.textContent?.trim() === '1');
        await waitFor(() => expect(first()).toBeDefined());
        await u.click(first() as HTMLElement);
        await waitFor(() =>
            expect(screen.queryByTestId('calendar-prev-month')).not.toBeInTheDocument(),
        );

        // Reopen: the day just chosen must be the day displayed. A value
        // round-tripped through the wrong midnight comes back as the previous
        // month's last day, which is never a "1".
        /**
         * Through `textContent`, not `toHaveAccessibleName`: the trigger's name
         * comes from `aria-labelledby`, and jsdom's accname computation returns
         * EMPTY for it here even though the role query matches by name. The
         * rendered text is «01 Oct 2026» and is what a farmer actually reads.
         */
        const trigger = screen.getByRole('button', { name: /Date carried out/ });
        const shown = trigger.textContent ?? '';
        // The FIRST day — zero-padded, so `\b1\b` would not match it.
        expect(shown).toMatch(/\b01\b/);
        // And never a month-end, which is exactly what the off-by-one yields:
        // in Sofia the unfixed value prop rendered «30 Sep 2026» here.
        expect(shown).not.toMatch(/\b(28|29|30|31)\b/);
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

    it('hands the treatment to the outbox, which is what survives a lost signal', async () => {
        const { submit, onSaved } = mount();
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await user().click(boxes[0]);
        await confirmReviewAndSave();

        await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
        const input = submit.mock.calls[0][0];
        expect(input.url).toBe('/api/t/acme/journal/treatments');
        expect(input.method).toBe('POST');
        expect(input.body.parcelIds).toEqual(['p-1']);
        expect(input.body.productItemId).toBe('item-1');
        expect(input.body.doseValue).toBe(2);
        expect(input.body.doseUnitId).toBe('unit-1');
        // A real day in the API's own form — not an ISO instant, whose UTC
        // slice is the previous day for a farmer in Sofia near midnight.
        expect(input.body.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // The farmer's own word for it, shown by the OfflineSyncBar while it waits.
        expect(input.label).toBe('Тест Препарат');
        // NO supersede key: every save MINTS a treatment, so an older queued
        // one is a DIFFERENT treatment and must not be replaced by this.
        expect(input.supersedes).toBeUndefined();
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    it('relays a QUEUED write, which the page must render without a document', async () => {
        // The two outcomes have opposite consequences: 'queued' gets an
        // optimistic row and no «Изтегли PDF», because the treatment the
        // button would fetch does not exist on the server yet.
        const { submit, onSaved } = mount('queued');
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await user().click(boxes[0]);
        await confirmReviewAndSave();

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(submit).toHaveBeenCalledTimes(1);
        expect(onSaved.mock.calls[0][0]).toMatchObject({
            delivery: 'queued',
            productName: 'Тест Препарат',
            parcelCount: 1,
        });
    });

    it('shows a terminal refusal instead of closing on it', async () => {
        // `submit` THROWS on a terminal 4xx — the sample-product refusal and
        // the cross-tenant parcel refusal both arrive this way, already
        // localised. Closing the modal would discard the farmer's typing and
        // say nothing.
        const { submit, onSaved } = mount('throw');
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await user().click(boxes[0]);
        await confirmReviewAndSave();

        await waitFor(() => expect(submit).toHaveBeenCalled());
        expect(await screen.findByText(/sample product/i)).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();
        // Still in the form, on the REVIEW, with the work intact. This used to
        // assert the step-two crop picker as a proxy for "did not close"; the
        // review step is where a refusal now lands, so the proxy named the
        // wrong screen while the property it stood for was unchanged.
        expect((await screen.findAllByText('New entry — review')).length).toBeGreaterThan(0);
        // And Save is still live, so a retry costs one tap: the refusal was
        // about the treatment, not about the form's state.
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('sends what was typed TRIMMED, so the body is the treatment and nothing else', async () => {
        const { submit } = mount();
        await fillStepOne();
        fireEvent.change(screen.getByLabelText(/Pest/), {
            target: { value: 'листни въшки   ' },
        });
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        await user().click(boxes[0]);
        await confirmReviewAndSave();

        await waitFor(() => expect(submit).toHaveBeenCalled());
        const body = submit.mock.calls[0][0].body;
        expect(body.targetNote).toBe('листни въшки');
        // And an untouched optional field is ABSENT rather than empty, so the
        // server is not asked to store a blank it would have to interpret.
        expect(body).not.toHaveProperty('applicationTechnique');
        expect(body).not.toHaveProperty('quarantinePeriodDays');
    });

    it('sorts the parcel ids, so ticking them in either order is ONE treatment', async () => {
        const { submit } = mount();
        await fillStepOne();
        await user().click(screen.getByRole('button', { name: 'Next' }));
        await pickFrom('Crop', /Пшеница/);
        const boxes = await screen.findAllByRole('checkbox');
        // Reverse order deliberately.
        await user().click(boxes[1]);
        await user().click(boxes[0]);
        await confirmReviewAndSave();

        await waitFor(() => expect(submit).toHaveBeenCalled());
        const body = submit.mock.calls[0][0].body;
        expect(body.parcelIds).toEqual(['p-1', 'p-2']);
    });


    // ── The review step (step 3) ─────────────────────────────────────────
    //
    // The tests above pass THROUGH the review on their way to a write. These
    // are about the review itself: a recorded treatment stays final, so what
    // this screen shows is a farmer's only chance to catch a mistyped dose.
    //
    // There is no confirmation tick to test. An earlier draft gated Save on
    // one, keyed to the body signature so an edit afterwards revoked it; the
    // owner removed it on 2026-10-22 to match the phone, where this step has
    // shipped without a tick since 2026-10-20.

    it('reviews what will be WRITTEN, not what was typed', async () => {
        mount();
        await reachReview();
        // The product and the dose with its unit, as one reading — «2 л/ха» is
        // how the form is read, not two unrelated fields.
        expect((await screen.findAllByText('New entry — review')).length).toBeGreaterThan(0);
        expect(screen.getByText('Тест Препарат')).toBeInTheDocument();
        expect(screen.getByText('2 л/ха')).toBeInTheDocument();
        expect(screen.getByText('Парцел 1')).toBeInTheDocument();
    });

    it('shows the area in DECARES, which is what the register prints', async () => {
        // `Парцел 1` is `areaHa: 2` in the fixture. Areas are stored in
        // hectares and Bulgarian farmers work in декари, so the register's
        // column is «Площ (дка)» — 2 ha is 20 dca. Rendering the stored number
        // would be wrong by a factor of ten in the direction that looks
        // plausible, which is why this asserts 20 and not merely "a number".
        mount();
        await reachReview();
        expect(await screen.findByText('20 dca')).toBeInTheDocument();
        expect(screen.queryByText('2 dca')).toBeNull();
    });
});

/**
 * `<NewCropPlanModal>` — behavioural lock on the create-crop-plan flow.
 *
 * The modal is the only place a succession plan is configured, and almost
 * everything it does is a silent transformation: it re-seeds itself on open,
 * narrows the variety list to the chosen crop type, back-fills the crop type
 * from a variety, coerces blank numeric boxes to `null`, and conditionally
 * fires a second POST to /generate. None of that is visible in a snapshot —
 * a regression in any of it ships a wrong request body or a stale form.
 *
 * Every `it()` below names the production break it catches.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';

// The Modal primitive calls useRouter for its discard-guard navigation
// interception, so the router must exist even though nothing navigates.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/planning',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    return {
        useTenantApiUrl: () => apiUrl,
        useTenantHref: () => (p: string) => `/t/acme${p}`,
    };
});

const apiPost = jest.fn();
const apiGet = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiPost: (...a: unknown[]) => apiPost(...a),
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiPatch: jest.fn(),
    apiDelete: jest.fn(),
}));

import { NewCropPlanModal } from '@/app/t/[tenantSlug]/(app)/planning/NewCropPlanModal';

const SEASONS = [
    { id: 'season-1', name: 'Spring 2026' },
    { id: 'season-2', name: 'Autumn 2026' },
];
const CROP_TYPES = [
    { id: 'ct-lettuce', name: 'Lettuce' },
    { id: 'ct-tomato', name: 'Tomato' },
];
const VARIETIES = [
    {
        id: 'var-lollo',
        name: 'Lollo Rossa',
        cropType: { id: 'ct-lettuce', name: 'Lettuce' },
        defaultMethod: 'TRANSPLANT',
    },
    {
        id: 'var-romaine',
        name: 'Romaine',
        cropType: { id: 'ct-lettuce', name: 'Lettuce' },
        defaultMethod: null,
    },
    {
        id: 'var-san-marzano',
        name: 'San Marzano',
        cropType: { id: 'ct-tomato', name: 'Tomato' },
        defaultMethod: 'TRANSPLANT',
    },
];
const LOCATIONS = [{ id: 'loc-1', name: 'Home farm' }];

/**
 * Harness that owns `open` so the re-seed-on-open effect can be exercised
 * the way the planning page drives it (close → reopen).
 */
function Harness({ onSaved }: { onSaved?: (p: { id: string }) => void }) {
    const [open, setOpen] = React.useState(true);
    return (
        <TooltipProvider>
            <button type="button" onClick={() => setOpen(true)}>
                reopen
            </button>
            <NewCropPlanModal
                open={open}
                setOpen={setOpen}
                tenantSlug="acme"
                seasons={SEASONS}
                cropTypes={CROP_TYPES}
                varieties={VARIETIES}
                locations={LOCATIONS}
                onSaved={onSaved}
            />
        </TooltipProvider>
    );
}

function renderModal(onSaved?: (p: { id: string }) => void) {
    return render(<Harness onSaved={onSaved} />);
}

/**
 * Resolve a Combobox trigger by its FormField label.
 *
 * `<Combobox aria-label>` is NOT forwarded to the trigger button (the
 * accessible name is the selected option, falling back to the placeholder),
 * so role+name lookups would drift with state. The label is stable.
 */
function comboboxFor(label: string): HTMLElement {
    const field = Array.from(
        document.querySelectorAll<HTMLElement>('[data-form-field="true"]'),
    ).find(
        (el) =>
            el.querySelector('label')?.textContent?.replace(/\*/g, '').trim() === label,
    );
    if (!field) throw new Error(`No form field labelled "${label}"`);
    const trigger = field.querySelector<HTMLElement>('[role="combobox"]');
    if (!trigger) throw new Error(`Form field "${label}" has no combobox trigger`);
    return trigger;
}

const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

/** Open a labelled Combobox and return its option rows, in render order. */
async function openPicker(u: ReturnType<typeof user>, label: string) {
    await u.click(comboboxFor(label));
    return screen.findAllByRole('option');
}

/** Open a labelled Combobox and commit the option whose text matches. */
async function pick(u: ReturnType<typeof user>, label: string, optionLabel: string | RegExp) {
    await u.click(comboboxFor(label));
    await u.click(await screen.findByRole('option', { name: optionLabel }));
}

/** Open a labelled Combobox, type into its search box, and hit the create row. */
async function createInline(u: ReturnType<typeof user>, label: string, search: string, row: RegExp) {
    await u.click(comboboxFor(label));
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: search } });
    await u.click(await screen.findByRole('option', { name: row }));
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const submitBtn = () => byId('crop-plan-submit') as unknown as HTMLButtonElement;
const type = (id: string, value: string) =>
    fireEvent.change(byId(id), { target: { value } });

beforeEach(() => {
    jest.clearAllMocks();
    apiPost.mockResolvedValue({ id: 'plan-1' });
    apiGet.mockResolvedValue({ parcels: [] });
});

// ─── Form seeding ────────────────────────────────────────────────────

describe('NewCropPlanModal — seeding on open', () => {
    it('preselects the first season so a one-season tenant needs no extra click', () => {
        // Break: dropping `setSeasonId(seasons[0]?.id ?? '')` from the open
        // effect leaves the required Season empty, so submit stays disabled
        // even after the operator fills in everything else.
        renderModal();
        expect(comboboxFor('Season')).toHaveTextContent('Spring 2026');
    });

    it('clears the previous plan out of every box when reopened', async () => {
        // Break: making the re-seed effect depend on mount instead of `open`
        // (or dropping the setters) leaves the last plan's name + successions
        // in the form, so the second plan silently inherits the first's config.
        const u = user();
        renderModal();

        type('crop-plan-name', 'Summer lettuce');
        type('crop-plan-successions', '6');
        expect(byId('crop-plan-name')).toHaveValue('Summer lettuce');

        await u.click(byId('crop-plan-cancel'));
        await waitFor(() => expect(document.getElementById('crop-plan-name')).toBeNull());
        await u.click(screen.getByRole('button', { name: 'reopen' }));

        await waitFor(() => expect(byId('crop-plan-name')).toHaveValue(''));
        expect(byId('crop-plan-successions')).toHaveValue('1');
        expect(byId('crop-plan-interval')).toHaveValue('0');
    });
});

// ─── Catalogue narrowing ─────────────────────────────────────────────

describe('NewCropPlanModal — variety narrowing + back-fill', () => {
    it('offers every variety while no crop type is chosen', async () => {
        const u = user();
        renderModal();
        const all = (await openPicker(u, 'Variety')).map((o) => o.textContent);
        expect(all).toEqual(['Lollo Rossa', 'Romaine', 'San Marzano']);
    });

    it('narrows the variety list to the chosen crop type', async () => {
        // Break: dropping the `cropTypeId` filter from `varietyOptions` offers
        // tomato varieties on a lettuce plan — the engine then schedules with
        // the wrong days-to-maturity.
        const u = user();
        renderModal();
        await pick(u, 'Crop type', 'Lettuce');

        const narrowed = (await openPicker(u, 'Variety')).map((o) => o.textContent);
        expect(narrowed).toEqual(['Lollo Rossa', 'Romaine']);
    });

    it('back-fills the crop type and the default method from the picked variety', async () => {
        // Break: reducing `onVarietyChange` to `setCropVarietyId(id)` leaves
        // the required crop type unset (submit stays disabled) and keeps
        // DIRECT_SOW for a variety that must be transplanted.
        const u = user();
        renderModal();

        await pick(u, 'Variety', 'San Marzano');

        expect(comboboxFor('Crop type')).toHaveTextContent('Tomato');
        expect(comboboxFor('Method')).toHaveTextContent('Transplant');
    });

    it('leaves the method alone for a variety with no default', async () => {
        // Break: `setMethod(v.defaultMethod)` without the truthiness guard
        // writes null/'' into the method and the plan posts an empty method.
        const u = user();
        renderModal();

        await pick(u, 'Variety', 'Romaine');
        expect(comboboxFor('Method')).toHaveTextContent('Direct sow');
    });

    it('drops a variety that no longer matches when the crop type is changed', async () => {
        // Break: not clearing `cropVarietyId` in the crop-type setter posts a
        // lettuce variety against a tomato plan — a cross-crop plan the
        // server has no reason to reject.
        const u = user();
        renderModal();

        await pick(u, 'Variety', 'Lollo Rossa'); // also back-fills Lettuce
        expect(comboboxFor('Variety')).toHaveTextContent('Lollo Rossa');

        await pick(u, 'Crop type', 'Tomato');
        expect(comboboxFor('Variety')).toHaveTextContent('Select variety');
    });
});

// ─── Submit gating + payload ─────────────────────────────────────────

describe('NewCropPlanModal — submit gating', () => {
    it('keeps submit disabled until BOTH a name and a crop type are present', async () => {
        // Break: dropping either conjunct from `canSubmit` lets a plan POST
        // go out with an empty name / no crop type, which 400s server-side.
        const u = user();
        renderModal();

        expect(submitBtn()).toBeDisabled(); // season is preselected, name is not

        type('crop-plan-name', 'Summer lettuce');
        expect(submitBtn()).toBeDisabled(); // still no crop type

        await pick(u, 'Crop type', 'Lettuce');
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    });

    it('treats a whitespace-only name as no name', async () => {
        // Break: `name.length > 0` instead of `name.trim().length > 0`
        // enables submit for "   " and creates an unnamed plan.
        const u = user();
        renderModal();
        await pick(u, 'Crop type', 'Lettuce');
        type('crop-plan-name', '   ');
        expect(submitBtn()).toBeDisabled();
    });
});

describe('NewCropPlanModal — request shaping', () => {
    async function fillMinimal(u: ReturnType<typeof user>) {
        type('crop-plan-name', '  Summer lettuce  ');
        await pick(u, 'Crop type', 'Lettuce');
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    }

    it('sends blank numeric boxes as null rather than 0 or NaN', async () => {
        // Break: `Number(plantsPerSuccession)` without the blank check sends
        // 0 (or NaN) for "not specified" — the allocation engine then plants
        // zero, or the request fails schema validation.
        const u = user();
        renderModal();
        await fillMinimal(u);
        await u.click(submitBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        const [url, body] = apiPost.mock.calls[0];
        expect(url).toBe('/api/t/acme/planning/crop-plans');
        expect(body).toMatchObject({
            name: 'Summer lettuce', // trimmed
            seasonId: 'season-1',
            cropTypeId: 'ct-lettuce',
            cropVarietyId: null,
            locationId: null,
            parcelId: null,
            method: 'DIRECT_SOW',
            successions: 1,
            intervalDays: 0,
            plantsPerSuccession: null,
            bedLengthM: null,
            rowsPerBed: null,
            targetAreaM2: null,
            notes: null,
        });
        expect(typeof (body as { firstSowDate: unknown }).firstSowDate).toBe('string');
    });

    it('sends the filled allocation + notes boxes as numbers and trimmed text', async () => {
        // Break: forwarding the raw strings (or forgetting `.trim()` on the
        // notes) stores "30" as text and leaks the operator's stray spaces.
        const u = user();
        renderModal();
        await fillMinimal(u);

        type('crop-plan-plants', '60');
        type('crop-plan-bed-length', '30.5');
        type('crop-plan-rows-per-bed', '3');
        type('crop-plan-target-area', '120');
        type('crop-plan-notes', '  under fleece  ');
        await u.click(submitBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0][1]).toMatchObject({
            plantsPerSuccession: 60,
            bedLengthM: 30.5,
            rowsPerBed: 3,
            targetAreaM2: 120,
            notes: 'under fleece',
        });
    });

    it('strips non-numeric characters as the operator types', () => {
        // Break: dropping the `replace(/[^0-9]/g, '')` sanitiser lets "4a"
        // through and `Number('4a')` posts NaN.
        renderModal();
        type('crop-plan-successions', '4a');
        expect(byId('crop-plan-successions')).toHaveValue('4');
        // The decimal boxes keep the dot but drop letters.
        type('crop-plan-bed-length', '3x0.5');
        expect(byId('crop-plan-bed-length')).toHaveValue('30.5');
    });

    it('falls back to 1 succession when the box is cleared', async () => {
        // Break: sending `Number('')` (0) expands a plan with zero sowings —
        // an empty board with no error anywhere.
        const u = user();
        renderModal();
        type('crop-plan-name', 'Summer lettuce');
        await pick(u, 'Crop type', 'Lettuce');
        type('crop-plan-successions', '');
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
        await u.click(submitBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0][1]).toMatchObject({ successions: 1 });
    });
});

describe('NewCropPlanModal — generate-now branch', () => {
    async function fillWithVariety(u: ReturnType<typeof user>) {
        type('crop-plan-name', 'Summer lettuce');
        await pick(u, 'Variety', 'Lollo Rossa'); // back-fills Lettuce
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    }

    it('generates the succession board when a variety is chosen', async () => {
        // Break: dropping the second POST leaves the plan board empty even
        // though "Generate plantings now" is ticked.
        const u = user();
        renderModal();
        await fillWithVariety(u);
        await u.click(submitBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
        expect(apiPost.mock.calls[1][0]).toBe('/api/t/acme/planning/crop-plans/plan-1/generate');
    });

    it('skips generation — and says why — when no variety is chosen', async () => {
        // Break: dropping the `&& cropVarietyId` guard fires a generate call
        // the engine cannot satisfy, and losing the hint leaves the operator
        // with a silently empty board.
        const u = user();
        renderModal();
        expect(document.getElementById('crop-plan-generate-hint')).not.toBeNull();

        type('crop-plan-name', 'Summer lettuce');
        await pick(u, 'Crop type', 'Lettuce');
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
        await u.click(submitBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
        expect(apiPost.mock.calls[0][0]).toBe('/api/t/acme/planning/crop-plans');
    });

    it('hides the needs-a-variety hint once a variety is picked', async () => {
        // Break: rendering the hint unconditionally nags about a variety the
        // operator has already chosen.
        const u = user();
        renderModal();
        await pick(u, 'Variety', 'Lollo Rossa');
        expect(document.getElementById('crop-plan-generate-hint')).toBeNull();
    });

    it('does not generate when the operator unticks the box', async () => {
        // Break: reading a constant instead of `generateNow` ignores the
        // operator's explicit opt-out and expands the board anyway.
        const u = user();
        renderModal();
        await fillWithVariety(u);
        await u.click(byId('crop-plan-generate-now'));
        await u.click(submitBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    });

    it('still closes and reports the plan when generation throws', async () => {
        // Break: letting the /generate rejection escape the inner try loses
        // the created plan — the modal would show an error and never call
        // onSaved, so the operator re-creates a duplicate plan.
        const u = user();
        apiPost
            .mockResolvedValueOnce({ id: 'plan-1' })
            .mockRejectedValueOnce(new Error('CROP_PLAN_NOT_READY'));
        const onSaved = jest.fn();
        renderModal(onSaved);
        await fillWithVariety(u);
        await u.click(submitBtn());

        await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'plan-1' }));
        expect(screen.queryByText('CROP_PLAN_NOT_READY')).toBeNull();
    });
});

describe('NewCropPlanModal — failure surfaces', () => {
    it('keeps the modal open and shows the server message when create fails', async () => {
        // Break: closing on the catch path (or swallowing the message) hides
        // a real rejection — the operator thinks the plan was created.
        const u = user();
        apiPost.mockRejectedValueOnce(new Error('Season is closed'));
        const onSaved = jest.fn();
        renderModal(onSaved);

        type('crop-plan-name', 'Summer lettuce');
        await pick(u, 'Crop type', 'Lettuce');
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
        await u.click(submitBtn());

        expect(await screen.findByRole('alert')).toHaveTextContent('Season is closed');
        expect(onSaved).not.toHaveBeenCalled();
        expect(document.getElementById('crop-plan-name')).not.toBeNull();
    });

    it('re-enables submit after a failure so the operator can retry', async () => {
        // Break: not resetting `submitting` in the finally block leaves the
        // form permanently disabled after one transient failure.
        const u = user();
        apiPost.mockRejectedValueOnce(new Error('boom'));
        renderModal();

        type('crop-plan-name', 'Summer lettuce');
        await pick(u, 'Crop type', 'Lettuce');
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
        await u.click(submitBtn());

        await screen.findByRole('alert');
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    });
});

// ─── Inline catalogue creation (the fresh-tenant cold-start path) ────

describe('NewCropPlanModal — inline season + crop-type creation', () => {
    it('creates a season from the picker search and selects it', async () => {
        // Break: not appending to `localSeasons` (or not calling setSeasonId)
        // leaves a freshly-created season invisible/unselected, so a brand-new
        // tenant can never satisfy the required Season field.
        const u = user();
        apiPost.mockResolvedValueOnce({ id: 'season-9', name: 'Winter 2027' });
        renderModal();

        await createInline(u, 'Season', 'Winter 2027', /Create season/);

        await waitFor(() => expect(comboboxFor('Season')).toHaveTextContent('Winter 2027'));
        const [url, body] = apiPost.mock.calls[0];
        expect(url).toBe('/api/t/acme/planning/seasons');
        expect(body).toMatchObject({ name: 'Winter 2027', status: 'PLANNING' });
    });

    it('creates a crop type inline and drops the stale variety with it', async () => {
        // Break: forgetting `setCropVarietyId('')` in `createCropTypeInline`
        // keeps a variety belonging to the OLD crop type attached to the plan.
        const u = user();
        renderModal();
        await pick(u, 'Variety', 'Lollo Rossa');

        apiPost.mockResolvedValueOnce({ id: 'ct-kale', name: 'Kale' });
        await createInline(u, 'Crop type', 'Kale', /Create crop type/);

        await waitFor(() => expect(comboboxFor('Crop type')).toHaveTextContent('Kale'));
        expect(comboboxFor('Variety')).toHaveTextContent('No varieties yet');
        expect(apiPost.mock.calls[0][0]).toBe('/api/t/acme/planning/crop-types');
    });

    it('surfaces the server message when the inline season create fails', async () => {
        // Break: swallowing the rejection makes the "Create season" row look
        // like a no-op — the operator clicks it repeatedly.
        const u = user();
        apiPost.mockRejectedValueOnce(new Error('Season name already used'));
        renderModal();

        await createInline(u, 'Season', 'Spring 2026', /Create season/);

        expect(await screen.findByRole('alert')).toHaveTextContent('Season name already used');
    });

    it('does not POST when the create search is only whitespace', async () => {
        // Break: dropping the `if (!trimmed) return false` guard creates a
        // season named "" on a stray click of the always-present create row.
        const u = user();
        renderModal();

        await createInline(u, 'Season', '   ', /Create season/);

        await waitFor(() => expect(apiPost).not.toHaveBeenCalled());
    });
});

describe('NewCropPlanModal — inline variety creation', () => {
    it('gates the new-variety affordance on a chosen crop type', async () => {
        // Break: enabling the toggle without a crop type opens a mini-form
        // whose POST can only 400 — a variety must belong to a crop type.
        const u = user();
        renderModal();
        const toggle = byId('crop-plan-new-variety-toggle');
        expect(toggle).toBeDisabled();
        expect(toggle).toHaveTextContent('Pick a crop type first');

        await pick(u, 'Crop type', 'Lettuce');
        await waitFor(() => expect(byId('crop-plan-new-variety-toggle')).not.toBeDisabled());
        expect(byId('crop-plan-new-variety-toggle')).toHaveTextContent('New variety');
    });

    it('posts the variety under the current crop type + method, then selects it', async () => {
        // Break: omitting `cropTypeId`/`defaultMethod` from the body orphans
        // the variety, and not calling `setCropVarietyId(created.id)` leaves
        // the picker on the placeholder after a successful create.
        const u = user();
        renderModal();
        await pick(u, 'Crop type', 'Tomato');
        await u.click(byId('crop-plan-new-variety-toggle'));

        apiPost.mockResolvedValueOnce({ id: 'var-new', name: 'Roma' });
        type('crop-plan-new-variety-name', 'Roma');
        type('crop-plan-new-variety-maturity', '75');
        await u.click(byId('crop-plan-new-variety-save'));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        const [url, body] = apiPost.mock.calls[0];
        expect(url).toBe('/api/t/acme/planning/crop-varieties');
        expect(body).toEqual({
            cropTypeId: 'ct-tomato',
            name: 'Roma',
            defaultMethod: 'DIRECT_SOW',
            daysToMaturity: 75,
        });
        await waitFor(() => expect(comboboxFor('Variety')).toHaveTextContent('Roma'));
        // The mini-form collapses on success.
        expect(document.getElementById('crop-plan-new-variety-form')).toBeNull();
    });

    it('sends daysToMaturity null when the maturity box is left blank', async () => {
        // Break: `Number('')` is 0 — a zero-day maturity makes the succession
        // engine schedule every harvest on the sow date.
        const u = user();
        renderModal();
        await pick(u, 'Crop type', 'Tomato');
        await u.click(byId('crop-plan-new-variety-toggle'));

        apiPost.mockResolvedValueOnce({ id: 'var-new', name: 'Roma' });
        type('crop-plan-new-variety-name', 'Roma');
        await u.click(byId('crop-plan-new-variety-save'));

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0][1]).toMatchObject({ daysToMaturity: null });
    });

    it('keeps the mini-form open with the message when the create fails', async () => {
        // Break: collapsing the form on the error path throws away what the
        // operator typed.
        const u = user();
        renderModal();
        await pick(u, 'Crop type', 'Tomato');
        await u.click(byId('crop-plan-new-variety-toggle'));

        apiPost.mockRejectedValueOnce(new Error('Variety already exists'));
        type('crop-plan-new-variety-name', 'Roma');
        await u.click(byId('crop-plan-new-variety-save'));

        expect(await screen.findByRole('alert')).toHaveTextContent('Variety already exists');
        expect(document.getElementById('crop-plan-new-variety-form')).not.toBeNull();
        expect(byId('crop-plan-new-variety-name')).toHaveValue('Roma');
    });

    it('dismisses the mini-form on cancel', async () => {
        // Break: a cancel that doesn't clear `showNewVariety` traps the
        // operator in the sub-form.
        const u = user();
        renderModal();
        await pick(u, 'Crop type', 'Tomato');
        await u.click(byId('crop-plan-new-variety-toggle'));
        expect(document.getElementById('crop-plan-new-variety-form')).not.toBeNull();

        await u.click(byId('crop-plan-new-variety-cancel'));
        expect(document.getElementById('crop-plan-new-variety-form')).toBeNull();
    });
});

// ─── Parcels ─────────────────────────────────────────────────────────

describe('NewCropPlanModal — parcel picker', () => {
    it('stays disabled, and says so, until a location is picked', () => {
        // Break: enabling the parcel picker with no location shows the
        // previous location's parcels (or an unexplained empty list).
        renderModal();
        const parcel = comboboxFor('Parcel');
        expect(parcel).toBeDisabled();
        expect(parcel).toHaveTextContent('Select a location first');
        expect(apiGet).not.toHaveBeenCalled();
    });

    it('loads the location’s parcels largest-first and labels them with area', async () => {
        // Break: dropping the area sort buries the field the operator means
        // under a long alphabetical list; dropping the `areaHa != null` check
        // renders "Ъгъл (null ha)".
        const u = user();
        apiGet.mockResolvedValue({
            parcels: [
                { id: 'p-small', name: 'Градина', areaHa: 0.4 },
                { id: 'p-big', name: 'Нива 1', areaHa: 12.5 },
                { id: 'p-none', name: 'Ъгъл', areaHa: null },
            ],
        });
        renderModal();
        await pick(u, 'Location', 'Home farm');

        await waitFor(() => expect(apiGet).toHaveBeenCalled());
        expect(apiGet.mock.calls[0][0]).toBe('/api/t/acme/locations/loc-1/parcels?simplify=0.01');

        await waitFor(() => expect(comboboxFor('Parcel')).not.toBeDisabled());
        const options = (await openPicker(u, 'Parcel')).map((o) => o.textContent);
        expect(options).toEqual(['Нива 1 (12.5 ha)', 'Градина (0.4 ha)', 'Ъгъл']);
    });

    it('falls back to an empty list when the parcel fetch fails', async () => {
        // Break: an unhandled rejection here leaves `parcelsLoading` true, so
        // the picker is disabled forever after one flaky read.
        const u = user();
        apiGet.mockRejectedValue(new Error('offline'));
        renderModal();
        await pick(u, 'Location', 'Home farm');

        await waitFor(() =>
            expect(comboboxFor('Parcel')).toHaveTextContent('No parcels in this location'),
        );
        expect(comboboxFor('Parcel')).not.toBeDisabled();
    });

    it('clears a parcel chosen under the previous location', async () => {
        // Break: keeping `parcelId` across a location change posts a parcel
        // that does not belong to the plan's location.
        const u = user();
        apiGet.mockResolvedValue({ parcels: [{ id: 'p-big', name: 'Нива 1', areaHa: 12.5 }] });
        renderModal();
        await pick(u, 'Location', 'Home farm');
        await waitFor(() => expect(comboboxFor('Parcel')).not.toBeDisabled());
        await pick(u, 'Parcel', /Нива 1/);
        expect(comboboxFor('Parcel')).toHaveTextContent('Нива 1');

        // Re-picking the same location toggles it OFF in the single-select
        // Combobox — the location clears, and the parcel must go with it.
        await pick(u, 'Location', 'Home farm');
        await waitFor(() =>
            expect(comboboxFor('Parcel')).toHaveTextContent('Select a location first'),
        );
    });

    it('sends the chosen location + parcel on the plan POST', async () => {
        // Break: hard-coding `locationId: null` (or dropping parcelId) silently
        // detaches the plan from the field it was drawn for.
        const u = user();
        apiGet.mockResolvedValue({ parcels: [{ id: 'p-big', name: 'Нива 1', areaHa: 12.5 }] });
        renderModal();

        type('crop-plan-name', 'Summer lettuce');
        await pick(u, 'Crop type', 'Lettuce');
        await pick(u, 'Location', 'Home farm');
        await waitFor(() => expect(comboboxFor('Parcel')).not.toBeDisabled());
        await pick(u, 'Parcel', /Нива 1/);
        await waitFor(() => expect(submitBtn()).not.toBeDisabled());
        await u.click(submitBtn());

        await waitFor(() => expect(apiPost).toHaveBeenCalled());
        expect(apiPost.mock.calls[0][1]).toMatchObject({
            locationId: 'loc-1',
            parcelId: 'p-big',
        });
    });
});

// ─── Chrome that the flow depends on ────────────────────────────────

describe('NewCropPlanModal — modal chrome', () => {
    it('renders the required-field set the planning flow needs', () => {
        // Break: a field silently dropped in a refactor is invisible in a
        // green suite otherwise — the plan then posts without it.
        renderModal();
        const dialog = screen.getByRole('dialog');
        for (const id of [
            'crop-plan-name',
            'crop-plan-successions',
            'crop-plan-interval',
            'crop-plan-plants',
            'crop-plan-bed-length',
            'crop-plan-rows-per-bed',
            'crop-plan-target-area',
            'crop-plan-notes',
            'crop-plan-generate-now',
            'crop-plan-submit',
            'crop-plan-cancel',
        ]) {
            expect(document.getElementById(id)).not.toBeNull();
        }
        expect(within(dialog).getAllByText('New crop plan').length).toBeGreaterThan(0);
    });
});

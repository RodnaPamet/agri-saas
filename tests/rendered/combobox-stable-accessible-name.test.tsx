/**
 * Epic 55 — the Combobox trigger's accessible NAME must be stable.
 *
 * Before this suite the trigger's name was computed as
 *
 *     buttonProps['aria-label'] ?? (selectedTriggerText || placeholder)
 *
 * so with no explicit label the name was *the selected option's label*.
 * Two concrete harms:
 *
 *   1. A screen-reader user hears a practice whose name changes as they
 *      use it, and never hears the author's intended label. WAI-ARIA is
 *      explicit that a combobox's NAME comes from its label while its
 *      VALUE is conveyed separately (trigger content / aria-expanded).
 *   2. `getByRole('combobox', { name })` is unusable as a locator — the
 *      wave-23 suites had to resolve pickers through their FormField
 *      label instead of by role+name.
 *
 * The fix threads `aria-labelledby` from `<FormField>`'s visible label
 * (FormField already owns the label↔practice id wiring for `htmlFor` /
 * `aria-describedby`). The `aria-label` fallback that guarantees axe's
 * `button-name` rule stays intact as the LAST resort — the tests at the
 * bottom of this file lock that in.
 *
 * Viewport note: `tests/rendered/setup.ts` answers `matches: false` to
 * every media query, so `useMediaQuery()` resolves `isMobile: true`.
 * Every combobox here therefore renders the *mobile drawer* branch.
 * That is fine for this suite — the trigger element (the thing under
 * test) is identical in both branches — but it is why the options are
 * asserted via `findByRole('option')` rather than a desktop-popover
 * selector.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import * as React from 'react';
import { AsyncCombobox } from '@/components/ui/async-combobox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { UserCombobox, type Member } from '@/components/ui/user-combobox';

const CROPS: ComboboxOption[] = [
    { value: 'wheat', label: 'Wheat' },
    { value: 'barley', label: 'Barley' },
    { value: 'maize', label: 'Maize' },
];

function FieldHarness(props: {
    label?: string;
    required?: boolean;
    error?: string;
    description?: string;
    buttonProps?: React.ComponentProps<typeof Combobox>['buttonProps'];
}) {
    const [selected, setSelected] = React.useState<ComboboxOption | null>(null);
    return (
        <FormField
            label={props.label ?? 'Crop'}
            required={props.required}
            error={props.error}
            description={props.description}
        >
            <Combobox
                options={CROPS}
                selected={selected}
                setSelected={setSelected}
                placeholder="Select a crop…"
                buttonProps={props.buttonProps}
            />
        </FormField>
    );
}

/** Open the picker and choose `optionName`. */
async function selectOption(
    user: ReturnType<typeof userEvent.setup>,
    trigger: HTMLElement,
    optionName: string | RegExp,
) {
    await user.click(trigger);
    const option = await screen.findByRole('option', { name: optionName });
    await user.click(option);
}

// ─── The core regression: name stable across a selection change ──────

describe('Combobox accessible name — stability across selection', () => {
    it('takes its name from the FormField label, not the placeholder', () => {
        render(<FieldHarness />);
        expect(
            screen.getByRole('combobox', { name: 'Crop' }),
        ).toBeInTheDocument();
    });

    it('KEEPS that name after an option is selected', async () => {
        const user = userEvent.setup();
        render(<FieldHarness />);

        const before = screen.getByRole('combobox', { name: 'Crop' });
        await selectOption(user, before, 'Wheat');

        // The selection landed…
        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent('Wheat'),
        );
        // …and the NAME did not drift with it. This is the assertion
        // that fails without the aria-labelledby wiring: the name
        // becomes "Wheat".
        expect(
            screen.getByRole('combobox', { name: 'Crop' }),
        ).toBeInTheDocument();
    });

    it('conveys the selected value through the trigger content, not the name', async () => {
        const user = userEvent.setup();
        render(<FieldHarness />);

        const trigger = screen.getByRole('combobox', { name: 'Crop' });
        expect(trigger).toHaveTextContent('Select a crop…');

        await selectOption(user, trigger, 'Barley');

        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent('Barley'),
        );
        expect(screen.getByRole('combobox')).toHaveAccessibleName('Crop');
    });

    it('stays stable across a REPEATED selection change', async () => {
        const user = userEvent.setup();
        render(<FieldHarness />);

        await selectOption(
            user,
            screen.getByRole('combobox', { name: 'Crop' }),
            'Wheat',
        );
        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent('Wheat'),
        );
        await selectOption(
            user,
            screen.getByRole('combobox', { name: 'Crop' }),
            'Maize',
        );
        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent('Maize'),
        );

        expect(
            screen.getByRole('combobox', { name: 'Crop' }),
        ).toBeInTheDocument();
    });

    it('the required marker does not leak into the name', () => {
        render(<FieldHarness required />);
        // RequiredMarker is aria-hidden, so "Crop *" must not appear.
        expect(screen.getByRole('combobox')).toHaveAccessibleName('Crop');
        expect(screen.getByRole('combobox')).toHaveAttribute(
            'aria-required',
            'true',
        );
    });
});

// ─── Precedence ──────────────────────────────────────────────────────

describe('Combobox accessible name — precedence chain', () => {
    it('1. an explicit buttonProps aria-label still wins over the field label', () => {
        render(
            <FieldHarness buttonProps={{ 'aria-label': 'Primary crop' }} />,
        );
        const trigger = screen.getByRole('combobox', { name: 'Primary crop' });
        expect(trigger).toHaveAttribute('aria-label', 'Primary crop');
        // Never both: an element carrying aria-label AND an
        // aria-labelledby pointing somewhere else is ambiguous.
        expect(trigger).not.toHaveAttribute('aria-labelledby');
    });

    it('2. aria-labelledby (field label) beats the selected-text fallback', async () => {
        const user = userEvent.setup();
        render(<FieldHarness />);
        const trigger = screen.getByRole('combobox');

        expect(trigger).toHaveAttribute('aria-labelledby');
        expect(trigger).not.toHaveAttribute('aria-label');

        await selectOption(user, trigger, 'Wheat');
        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent('Wheat'),
        );
        expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-label');
    });

    it('2b. aria-labelledby points at the element holding the visible label', () => {
        render(<FieldHarness />);
        const trigger = screen.getByRole('combobox');
        const labelId = trigger.getAttribute('aria-labelledby');
        expect(labelId).toBeTruthy();
        const labelEl = document.getElementById(labelId as string);
        expect(labelEl).not.toBeNull();
        expect(labelEl).toHaveTextContent('Crop');
        // Existing FormField wiring is untouched: htmlFor still points
        // back at the trigger.
        expect(labelEl).toHaveAttribute('for', trigger.id);
    });

    it('3. the aria-label fallback survives OUTSIDE a FormField (placeholder)', () => {
        render(
            <Combobox
                id="naked-placeholder"
                options={CROPS}
                selected={null}
                setSelected={() => {}}
                placeholder="Select a crop…"
            />,
        );
        const trigger = screen.getByRole('combobox');
        expect(trigger).not.toHaveAttribute('aria-labelledby');
        expect(trigger).toHaveAttribute('aria-label', 'Select a crop…');
    });

    it('3b. the aria-label fallback survives OUTSIDE a FormField (selection)', () => {
        render(
            <Combobox
                id="naked-selected"
                options={CROPS}
                selected={CROPS[1] ?? null}
                setSelected={() => {}}
                placeholder="Select a crop…"
            />,
        );
        // Unchanged legacy behaviour — the last-resort fallback is what
        // keeps axe's button-name rule satisfied when the Button's
        // children are a ReactNode tree.
        expect(screen.getByRole('combobox')).toHaveAttribute(
            'aria-label',
            'Barley',
        );
    });

    it('a FormField with NO label leaves the fallback in charge', () => {
        render(
            <FormField description="Pick one">
                <Combobox
                    options={CROPS}
                    selected={null}
                    setSelected={() => {}}
                    placeholder="Select a crop…"
                />
            </FormField>,
        );
        const trigger = screen.getByRole('combobox');
        expect(trigger).not.toHaveAttribute('aria-labelledby');
        expect(trigger).toHaveAttribute('aria-label', 'Select a crop…');
    });

    it('a caller-supplied aria-labelledby is preserved by FormField', () => {
        render(
            <>
                <span id="external-label">External crop label</span>
                <FormField label="Crop">
                    <Combobox
                        aria-labelledby="external-label"
                        options={CROPS}
                        selected={null}
                        setSelected={() => {}}
                    />
                </FormField>
            </>,
        );
        expect(
            screen.getByRole('combobox', { name: 'External crop label' }),
        ).toBeInTheDocument();
    });
});

// ─── The other existing FormField wiring is unharmed ─────────────────

describe('Combobox inside FormField — describedby / invalid still wired', () => {
    it('keeps the aria-describedby chain and aria-invalid on error', () => {
        render(<FieldHarness error="Crop is required" />);
        const trigger = screen.getByRole('combobox', { name: 'Crop' });
        expect(trigger).toHaveAttribute('aria-invalid', 'true');
        const describedBy = trigger.getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        expect(
            document.getElementById(describedBy as string),
        ).toHaveTextContent('Crop is required');
    });

    it('keeps the description id in aria-describedby', () => {
        render(<FieldHarness description="Sown this season" />);
        const trigger = screen.getByRole('combobox', { name: 'Crop' });
        const describedBy = trigger.getAttribute('aria-describedby');
        expect(
            document.getElementById(describedBy as string),
        ).toHaveTextContent('Sown this season');
    });
});

// ─── axe ─────────────────────────────────────────────────────────────

describe('Combobox accessible name — axe', () => {
    it('a labelled field is axe-clean when closed', async () => {
        const { container } = render(<FieldHarness />);
        expect(await axe(container)).toHaveNoViolations();
    });

    it('a labelled field is axe-clean after a selection', async () => {
        const user = userEvent.setup();
        const { container } = render(<FieldHarness />);
        await selectOption(
            user,
            screen.getByRole('combobox', { name: 'Crop' }),
            'Wheat',
        );
        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent('Wheat'),
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('an explicit aria-label field is axe-clean', async () => {
        const { container } = render(
            <FieldHarness buttonProps={{ 'aria-label': 'Primary crop' }} />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });
});

// ─── The wrappers behave identically (shared-primitive uniformity) ────

const MEMBERS: Member[] = [
    { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', image: null },
    { id: 'u2', name: 'Alan Turing', email: 'alan@example.com', image: null },
];

describe('UserCombobox — same stable name', () => {
    function UserHarness() {
        const [id, setId] = React.useState<string | null>(null);
        // `useTenantMembers` runs (disabled) even with preloadedMembers,
        // so react-query still needs a client in scope.
        const [client] = React.useState(
            () =>
                new QueryClient({
                    defaultOptions: { queries: { retry: false } },
                }),
        );
        return (
            <QueryClientProvider client={client}>
            <FormField label="Assignee">
                <UserCombobox
                    tenantSlug="acme"
                    preloadedMembers={MEMBERS}
                    selectedId={id}
                    onChange={(next) => setId(next)}
                />
            </FormField>
            </QueryClientProvider>
        );
    }

    it('names the trigger from the field label before and after selection', async () => {
        const user = userEvent.setup();
        render(<UserHarness />);

        const trigger = screen.getByRole('combobox', { name: 'Assignee' });
        await selectOption(user, trigger, /Ada Lovelace/);

        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent(
                'Ada Lovelace',
            ),
        );
        expect(
            screen.getByRole('combobox', { name: 'Assignee' }),
        ).toBeInTheDocument();
    });
});

describe('AsyncCombobox — same stable name', () => {
    function AsyncHarness() {
        const [value, setValue] = React.useState<string | null>(null);
        return (
            <FormField label="Warehouse">
                <AsyncCombobox
                    onSearch={async () => [
                        { value: 'w1', label: 'North store' },
                        { value: 'w2', label: 'South store' },
                    ]}
                    initialOptions={[
                        { value: 'w1', label: 'North store' },
                        { value: 'w2', label: 'South store' },
                    ]}
                    value={value}
                    onChange={(opt) => setValue(opt?.value ?? null)}
                />
            </FormField>
        );
    }

    it('names the trigger from the field label before and after selection', async () => {
        const user = userEvent.setup();
        render(<AsyncHarness />);

        const trigger = screen.getByRole('combobox', { name: 'Warehouse' });
        await selectOption(user, trigger, 'North store');

        await waitFor(() =>
            expect(screen.getByRole('combobox')).toHaveTextContent(
                'North store',
            ),
        );
        expect(
            screen.getByRole('combobox', { name: 'Warehouse' }),
        ).toBeInTheDocument();
    });
});

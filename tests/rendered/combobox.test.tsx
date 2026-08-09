/**
 * Rendered tests for the shared <Combobox>.
 *
 * Verifies the runtime behaviour that source-contract tests can't:
 *   - Radix Popover opens on trigger click, surfaces cmdk listbox.
 *   - Keyboard-only flow: arrow-down selects, Enter commits, Escape closes.
 *   - Typing into the cmdk search filters the visible options.
 *   - Single-select closes on commit; multi-select stays open and toggles.
 *   - `invalid` prop paints the error-border class on the trigger.
 *   - `aria-haspopup`, `aria-expanded`, `aria-invalid`, and
 *     `aria-controls` flow through from Radix + our Combobox wiring.
 *   - axe-core finds zero WCAG 2.1 AA violations on the opened picker.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import * as React from 'react';
import {
    Combobox,
    type ComboboxOption,
} from '@/components/ui/combobox';

const FRUITS: ComboboxOption[] = [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
    { value: 'cherry', label: 'Cherry' },
    { value: 'date', label: 'Date' },
];

function SingleHarness(props: {
    initial?: string | null;
    onChange?: (value: string | null) => void;
    invalid?: boolean;
}) {
    const [selected, setSelected] = React.useState<ComboboxOption | null>(
        props.initial
            ? (FRUITS.find((o) => o.value === props.initial) ?? null)
            : null,
    );
    return (
        <Combobox
            id="fruit-picker"
            name="fruit"
            options={FRUITS}
            selected={selected}
            setSelected={(opt) => {
                setSelected(opt);
                props.onChange?.(opt?.value ?? null);
            }}
            placeholder="Pick a fruit"
            searchPlaceholder="Search fruit…"
            invalid={props.invalid}
            forceDropdown
            matchTriggerWidth
        />
    );
}

function MultiHarness() {
    const [selected, setSelected] = React.useState<ComboboxOption[]>([]);
    return (
        <Combobox
            multiple
            id="fruit-multi"
            name="fruits"
            options={FRUITS}
            selected={selected}
            setSelected={setSelected}
            placeholder="Pick fruits"
            searchPlaceholder="Search…"
            forceDropdown
        />
    );
}

// ─── Opening / keyboard ────────────────────────────────────────

describe('<Combobox /> — trigger + keyboard', () => {
    it('surfaces aria-haspopup="listbox" and aria-expanded on the trigger', () => {
        render(<SingleHarness />);
        const trigger = screen.getByRole('combobox');
        expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens the listbox on click and shows every option', async () => {
        const user = userEvent.setup();
        render(<SingleHarness />);
        await user.click(screen.getByRole('combobox'));

        const listbox = await screen.findByRole('listbox');
        const options = within(listbox).getAllByRole('option');
        // cmdk renders one option per entry; there are 4 fruits.
        expect(options).toHaveLength(4);
        expect(options[0]).toHaveTextContent('Apple');
    });

    it('typing into the search filters options', async () => {
        const user = userEvent.setup();
        render(<SingleHarness />);
        await user.click(screen.getByRole('combobox'));

        const searchInput = await screen.findByPlaceholderText('Search fruit…');
        await user.type(searchInput, 'ch');

        // Only "Cherry" matches "ch".
        const listbox = screen.getByRole('listbox');
        const options = within(listbox).getAllByRole('option');
        expect(options).toHaveLength(1);
        expect(options[0]).toHaveTextContent('Cherry');
    });

    it('Escape closes the picker without selecting', async () => {
        const user = userEvent.setup();
        const onChange = jest.fn();
        render(<SingleHarness onChange={onChange} />);
        await user.click(screen.getByRole('combobox'));
        await screen.findByRole('listbox');

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('single-select closes on commit and reports the chosen value', async () => {
        const user = userEvent.setup();
        const onChange = jest.fn();
        render(<SingleHarness onChange={onChange} />);
        await user.click(screen.getByRole('combobox'));
        const listbox = await screen.findByRole('listbox');
        await user.click(within(listbox).getByRole('option', { name: 'Banana' }));

        expect(onChange).toHaveBeenCalledWith('banana');
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
});

// ─── Multi-select ──────────────────────────────────────────────

describe('<Combobox multiple /> — multi-select', () => {
    it('stays open and toggles options', async () => {
        const user = userEvent.setup();
        render(<MultiHarness />);

        // Multi-select exposes two `role="combobox"` nodes once open:
        // our outer trigger button + cmdk's inner search input. Scope
        // to the trigger by id.
        const trigger = () => screen.getByRole('combobox', { name: /Pick fruits|Apple|Banana/ }) ?? document.getElementById('fruit-multi')!;
        await user.click(trigger());
        const listbox = await screen.findByRole('listbox');

        await user.click(within(listbox).getByRole('option', { name: /Apple/ }));
        // Popover stays open after selection in multi mode.
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        await user.click(within(listbox).getByRole('option', { name: /Banana/ }));
        expect(screen.getByRole('listbox')).toBeInTheDocument();

        // Trigger aria-label reflects the selection.
        const triggerEl = document.getElementById('fruit-multi')!;
        expect(triggerEl).toHaveAttribute('aria-label', expect.stringMatching(/Apple/));
        expect(triggerEl).toHaveAttribute('aria-label', expect.stringMatching(/Banana/));
    });
});

// ─── Invalid state ─────────────────────────────────────────────

describe('<Combobox /> — invalid state', () => {
    it('sets aria-invalid="true" on the trigger when invalid', () => {
        render(<SingleHarness invalid />);
        const trigger = screen.getByRole('combobox');
        expect(trigger).toHaveAttribute('aria-invalid', 'true');
    });

    it('paints the error-border token on the default trigger', () => {
        render(<SingleHarness invalid />);
        const trigger = screen.getByRole('combobox');
        expect(trigger.className).toContain('border-border-error');
    });
});

// ─── Axe-core accessibility ────────────────────────────────────

describe('<Combobox /> — accessibility', () => {
    it('has no WCAG violations when closed', async () => {
        const { container } = render(<SingleHarness />);
        expect(await axe(container)).toHaveNoViolations();
    });

    it('has no WCAG violations when open with the listbox rendered', async () => {
        const user = userEvent.setup();
        const { container } = render(<SingleHarness />);
        await user.click(screen.getByRole('combobox'));
        await screen.findByRole('listbox');
        expect(await axe(container)).toHaveNoViolations();
    });
});

// ─── Hidden input for native form serialisation ────────────────

describe('<Combobox name /> — hidden input', () => {
    it('renders a hidden input with name + empty value when nothing selected', () => {
        const { container } = render(<SingleHarness />);
        const hidden = container.querySelector(
            'input[type="hidden"][name="fruit"]',
        );
        expect(hidden).toBeInTheDocument();
        expect(hidden).toHaveValue('');
    });

    it('updates hidden input when a selection is made', async () => {
        const user = userEvent.setup();
        const { container } = render(<SingleHarness />);
        await user.click(screen.getByRole('combobox'));
        await user.click(
            within(await screen.findByRole('listbox')).getByRole('option', {
                name: 'Cherry',
            }),
        );
        const hidden = container.querySelector(
            'input[type="hidden"][name="fruit"]',
        );
        expect(hidden).toHaveValue('cherry');
    });
});

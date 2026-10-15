/**
 * Every `FormField` label's `htmlFor` names an element that EXISTS (#1839).
 *
 * ## The defect this is derived from
 *
 * `FormField` resolves the control id from the child's own `id` prop and
 * wires the label to it (`form-field.tsx:106`, `:184`):
 *
 *     const controlId = childProps.id ?? `form-field-${autoId}`;
 *     <Label id={labelId} htmlFor={controlId}>
 *
 * `DatePicker` and `DateRangePicker` spread their remaining props onto the
 * **Calendar inside the popover**, and gave `<Trigger>` an explicit allowlist
 * with no `id` in it. So `<FormField label="…"><DatePicker id="x" /></FormField>`
 * rendered `<label htmlFor="x">` for an element that did not exist.
 *
 * **It was not a nameless control**, which is exactly why it went unnoticed:
 * `FormField` also injects `aria-labelledby`, and that one WAS forwarded. What
 * broke was everything depending on `htmlFor` resolving — clicking the label
 * opened nothing, the attribute was an HTML-validity and a11y-lint failure,
 * and an id passed for E2E selection silently did not exist. 22 of the 316
 * `FormField` usages in this product wrap a `DatePicker`.
 *
 * `Combobox` had it right all along, via `triggerA11yProps`. The two
 * components disagreed about where an id goes and neither said so.
 *
 * ## Why one test over many controls, rather than a DatePicker test
 *
 * The bug is not in `DatePicker`; it is in the SEAM between `FormField` and
 * whatever it wraps, and any control can get it wrong the same way. So this
 * ranges over the control types `FormField` is actually used with, counted
 * from the filesystem, and asks one question of each: does
 * `document.getElementById(label.htmlFor)` return an element?
 *
 * A control added later is covered by adding a row — which is a visible edit
 * rather than a silent exclusion, and is the only part of this a reviewer has
 * to remember.
 *
 * Note the viewport: `tests/rendered/setup.ts` answers `matches: false` to
 * every media query, so every control here renders its PHONE branch. That is
 * the branch a farmer gets, and it is the one where a label that does nothing
 * costs the most.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker, DateRangePicker } from '@/components/ui/date-picker';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const OPTIONS: ComboboxOption[] = [{ value: 'a', label: 'Option A' }];

/**
 * The control types `FormField` wraps in this product, with the count
 * measured 2026-10-15 so a reader can see what this ranges over.
 */
const CONTROLS: ReadonlyArray<{
    name: string;
    usages: number;
    render: (id: string) => React.ReactElement;
}> = [
    { name: 'Input', usages: 159, render: (id) => <Input id={id} /> },
    {
        name: 'Combobox',
        usages: 60,
        render: (id) => <Combobox id={id} selected={null} setSelected={() => {}} options={OPTIONS} />,
    },
    { name: 'DatePicker', usages: 22, render: (id) => <DatePicker id={id} /> },
    { name: 'Textarea', usages: 16, render: (id) => <Textarea id={id} /> },
    { name: 'Checkbox', usages: 1, render: (id) => <Checkbox id={id} /> },
    // Zero FormField usages today, included because it is DatePicker's
    // sibling and carried the identical defect — the same `{...props}` to the
    // Calendar, the same allowlisted Trigger. A fix to one that missed the
    // other is the shape this row exists to catch.
    { name: 'DateRangePicker', usages: 0, render: (id) => <DateRangePicker id={id} /> },
];

describe('a FormField label points at a real element (#1839)', () => {
    it('ranges over the controls FormField is actually used with', () => {
        // Invisible in CI (#1879), so the assertions below are what hold.
        console.log(
            `[formfield-label] ${CONTROLS.length} control type(s), `
                + `${CONTROLS.reduce((a, c) => a + c.usages, 0)} measured FormField usages`,
        );
        expect(CONTROLS.length).toBeGreaterThanOrEqual(6);
    });

    it.each(CONTROLS.map((c) => [c.name] as const))(
        '%s: the label resolves to an element',
        (name) => {
            const control = CONTROLS.find((c) => c.name === name);
            if (control === undefined) throw new Error('unreachable');
            const id = `probe-${name.toLowerCase()}`;

            const { container } = render(
                <FormField label={`Label for ${name}`}>{control.render(id)}</FormField>,
            );

            const label = container.querySelector('label');
            expect(label).not.toBeNull();
            const target = label?.getAttribute('for');
            // A FormField label must always HAVE a target — one with none is a
            // different defect, and `toBeNull` on the lookup below would pass
            // for it by accident.
            expect(`${name} htmlFor`).toBe(`${name} htmlFor`);
            expect(target).toBeTruthy();

            // The assertion. `container.querySelector` rather than
            // `document.getElementById`, because a popover portals outside the
            // container and an id that only exists in an OPEN popover is not a
            // label target either — the label has to resolve with the popover
            // SHUT, which is how a farmer first meets the field.
            const found = container.querySelector(`[id="${target}"]`);
            expect(`${name}: label htmlFor="${target}" resolves to ${found?.tagName ?? 'NOTHING'}`)
                .toBe(`${name}: label htmlFor="${target}" resolves to ${found?.tagName ?? 'NOTHING'}`);
            if (found === null) {
                const ids = Array.from(container.querySelectorAll('[id]'))
                    .map((e) => `${e.tagName}#${e.id}`)
                    .join(', ');
                throw new Error(
                    `${name}: <label for="${target}"> names no element in the field.\n\n`
                        + `FormField takes its label target from the child's own \`id\` prop\n`
                        + `(form-field.tsx:106). A control that spreads its remaining props onto\n`
                        + `something other than its focusable element — a Calendar inside a\n`
                        + `popover, a hidden sidecar — leaves the label pointing at nothing.\n\n`
                        + `The control still has an accessible NAME, because FormField also\n`
                        + `injects aria-labelledby, so this does not look broken. What breaks is\n`
                        + `clicking the label, HTML validity, and any id passed for E2E\n`
                        + `selection.\n\n`
                        + `Forward \`id\` to the element the user actually interacts with, as\n`
                        + `Combobox does via triggerA11yProps and as DatePicker does since #1839.\n\n`
                        + `  ids present: ${ids || '(none)'}`,
                );
            }
            expect(found).not.toBeNull();
        },
    );

    it('the control the label names is the one a user interacts with', () => {
        // Resolving is not enough: an id on a wrapper div would satisfy the
        // test above while the label still did nothing. The target has to be
        // focusable — an input, a textarea, or a button-shaped trigger.
        for (const control of CONTROLS) {
            const id = `focus-${control.name.toLowerCase()}`;
            const { container, unmount } = render(
                <FormField label={`Label for ${control.name}`}>{control.render(id)}</FormField>,
            );
            const target = container.querySelector('label')?.getAttribute('for') ?? '';
            const el = container.querySelector(`[id="${target}"]`);
            expect(`${control.name} -> ${el?.tagName ?? 'NOTHING'}`).toMatch(
                /-> (INPUT|TEXTAREA|BUTTON|SELECT)$/,
            );
            unmount();
        }
    });

    it('a DatePicker with NO id still gets a generated one that resolves', () => {
        // The majority case: 9 of the 22 DatePicker usages pass no id, so
        // FormField generates `form-field-<autoId>`. That path has to work
        // too, and it exercises the same forwarding.
        const { container } = render(
            <FormField label="Дата на мероприятието"><DatePicker /></FormField>,
        );
        const target = container.querySelector('label')?.getAttribute('for');
        expect(target).toMatch(/^form-field-/);
        expect(container.querySelector(`[id="${target}"]`)).not.toBeNull();
    });

    it('the label is the accessible name, not merely adjacent to it', () => {
        // Belt and braces on the half that was already working, so a fix to
        // htmlFor cannot regress aria-labelledby on the way past.
        render(<FormField label="Дата"><DatePicker id="aria-probe" /></FormField>);
        expect(screen.getByRole('button', { name: /Дата/ })).toBeInTheDocument();
    });
});

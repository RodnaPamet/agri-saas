/**
 * Rendered tests for the FormField + FormError validation flow
 * (Epic 55 finishing pass).
 *
 * The source-contract ratchet verifies which surfaces *import and use*
 * the primitives. This test verifies the runtime contract a user with
 * a screen reader actually hears: touched-but-empty field surfaces a
 * `role="alert"` error message that is linked to the control via
 * `aria-describedby`, and correcting the value hides the error.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import * as React from 'react';
import { FormField } from '@/components/ui/form-field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';

function Harness() {
    const [value, setValue] = React.useState('');
    const [touched, setTouched] = React.useState(false);
    const invalid = touched && value.trim().length === 0;

    return (
        <form onSubmit={(e) => e.preventDefault()}>
            <FormField
                label="Name"
                required
                error={invalid ? 'Name is required.' : undefined}
            >
                <Input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onBlur={() => setTouched(true)}
                />
            </FormField>
            <button type="submit">Submit</button>
        </form>
    );
}

describe('<FormField /> — touched-state validation', () => {
    it('does not render an error before the field is touched', () => {
        render(<Harness />);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        const input = screen.getByRole('textbox', { name: 'Name' });
        expect(input).not.toHaveAttribute('aria-invalid', 'true');
    });

    it('renders an error after blurring an empty required field', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const input = screen.getByRole('textbox', { name: 'Name' });
        await user.click(input);
        await user.tab();

        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Name is required.');
        expect(alert).toHaveAttribute('aria-live', 'polite');

        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(input.getAttribute('aria-describedby') ?? '').toContain(
            alert.id,
        );
    });

    it('clears the error once the field has a non-empty value', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const input = screen.getByRole('textbox', { name: 'Name' });

        await user.click(input);
        await user.tab();
        expect(screen.getByRole('alert')).toBeInTheDocument();

        await user.type(input, 'Alice');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(input).not.toHaveAttribute('aria-invalid', 'true');
    });

    it('passes axe in both valid and error states', async () => {
        const { container, rerender } = render(
            <FormField label="Email" required>
                <Input type="email" defaultValue="alice@example.com" />
            </FormField>,
        );
        expect(await axe(container)).toHaveNoViolations();

        rerender(
            <FormField label="Email" required error="Email is required.">
                <Input type="email" defaultValue="" />
            </FormField>,
        );
        expect(await axe(container)).toHaveNoViolations();
    });
});

// ─── Standalone FormError ──────────────────────────────────────────

describe('<FormError /> — standalone alert semantics', () => {
    it('polite alert announces the message', () => {
        render(<FormError>Operation failed.</FormError>);
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Operation failed.');
        expect(alert).toHaveAttribute('aria-live', 'polite');
    });

    it('renders nothing for empty content — avoids announcing silence', () => {
        const { container } = render(<FormError>{''}</FormError>);
        expect(container.firstChild).toBeNull();
    });

    it('visible=false suppresses render even with children', () => {
        const { container } = render(
            <FormError visible={false}>Hidden</FormError>,
        );
        expect(container.firstChild).toBeNull();
    });

    it('preserves caller-supplied id for aria-describedby chaining', () => {
        render(<FormError id="my-error">Boom</FormError>);
        expect(screen.getByRole('alert')).toHaveAttribute('id', 'my-error');
    });

    it('toggling visibility mid-render flips between rendered and empty', async () => {
        function Toggle() {
            const [visible, setVisible] = React.useState(false);
            return (
                <>
                    <button onClick={() => setVisible((v) => !v)}>toggle</button>
                    <FormError visible={visible}>Failed</FormError>
                </>
            );
        }
        const user = userEvent.setup();
        render(<Toggle />);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'toggle' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Failed');
    });
});

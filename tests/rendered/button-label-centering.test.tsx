/**
 * Button label-centering behavioural lock.
 *
 * User report (2026-05-31): button-styled practices rendered their
 * label off-centre / untidy. The fix has two parts (see
 * docs/implementation-notes/2026-05-31-button-clean-fill-centering.md):
 *
 *   1. The iridescent `::after` edge (a separate bug) was filling the
 *      whole button and washing out the label; fixed in
 *      button-variants.ts so the fill is clean.
 *   2. Centring: the button centres its WHOLE content unit
 *      `[icon][gap][label]` via `justify-center` + hug-content, with
 *      NO balance ghosts. So `+ Asset` reads as a tidy centred unit
 *      (the `+` counted with the word). An earlier ghost approach
 *      (which centred the label alone and padded the opposite edge)
 *      was reverted on user feedback.
 *
 * jsdom has no layout engine, so this test cannot measure pixel
 * centring. It locks the MECHANISM: the content unit is the only flow
 * group (no invisible balance-ghost spans), the layout is
 * justify-center, and the one intentional exception (shortcut buttons,
 * label-left/kbd-right) still behaves.
 *
 * Static companion: tests/guards/button-label-centering.test.ts.
 */
import * as React from 'react';
import { render } from '@testing-library/react';
import { Button } from '@/components/ui/button';

const Dot = () => <span data-x-dot className="size-4 rounded-full" />;

describe('Button label centering — centred content unit, no ghosts', () => {
    test('no balance-ghost spans are ever rendered', () => {
        // Thunks (not an array of JSX literals) so react/jsx-key
        // doesn't demand keys on test fixtures.
        const cases = [
            () => <Button>Mark Test Completed</Button>,
            () => <Button icon={<Dot />}>Asset</Button>,
            () => <Button right={<Dot />}>Save changes</Button>,
            () => (
                <Button icon={<Dot />} right={<Dot />}>
                    Both
                </Button>
            ),
        ];
        for (const mk of cases) {
            const { container, unmount } = render(mk());
            expect(
                container.querySelector('[data-icon-balance-ghost]'),
            ).toBeNull();
            expect(
                container.querySelector('[data-right-balance-ghost]'),
            ).toBeNull();
            unmount();
        }
    });

    test('text-only button: label is the only flow child, centred', () => {
        const { container } = render(<Button>Resolve overdue tasks</Button>);
        const btn = container.querySelector('button')!;
        // tailwind-merge keeps the last `justify-*`; justify-center
        // present here means no override defeated the centred layout.
        expect(btn.className).toMatch(/justify-center/);
        const flowKids = Array.from(btn.children);
        expect(flowKids).toHaveLength(1);
        expect(flowKids[0].textContent).toBe('Resolve overdue tasks');
    });

    test('icon + label: the unit is [icon, label] with nothing trailing', () => {
        const { container } = render(<Button icon={<Dot />}>Asset</Button>);
        const btn = container.querySelector('button')!;
        const kids = Array.from(btn.children);
        // Exactly two flow children: the icon, then the label wrapper.
        // No trailing ghost padding the right edge.
        expect(kids).toHaveLength(2);
        // The icon renders directly as the first flow child (it IS the
        // dot span, not a wrapper around it).
        expect(kids[0].hasAttribute('data-x-dot')).toBe(true);
        expect(kids[1].textContent).toBe('Asset');
    });

    test('shortcut button: intentionally NOT centred (label left, kbd right)', () => {
        const { container } = render(<Button shortcut="K">Command</Button>);
        const labelWrapper = Array.from(
            container.querySelectorAll('button > div'),
        ).find((d) => d.textContent === 'Command');
        expect(labelWrapper).toBeTruthy();
        expect(labelWrapper!.className).toMatch(/text-left/);
        expect(labelWrapper!.className).toMatch(/flex-1/);
    });

    test('icon-only button (no content): just the icon, centred', () => {
        const { container } = render(
            <Button icon={<Dot />} aria-label="Settings" />,
        );
        const btn = container.querySelector('button')!;
        expect(btn.className).toMatch(/justify-center/);
        expect(Array.from(btn.children)).toHaveLength(1);
        expect(btn.querySelector('[data-x-dot]')).not.toBeNull();
    });
});

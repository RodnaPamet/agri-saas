/**
 * Tests for CopyButton, CopyText, and Badge (Epic 56).
 *
 * The jsdom test project stubs `@/components/ui/tooltip` via relative-path
 * mocks, so the CopyButton / CopyText tooltip wrappers appear as simple
 * pass-throughs in the tree. Tooltip behavior has its own test.
 *
 * Sonner is mocked so we can assert the toast surface without spinning up
 * its DOM host.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

const toastMock = {
    success: jest.fn(),
    error: jest.fn(),
};
jest.mock('sonner', () => ({
    toast: toastMock,
    Toaster: () => null,
}));

import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { CopyText } from '@/components/ui/copy-text';

const realClipboard = Object.getOwnPropertyDescriptor(
    window.navigator,
    'clipboard',
);

/**
 * Install a clipboard mock AFTER calling `userEvent.setup()` — user-event
 * installs its own clipboard stub during setup (see
 * `@testing-library/user-event/.../attachClipboardStubToView`), so any
 * clipboard mock must be written onto `window.navigator` after the
 * session is created to take precedence.
 */
function mockClipboard(impl: {
    writeText?: (value: string) => Promise<void>;
} | null) {
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: impl,
    });
}

function setupUserWithClipboard(writeText: jest.Mock) {
    const user = userEvent.setup();
    mockClipboard({ writeText });
    return user;
}

beforeEach(() => {
    toastMock.success.mockClear();
    toastMock.error.mockClear();
});

afterEach(() => {
    if (realClipboard) {
        Object.defineProperty(window.navigator, 'clipboard', realClipboard);
    } else {
        // @ts-expect-error: jsdom-only cleanup of ad-hoc descriptor
        delete window.navigator.clipboard;
    }
});

describe('CopyButton', () => {
    it('copies on click, flips the icon, and fires the success toast', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = setupUserWithClipboard(writeText);
        const onCopy = jest.fn();

        render(
            <CopyButton
                value="org_abc123"
                label="Copy tenant id"
                onCopy={onCopy}
            />,
        );

        const button = screen.getByRole('button', { name: 'Copy tenant id' });
        expect(button.getAttribute('data-copied')).toBeNull();

        await user.click(button);

        expect(writeText).toHaveBeenCalledWith('org_abc123');
        expect(onCopy).toHaveBeenCalledWith('org_abc123');
        expect(toastMock.success).toHaveBeenCalledWith('Copy tenant id copied');
        expect(button).toHaveAttribute('data-copied', 'true');
    });

    it('fires the error toast and does not call onCopy when the write fails', async () => {
        const writeText = jest.fn().mockRejectedValue(new Error('denied'));
        const user = setupUserWithClipboard(writeText);
        const onCopy = jest.fn();

        render(
            <CopyButton
                value="org_abc123"
                label="Copy tenant id"
                onCopy={onCopy}
            />,
        );

        await user.click(
            screen.getByRole('button', { name: 'Copy tenant id' }),
        );

        expect(onCopy).not.toHaveBeenCalled();
        expect(toastMock.success).not.toHaveBeenCalled();
        expect(toastMock.error).toHaveBeenCalledWith('Copy failed');
    });

    it('does not copy or toast when disabled', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = setupUserWithClipboard(writeText);

        render(<CopyButton value="v" label="Copy value" disabled />);

        const button = screen.getByRole('button', { name: 'Copy value' });
        expect(button).toBeDisabled();
        await user.click(button);

        expect(writeText).not.toHaveBeenCalled();
        expect(toastMock.success).not.toHaveBeenCalled();
    });

    it('stops propagation so parent row handlers do not fire', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = setupUserWithClipboard(writeText);
        const onRowClick = jest.fn();

        render(
            <div onClick={onRowClick}>
                <CopyButton value="v" label="Copy" />
            </div>,
        );

        await user.click(screen.getByRole('button', { name: 'Copy' }));
        expect(writeText).toHaveBeenCalled();
        expect(onRowClick).not.toHaveBeenCalled();
    });
});

describe('CopyText', () => {
    it('renders children and copies the `value` prop on click', async () => {
        const writeText = jest.fn().mockResolvedValue(undefined);
        const user = setupUserWithClipboard(writeText);

        render(
            <CopyText value="full-secret-xyz" label="Copy enrollment secret">
                •••••xyz
            </CopyText>,
        );

        // The displayed children and the copied value differ — this is the
        // masking pattern for sensitive secrets.
        const button = screen.getByRole('button', {
            name: 'Copy enrollment secret',
        });
        expect(button).toHaveTextContent('•••••xyz');

        await user.click(button);
        expect(writeText).toHaveBeenCalledWith('full-secret-xyz');
        expect(toastMock.success).toHaveBeenCalledWith(
            'Copy enrollment secret copied',
        );
    });

    it('falls back to rendering `value` when no children are supplied', () => {
        mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
        render(<CopyText value="org_abc" />);
        expect(
            screen.getByRole('button', { name: 'Copy' }),
        ).toHaveTextContent('org_abc');
    });

    it('disabled state blocks copy and removes the copy affordance', async () => {
        const writeText = jest.fn();
        const user = setupUserWithClipboard(writeText);

        render(
            <CopyText value="v" label="Copy" disabled>
                masked
            </CopyText>,
        );
        await user.click(screen.getByRole('button', { name: 'Copy' }));
        expect(writeText).not.toHaveBeenCalled();
    });
});

describe('Badge', () => {
    it('renders as a <span> with the semantic neutral class by default', () => {
        render(<Badge>Draft</Badge>);
        const badge = screen.getByText('Draft');
        expect(badge.tagName).toBe('SPAN');
        expect(badge).toHaveClass('bg-bg-subtle');
        expect(badge).toHaveClass('text-content-muted');
    });

    it.each([
        ['success', 'bg-bg-success', 'text-content-success'],
        ['warning', 'bg-bg-warning', 'text-content-warning'],
        ['error', 'bg-bg-error', 'text-content-error'],
        ['info', 'bg-bg-info', 'text-content-info'],
        ['attention', 'bg-bg-attention', 'text-content-attention'],
        // `text-brand-default`, not `text-brand-muted` (#1331): muted on
        // brand-subtle measured 1.76:1 in light and 1.88:1 in «Слънце»,
        // against 4.5:1. brand-default is the one brand token clearing it
        // in all three themes.
        ['brand', 'bg-brand-subtle', 'text-brand-default'],
    ] as const)(
        'applies the %s variant token classes',
        (variant, bgClass, textClass) => {
            render(<Badge variant={variant}>x</Badge>);
            const badge = screen.getByText('x');
            expect(badge).toHaveClass(bgClass);
            expect(badge).toHaveClass(textClass);
        },
    );

    it('applies size classes and preserves caller-supplied className', () => {
        render(
            <Badge variant="info" size="sm" className="uppercase">
                New
            </Badge>,
        );
        const badge = screen.getByText('New');
        expect(badge.className).toMatch(/text-\[10px\]/);
        expect(badge).toHaveClass('uppercase');
    });

    it('outline variant uses a transparent background with a border', () => {
        render(<Badge variant="outline">Tag</Badge>);
        const badge = screen.getByText('Tag');
        expect(badge.className).toContain('border');
        expect(badge.className).toContain('bg-transparent');
    });
});

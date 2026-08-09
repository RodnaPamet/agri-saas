/** @jest-environment jsdom */

/**
 * Rendered (Tier-2) test — `<InitialsAvatar>` + `getInitials`.
 *
 * The initials primitive replaced four divergent per-component
 * `initials*()` helpers. This pins the unified behaviour: the
 * tokenisation modes, the empty-input placeholder, the size
 * presets, and the decorative `aria-hidden` contract.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { InitialsAvatar, getInitials } from '@/components/ui/initials-avatar';

describe('getInitials', () => {
    it('two-word name → first + last initial', () => {
        expect(getInitials('Ada Lovelace')).toBe('AL');
    });

    it('three-word name → first + last (middle skipped)', () => {
        expect(getInitials('Ada Byron Lovelace')).toBe('AL');
    });

    it('single word → one initial', () => {
        expect(getInitials('Cher')).toBe('C');
    });

    it('slug mode tokenises on hyphen and underscore', () => {
        expect(getInitials('acme-corp', 'slug')).toBe('AC');
        expect(getInitials('big_co', 'slug')).toBe('BC');
    });

    it('name mode does NOT split a hyphenated slug', () => {
        expect(getInitials('acme-corp')).toBe('A');
    });

    it('empty / whitespace / null / undefined → placeholder', () => {
        expect(getInitials('')).toBe('·');
        expect(getInitials('   ')).toBe('·');
        expect(getInitials(null)).toBe('·');
        expect(getInitials(undefined)).toBe('·');
    });
});

describe('<InitialsAvatar>', () => {
    it('renders the derived initials (name mode)', () => {
        render(<InitialsAvatar value="Ada Lovelace" />);
        expect(screen.getByText('AL')).toBeInTheDocument();
    });

    it('renders slug initials in slug mode', () => {
        render(<InitialsAvatar value="acme-corp" mode="slug" />);
        expect(screen.getByText('AC')).toBeInTheDocument();
    });

    it('is decorative — aria-hidden, so the parent practice owns the label', () => {
        const { container } = render(<InitialsAvatar value="Ada Lovelace" />);
        expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('size presets resolve to distinct dimension classes', () => {
        const sm = render(<InitialsAvatar value="X" size="sm" />);
        const md = render(<InitialsAvatar value="X" size="md" />);
        const lg = render(<InitialsAvatar value="X" size="lg" />);
        expect((sm.container.firstChild as HTMLElement).className).toContain('h-5');
        expect((md.container.firstChild as HTMLElement).className).toContain('h-8');
        // `lg` — the account-profile preview size (avatar roadmap P3).
        expect((lg.container.firstChild as HTMLElement).className).toContain('h-16');
    });
});

describe('<InitialsAvatar> — image-backed (avatar roadmap P2)', () => {
    it('renders no <img> when imageUrl is absent — initials only', () => {
        render(<InitialsAvatar value="Ada Lovelace" />);
        expect(screen.queryByTestId('initials-avatar-image')).toBeNull();
        expect(screen.getByText('AL')).toBeInTheDocument();
    });

    it('renders the image at the supplied URL when imageUrl is given', () => {
        render(
            <InitialsAvatar
                value="Ada Lovelace"
                imageUrl="https://cdn.example.com/ada.jpg"
            />,
        );
        const img = screen.getByTestId('initials-avatar-image');
        expect(img).toHaveAttribute('src', 'https://cdn.example.com/ada.jpg');
        // Initials stay in the DOM underneath as the fallback layer.
        expect(screen.getByText('AL')).toBeInTheDocument();
    });

    it('falls back to initials when the image fails to load', () => {
        render(
            <InitialsAvatar
                value="Ada Lovelace"
                imageUrl="https://cdn.example.com/broken.jpg"
            />,
        );
        const img = screen.getByTestId('initials-avatar-image');
        // Simulate a load failure → the <img> is dropped, never a
        // broken-image glyph; the initials beneath carry through.
        fireEvent.error(img);
        expect(screen.queryByTestId('initials-avatar-image')).toBeNull();
        expect(screen.getByText('AL')).toBeInTheDocument();
    });

    it('a null imageUrl is treated as initials-only', () => {
        render(<InitialsAvatar value="Cher" imageUrl={null} />);
        expect(screen.queryByTestId('initials-avatar-image')).toBeNull();
        expect(screen.getByText('C')).toBeInTheDocument();
    });
});

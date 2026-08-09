/** @jest-environment jsdom */

/**
 * Rendered (Tier-2) test — `<AvatarUploadField>` (avatar roadmap P3).
 *
 * Pins the account-profile avatar practice's affordances and the
 * remove flow. The upload path runs through `createImageBitmap` +
 * `canvas.toBlob`, which jsdom does not implement — that path is
 * E2E-shaped and verified there, not here.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

jest.mock('next-intl', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require('../../messages/en.json');
    const get = (p: string): unknown =>
        p.split('.').reduce<unknown>(
            (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
            en,
        );
    return {
        useTranslations:
            (ns?: string) =>
            (key: string, values?: Record<string, unknown>) => {
                const full = ns ? `${ns}.${key}` : key;
                const msg = get(full);
                if (typeof msg !== 'string') return full;
                return msg.replace(/\{(\w+)\}/g, (_, k) =>
                    values?.[k] != null ? String(values[k]) : `{${k}}`,
                );
            },
    };
});

import { AvatarUploadField } from '@/app/account/profile/AvatarUploadField';

const originalFetch = global.fetch;

describe('<AvatarUploadField>', () => {
    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('with no avatar — shows the upload affordance, no Remove, the metadata note', () => {
        render(
            <AvatarUploadField
                name="Ada Lovelace"
                email="ada@example.com"
                initialImage={null}
            />,
        );
        expect(screen.getByTestId('avatar-upload-field')).toBeInTheDocument();
        expect(
            screen.getByRole('button', { name: /upload photo/i }),
        ).toBeInTheDocument();
        // No image → no Remove button.
        expect(
            screen.queryByRole('button', { name: /^remove$/i }),
        ).toBeNull();
        // The privacy note about client-side EXIF stripping is present.
        expect(screen.getByText(/metadata/i)).toBeInTheDocument();
        // Initials render as the fallback identity.
        expect(screen.getByText('AL')).toBeInTheDocument();
    });

    it('with an avatar — shows Change + Remove; Remove DELETEs and clears', async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true }),
        } as Response);
        global.fetch = fetchMock as typeof global.fetch;

        render(
            <AvatarUploadField
                name="Ada Lovelace"
                email="ada@example.com"
                initialImage="/api/account/avatar/u1"
            />,
        );
        expect(
            screen.getByRole('button', { name: /change photo/i }),
        ).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /^remove$/i }));

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                '/api/account/avatar',
                expect.objectContaining({ method: 'DELETE' }),
            );
        });
        // After removal the Remove button is gone and the trigger
        // reverts to "Upload photo".
        await waitFor(() => {
            expect(
                screen.queryByRole('button', { name: /^remove$/i }),
            ).toBeNull();
        });
        expect(
            screen.getByRole('button', { name: /upload photo/i }),
        ).toBeInTheDocument();
    });

    it('surfaces an error when the remove request fails', async () => {
        const user = userEvent.setup();
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            json: async () => ({}),
        } as Response) as typeof global.fetch;

        render(
            <AvatarUploadField
                name="Ada Lovelace"
                email="ada@example.com"
                initialImage="/api/account/avatar/u1"
            />,
        );
        await user.click(screen.getByRole('button', { name: /^remove$/i }));

        await waitFor(() => {
            expect(
                screen.getByTestId('avatar-upload-error'),
            ).toBeInTheDocument();
        });
    });
});

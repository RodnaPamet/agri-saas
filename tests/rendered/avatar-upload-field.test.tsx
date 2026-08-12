/** @jest-environment jsdom */

/**
 * Rendered (Tier-2) test — `<AvatarUploadField>` (avatar roadmap P3).
 *
 * Pins the account-profile avatar practice's affordances, the remove
 * flow, and what the user is shown when the SERVER refuses an upload.
 *
 * The upload path runs through `createImageBitmap` + `canvas.toBlob`,
 * neither of which jsdom implements, so the refusal cases below stub both
 * to reach the `fetch`. That is worth the stubbing: the server can now
 * refuse an avatar because the malware scanner found something or is
 * unreachable, and a refusal the user cannot read is a refusal they cannot
 * act on.
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

    describe('a server refusal reaches the user as a sentence', () => {
        /**
         * Make the client-side canvas round-trip work under jsdom, which
         * implements neither `createImageBitmap` nor a real 2D context.
         * Everything after it — the POST and the error rendering — is the
         * component's own code.
         */
        function stubCanvasPipeline() {
            (
                global as unknown as { createImageBitmap: unknown }
            ).createImageBitmap = jest.fn(async () => ({
                width: 800,
                height: 600,
                close: jest.fn(),
            }));
            jest.spyOn(
                HTMLCanvasElement.prototype,
                'getContext',
            ).mockReturnValue({
                drawImage: jest.fn(),
            } as unknown as CanvasRenderingContext2D);
            jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
                (cb) => cb(new Blob(['x'], { type: 'image/webp' })),
            );
        }

        async function pickAndFail(body: unknown): Promise<void> {
            stubCanvasPipeline();
            const user = userEvent.setup();
            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                json: async () => body,
            } as Response) as typeof global.fetch;

            render(
                <AvatarUploadField
                    name="Ada Lovelace"
                    email="ada@example.com"
                    initialImage={null}
                />,
            );
            await user.upload(
                screen.getByTestId('avatar-file-input'),
                new File(['bytes'], 'photo.png', { type: 'image/png' }),
            );
        }

        it('renders the scanner refusal verbatim, not "[object Object]"', async () => {
            // `withApiErrorHandling` shapes a 4xx as `{ error: { message } }`
            // — an OBJECT. The component read `payload.error` and handed it
            // to `new Error(...)`, so every refusal the server worded
            // carefully rendered as the stringified object.
            await pickAndFail({
                error: {
                    code: 'BAD_REQUEST',
                    message: 'This image was rejected by the malware scanner.',
                },
            });

            await waitFor(() => {
                expect(screen.getByTestId('avatar-upload-error')).toHaveTextContent(
                    /rejected by the malware scanner/i,
                );
            });
            expect(
                screen.getByTestId('avatar-upload-error'),
            ).not.toHaveTextContent(/object Object/i);
        });

        it('falls back to a readable message when the body carries none', async () => {
            await pickAndFail({});

            await waitFor(() => {
                expect(screen.getByTestId('avatar-upload-error')).toHaveTextContent(
                    /upload failed/i,
                );
            });
        });
    });
});

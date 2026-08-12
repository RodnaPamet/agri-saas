'use client';

/**
 * `<AvatarUploadField>` — the account-profile avatar upload practice.
 * Avatar roadmap P3.
 *
 * The picked file is resized + cover-cropped to a 256×256 WebP through
 * an offscreen `<canvas>` BEFORE upload. That round-trip does three
 * things: it bounds the upload size, it normalises the format, and —
 * because a canvas re-encode carries no metadata — it strips EXIF
 * (camera, GPS) so that data never leaves the browser. The server
 * then only has to validate + store the bytes.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { Button } from '@/components/ui/button';
import { cardVariants } from '@/components/ui/card';

const AVATAR_PX = 256;

/**
 * Resize + cover-crop `file` to a 256×256 WebP blob via an offscreen
 * canvas. Throws a user-readable error if the file is not a readable
 * image or the browser cannot encode WebP.
 */
async function toAvatarWebp(file: File): Promise<Blob> {
    const bitmap = await createImageBitmap(file).catch(() => {
        throw new Error('That file is not a readable image.');
    });
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        bitmap.close();
        throw new Error('Image processing is unavailable in this browser.');
    }
    // Cover-crop: scale so the shorter side fills the square, centre
    // the overflow.
    const scale = Math.max(
        AVATAR_PX / bitmap.width,
        AVATAR_PX / bitmap.height,
    );
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (AVATAR_PX - w) / 2, (AVATAR_PX - h) / 2, w, h);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', 0.85),
    );
    if (!blob || blob.type !== 'image/webp') {
        throw new Error('This browser could not encode the image as WebP.');
    }
    return blob;
}

/**
 * The server's refusal, as a sentence.
 *
 * `withApiErrorHandling` shapes every 4xx as `{ error: { code, message } }`
 * — an OBJECT under `error`. Reading `payload.error` directly and passing
 * it to `new Error(...)` stringifies that object, so every refusal the
 * server took care to word rendered as `[object Object]`. It mattered
 * little while the only refusals were "not a webp" (which the canvas
 * round-trip makes unreachable in practice); it matters now that the
 * scanner can refuse an upload for a reason the user has to act on.
 */
async function uploadErrorMessage(res: Response): Promise<string> {
    const payload = (await res.json().catch(() => null)) as
        | { error?: { message?: string } | string; message?: string }
        | null;
    const fromError =
        typeof payload?.error === 'string'
            ? payload.error
            : payload?.error?.message;
    return fromError || payload?.message || 'Upload failed.';
}

export interface AvatarUploadFieldProps {
    name: string | null;
    email: string | null;
    initialImage: string | null;
}

export function AvatarUploadField({
    name,
    email,
    initialImage,
}: AvatarUploadFieldProps) {
    const t = useTranslations('account.profile');
    const fileRef = useRef<HTMLInputElement>(null);
    const [image, setImage] = useState<string | null>(initialImage);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const displayValue = name || email;

    async function handlePick(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file
        if (!file) return;
        setError(null);
        setBusy(true);
        try {
            const blob = await toAvatarWebp(file);
            const body = new FormData();
            body.append('file', blob, 'avatar.webp');
            const res = await fetch('/api/account/avatar', {
                method: 'POST',
                body,
                credentials: 'same-origin',
            });
            if (!res.ok) {
                throw new Error(await uploadErrorMessage(res));
            }
            const { imageUrl } = (await res.json()) as { imageUrl: string };
            // Cache-bust the preview — the serve URL is stable, so the
            // browser would otherwise show the previous image.
            setImage(`${imageUrl}?t=${Date.now()}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed.');
        } finally {
            setBusy(false);
        }
    }

    async function handleRemove() {
        setError(null);
        setBusy(true);
        try {
            const res = await fetch('/api/account/avatar', {
                method: 'DELETE',
                credentials: 'same-origin',
            });
            if (!res.ok) throw new Error('Could not remove the photo.');
            setImage(null);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : 'Could not remove the photo.',
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            className={cn(cardVariants(), 'space-y-default')}
            data-testid="avatar-upload-field"
        >
            <div className="flex items-center gap-default">
                <InitialsAvatar
                    value={displayValue}
                    size="lg"
                    imageUrl={image}
                />
                <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-content-emphasis">
                        {name || '—'}
                    </p>
                    {email && (
                        <p className="truncate text-xs text-content-muted">
                            {email}
                        </p>
                    )}
                </div>
            </div>

            <p className="text-xs text-content-muted">
                {t('avatarNote')}
            </p>

            <div className="flex gap-tight">
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={handlePick}
                    data-testid="avatar-file-input"
                />
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                >
                    {busy
                        ? t('working')
                        : image
                          ? t('changePhoto')
                          : t('uploadPhoto')}
                </Button>
                {image && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={handleRemove}
                    >
                        {t('remove')}
                    </Button>
                )}
            </div>

            {error && (
                <p
                    className="text-xs text-content-error"
                    role="alert"
                    data-testid="avatar-upload-error"
                >
                    {error}
                </p>
            )}
        </div>
    );
}

'use client';

/**
 * Promotion artwork picker for the support console (#12).
 *
 * The canvas round-trip is the load-bearing part, and it happens BEFORE the
 * bytes leave the browser:
 *
 *   - it re-encodes to webp, which is what the server insists on — anything
 *     else means this step was bypassed;
 *   - re-encoding drops EXIF, so a supplier's camera metadata (including GPS)
 *     never reaches our storage at all;
 *   - it downscales to a bounded width, which is what keeps the result inside
 *     the 512KB server cap for realistic inputs.
 *
 * Support is uploading artwork a company emailed them, so the source is
 * arbitrary — a 12MP phone photo is a perfectly likely input. Handling that
 * here rather than server-side keeps image processing out of the request path
 * entirely (the server validates, it never decodes).
 *
 * The server still re-checks size and the webp magic number, and scans the
 * bytes. This component is ergonomics; it is not the practice.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/** Longest edge after downscale. A promotion card renders far smaller. */
const MAX_EDGE = 1200;
const WEBP_QUALITY = 0.85;

/** Decode → downscale → re-encode as webp. Returns null if the file isn't an image. */
async function toWebp(file: File): Promise<Blob | null> {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return null;

    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const gtx = canvas.getContext('2d');
    if (!gtx) return null;
    gtx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    return new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/webp', WEBP_QUALITY),
    );
}

export function PromotionImageField({
    promotionId,
    mediaUrl,
    onChange,
}: {
    /** Null while the promotion is unsaved — artwork attaches after creation. */
    promotionId: string | null;
    mediaUrl: string | null;
    onChange: (mediaUrl: string | null) => void;
}) {
    const t = useTranslations('admin.promotions');
    const buildUrl = useTenantApiUrl();
    const inputRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const pick = async (file: File) => {
        if (!promotionId) return;
        setBusy(true);
        setError(null);
        try {
            const webp = await toWebp(file);
            if (!webp) {
                setError(t('imageNotAnImage'));
                return;
            }
            const body = new FormData();
            body.append('file', new File([webp], 'promotion.webp', { type: 'image/webp' }));

            const res = await fetch(buildUrl(`/admin/promotions/${promotionId}/image`), {
                method: 'POST',
                body,
            });
            if (!res.ok) {
                const detail = await res.json().catch(() => null);
                // The server's message is the useful one here — it distinguishes
                // "too large" from "rejected by the malware scanner", and support
                // needs to know which of those happened.
                setError(detail?.error ?? t('imageUploadFailed'));
                return;
            }
            const data = (await res.json()) as { mediaUrl: string };
            onChange(data.mediaUrl);
        } catch {
            setError(t('imageUploadFailed'));
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = '';
        }
    };

    const remove = async () => {
        if (!promotionId) return;
        setBusy(true);
        try {
            await fetch(buildUrl(`/admin/promotions/${promotionId}/image`), {
                method: 'DELETE',
            });
            onChange(null);
        } finally {
            setBusy(false);
        }
    };

    if (!promotionId) {
        return <p className="text-xs text-content-muted">{t('imageAfterSave')}</p>;
    }

    return (
        <div className="space-y-tight">
            <div className="flex items-center gap-default">
                {mediaUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- streamed from our own auth-gated route
                    <img
                        src={mediaUrl}
                        alt=""
                        className="size-16 flex-shrink-0 rounded-md border border-border-subtle object-cover"
                    />
                ) : (
                    <div className="flex size-16 flex-shrink-0 items-center justify-center rounded-md border border-dashed border-border-subtle text-xs text-content-subtle">
                        {t('imageNone')}
                    </div>
                )}
                <div className="flex gap-tight">
                    <Button
                        variant="secondary"
                        size="sm"
                        id="promo-image-pick"
                        loading={busy}
                        onClick={() => inputRef.current?.click()}
                    >
                        {mediaUrl ? t('imageReplace') : t('imageUpload')}
                    </Button>
                    {mediaUrl && (
                        <Button
                            variant="destructive-outline"
                            size="sm"
                            id="promo-image-remove"
                            disabled={busy}
                            onClick={() => void remove()}
                        >
                            {t('imageRemove')}
                        </Button>
                    )}
                </div>
            </div>
            <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pick(f);
                }}
            />
            <p className="text-xs text-content-muted">{t('imageHint')}</p>
            {error && (
                <p role="alert" className="text-xs text-content-danger">
                    {error}
                </p>
            )}
        </div>
    );
}

export default PromotionImageField;

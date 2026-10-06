/**
 * Export a DOM card to a crisp PNG and offer save/share
 * (feat/delight-shareables). Reuses html-to-image (already a dependency, see
 * canvas-export.ts). Tries the native Web Share sheet with the image file
 * first (mobile — "save to Photos / send to WhatsApp"); falls back to a
 * download on desktop. Best-effort: returns false if capture/share failed so
 * the caller can surface a toast.
 */
import { toPng } from 'html-to-image';
import { toSlug } from '@/lib/bg-transliterate';

function safeFilename(label: string): string {
    // `toSlug`, not a bare [a-z0-9] strip: the latter deletes every Cyrillic
    // character, so EVERY Bulgarian label collapsed to the `card` fallback and
    // three different cards all downloaded as `card.png` — colliding in the
    // downloads folder rather than failing visibly.
    const stem = toSlug(label, 60);
    return `${stem ?? 'card'}.png`;
}

export type ShareCardResult = 'shared' | 'downloaded' | 'failed';

/** Render `el` to a 2× PNG, then share (mobile) or download (desktop). */
export async function exportShareCard(el: HTMLElement, label: string): Promise<ShareCardResult> {
    try {
        const dataUrl = await toPng(el, {
            pixelRatio: 2, // retina-crisp
            cacheBust: true,
        });
        const fileName = safeFilename(label);
        const blob = await (await fetch(dataUrl)).blob();
        const file = new File([blob], fileName, { type: 'image/png' });

        // Web Share API. Use an INTERSECTION cast (not `interface extends`)
        // so it compiles whether or not the active lib.dom declares
        // share/canShare — avoids the TS2430 conflict that bit CI when the two
        // TS lib versions disagreed.
        const nav =
            typeof navigator !== 'undefined'
                ? (navigator as Navigator & {
                      share?: (data: ShareData) => Promise<void>;
                      canShare?: (data?: ShareData) => boolean;
                  })
                : null;
        if (nav?.share && nav.canShare?.({ files: [file] })) {
            await nav.share({ files: [file], title: label });
            return 'shared';
        }

        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return 'downloaded';
    } catch {
        return 'failed';
    }
}

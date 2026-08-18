/**
 * SPIKE ONLY — the native capture bridge, kept OUT of `src/` on purpose.
 *
 * The whole question P4 asks is whether a native capture can join the EXISTING
 * outbox rather than starting a second queue. It can, and this file is the
 * proof-of-shape: a Capacitor Camera result becomes a `Blob`, and that `Blob`
 * goes through the SAME `enqueuePhoto` the web path uses.
 *
 * Deliberately NOT wired into `src/components/ui/file-upload.tsx`. Shipping
 * untested edits to a production component from a machine that cannot build or
 * run the app would be worse than shipping none: the integration point is one
 * call, and it is documented in CAMERA-RUNBOOK.md for the device session to
 * apply and verify.
 */
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { enqueuePhoto, getOutboxStore } from '@/lib/offline/outbox';

/**
 * Capture natively and queue through the existing outbox.
 *
 * Two details that make this join the existing queue rather than fork it:
 *
 *  1. `resultType: Uri` gives a `webPath` the WKWebView can `fetch()`, which is
 *     the cheapest way to a `Blob`. Base64 also works but round-trips the bytes
 *     through a JS string, which on an 8 MP photo is a real cost on an old phone.
 *  2. `width`/`quality` do the downscale NATIVELY. `EnqueuePhotoInput.blob` is
 *     documented as "the already-downscaled photo bytes", and `enqueuePhoto`
 *     throws `PhotoTooLargeError` above `MAX_QUEUED_PHOTO_BYTES` (8 MB). The web
 *     path downscales in a canvas; doing it in the native layer instead is one
 *     of the few places the shell can be genuinely faster, and P4's comparison
 *     table is where that gets measured rather than asserted.
 */
export async function captureNativeAndQueue(opts: {
    /** Same tenant-scoped multipart target the web path posts to. */
    url: string;
    label: string;
}): Promise<{ id: string; bytes: number }> {
    const photo = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        quality: 80,
        width: 2048,
        correctOrientation: true,
    });

    if (!photo.webPath) throw new Error('native capture returned no webPath');

    const blob = await (await fetch(photo.webPath)).blob();

    // THE POINT OF THE WHOLE EXERCISE: the identical call the web path makes.
    // One queue, one replay path, one `Idempotency-Key`, one drain loop.
    const item = await enqueuePhoto(getOutboxStore(), {
        url: opts.url,
        blob,
        fileName: `capture-${Date.now()}.${photo.format ?? 'jpeg'}`,
        fileType: blob.type || `image/${photo.format ?? 'jpeg'}`,
        label: opts.label,
    });

    return { id: item.id, bytes: blob.size };
}

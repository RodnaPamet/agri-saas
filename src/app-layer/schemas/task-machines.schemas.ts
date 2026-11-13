import { z } from 'zod';

/**
 * The attach request — #3026.
 *
 * `.strict()` so an unknown key is REFUSED rather than ignored. The phone sends
 * exactly `{ assetId }`, and a typo'd field name arriving as a silent no-op is
 * how a button that looks wired does nothing: the operator taps, gets a 2xx,
 * and the machine is not on the task.
 *
 * The asset id is in the BODY while the detach takes it in the path, and the
 * asymmetry is REST rather than inconsistency: a POST to a collection names the
 * member it creates in its body, and a DELETE addresses a member. Neither may
 * use a query parameter — iOS logs the full URL including the query
 * unsuppressably, and while an asset id is the farm's own equipment rather than
 * personal data, the habit is worth keeping where it costs nothing.
 */
export const AttachTaskAssetSchema = z
    .object({
        assetId: z.string().min(1, 'assetId is required'),
    })
    .strict();

export type AttachTaskAssetInput = z.infer<typeof AttachTaskAssetSchema>;

/**
 * Product-safety spec — Zod schema for the structured PESTICIDE safety
 * fields (feat/ai-evals-safety).
 *
 * These fields live UNTYPED under `Item.attributesJson.safety` for items
 * with `category = PESTICIDE`. They are the ONLY trusted source of
 * dosage / re-entry-interval (REI) / pre-harvest-interval (PHI) numbers
 * the advisory layer is allowed to surface — the LLM may phrase around
 * them but must never invent them (see `src/app-layer/ai/safety/advisor.ts`).
 *
 * Everything is OPTIONAL at the `attributesJson` level because legacy
 * items carry no `safety` block at all; the accessor
 * (`src/app-layer/repositories/product-safety.ts`) returns `null` for any
 * item that is not a PESTICIDE, has no `safety` block, or fails this
 * validation — fail-closed, never a partial/guessed spec.
 */
import { z } from 'zod';
import { httpsUrl } from '@/lib/schemas/url';

/**
 * The application-rate triple, e.g. `{ value: 2.5, unit: 'L', per: 'ha' }`
 * → "2.5 L/ha". Kept structured so the advisor can render + compare the
 * numeric value exactly (no free-text rate parsing).
 */
export const ApplicationRateSchema = z.object({
    value: z.number().positive(),
    unit: z.string().min(1).max(32),
    per: z.string().min(1).max(32),
});

export type ApplicationRate = z.infer<typeof ApplicationRateSchema>;

/**
 * The structured safety spec for a PESTICIDE item. `activeIngredient`,
 * `applicationRate`, `reEntryIntervalHours`, and `preHarvestIntervalDays`
 * are the load-bearing required fields — a `safety` block missing any of
 * them is treated as absent (the accessor returns `null`), because a
 * half-specified spec is not safe to quote from.
 */
export const PesticideSafetySpecSchema = z.object({
    activeIngredient: z.string().min(1).max(200),
    applicationRate: ApplicationRateSchema,
    /** Re-entry interval — hours before the field is safe to enter. */
    reEntryIntervalHours: z.number().nonnegative(),
    /** Pre-harvest interval — days between last application and harvest. */
    preHarvestIntervalDays: z.number().nonnegative(),
    maxApplicationsPerSeason: z.number().int().positive().optional(),
    /** EPA / label registration number — used as the citation source. */
    registrationNumber: z.string().min(1).max(120).optional(),
    labelUrl: httpsUrl().optional(),
});

export type PesticideSafetySpec = z.infer<typeof PesticideSafetySpecSchema>;

/**
 * Parse a candidate `attributesJson.safety` value into a validated
 * `PesticideSafetySpec`, or `null` when it is absent / malformed.
 * Centralised here so the accessor and the eval harness validate
 * identically.
 */
export function parsePesticideSafety(candidate: unknown): PesticideSafetySpec | null {
    if (candidate == null || typeof candidate !== 'object') return null;
    const result = PesticideSafetySpecSchema.safeParse(candidate);
    return result.success ? result.data : null;
}

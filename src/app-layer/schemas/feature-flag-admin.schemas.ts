/**
 * The flag console's request shapes — shared by BOTH consoles (#2706).
 *
 * There are two doors onto the same table and they must accept exactly the
 * same writes:
 *
 *   • `/api/admin/feature-flags` — platform-API-key gated, for scripts and for
 *     an incident where the session path is the thing that is broken.
 *   • `/api/t/{tenantSlug}/admin/feature-flags` — session gated behind
 *     `admin.manage` + `assertPlatformSupport`, which is what the «Функции»
 *     page can actually call. A browser page cannot hold the key, and shipping
 *     one would inline a platform credential into every user's bundle.
 *
 * Extracted here rather than left in the key-gated route, because two copies
 * of this schema would drift and the drift would be silent: one console
 * accepting a key the other refuses means a flag an operator can create in one
 * place and never edit in the other.
 */
import { z } from 'zod';

import { FLAG_KEY_PATTERN, FLAG_KEY_MAX_LENGTH } from '@/lib/feature-flags';

/**
 * A flag key, held to the grammar `@/lib/feature-flags` publishes.
 *
 * Imported rather than spelled here because the flag-gating guard holds every
 * social route's key to the same pattern, and a console that accepted keys the
 * guard rejects (or the reverse) would let a route ship gated on a flag nobody
 * can create. See `FLAG_KEY_PATTERN`'s docblock.
 */
export const FlagKey = z
    .string()
    .min(1)
    .max(FLAG_KEY_MAX_LENGTH)
    .regex(FLAG_KEY_PATTERN, 'keys are dotted lowercase, e.g. social.profiles');

export const UpsertFlagBody = z.object({
    key: FlagKey,
    enabled: z.boolean(),
    /**
     * Cohort names. EMPTY means "everyone, once enabled"; non-empty NARROWS.
     * Capped so one request cannot grow the row without bound — the resolver
     * reads every cohort on every request that touches flags.
     */
    cohorts: z.array(z.string().min(1).max(64)).max(20).optional(),
    description: z.string().max(500).nullable().optional(),
});

export type UpsertFlagBodyInput = z.infer<typeof UpsertFlagBody>;

/**
 * Who a notification type is addressed TO — the tenant, or the platform.
 *
 * The distinction exists because `INSURANCE_LEAD` inverts the usual direction.
 * Every other type is mail the tenant asked to receive, so the tenant's own
 * notification switch governs it. An insurance lead is mail ABOUT the tenant,
 * sent to the platform operator: the tenant is its subject, not its reader, so
 * the tenant's switch is not theirs to throw.
 *
 * ── Why this is derived from TYPE and not stored on the row ──
 *
 * `audience` began as a parameter of `enqueueEmail`, which gated the enqueue
 * correctly and then stopped existing — it was never persisted on
 * `NotificationOutbox`. `processOutbox` re-reads the tenant's settings at SEND
 * time, so a platform mail that passed the first gate was silenced at the
 * second: enqueued, then skipped on every sweep, for ever, while
 * `EmailNotificationType`'s own docblock promised it "is NOT silenced by the
 * tenant's own notification switch".
 *
 * Deriving it from the type instead of adding a column means the two gates
 * cannot disagree — the row already carries `type`, so the audience travels
 * with it for free and no migration is needed to answer the question at send
 * time.
 *
 * This was latent when written: `TenantNotificationSettings` had zero rows in
 * production, so every tenant took the `enabled: true` default and no platform
 * mail had yet been silenced. It would have bitten the first tenant to turn
 * their notifications off.
 */
import type { EmailNotificationType } from '@prisma/client';

/**
 * Types addressed to the PLATFORM operator rather than to the tenant.
 *
 * Adding a type here exempts it from the tenant's notification switch at BOTH
 * gates. That is a deliberate override of a user-facing preference, so it
 * belongs only to mail the tenant is the subject of.
 */
export const PLATFORM_AUDIENCE_TYPES: ReadonlySet<EmailNotificationType> = new Set<
    EmailNotificationType
>(['INSURANCE_LEAD']);

/** Whether `type` is addressed to the platform operator. */
export function isPlatformAudience(type: EmailNotificationType): boolean {
    return PLATFORM_AUDIENCE_TYPES.has(type);
}

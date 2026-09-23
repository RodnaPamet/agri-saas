/**
 * Outbox processor: picks up PENDING emails and sends them via the configured
 * email provider. Marks rows SENT or FAILED with retry tracking.
 *
 * Usage (cron or manual):
 *   import { processOutbox } from '@/app-layer/notifications/processOutbox';
 *   const result = await processOutbox({ limit: 50 });
 *     // { sent: 12, failed: 1, skipped: 0 }
 */

import { prisma } from '@/lib/prisma';
import { sendEmail } from '@/lib/mailer';
import { getTenantNotificationSettings } from './settings';
import { isPlatformAudience } from './audience';
import { logger } from '@/lib/observability/logger';

export interface ProcessOutboxOptions {
    /** Max emails to process in one run. Default: 50 */
    limit?: number;
    /** Max attempts before marking permanently FAILED. Default: 3 */
    maxAttempts?: number;
}

export interface ProcessOutboxResult {
    sent: number;
    failed: number;
    skipped: number;
}

export async function processOutbox(
    options: ProcessOutboxOptions = {},
): Promise<ProcessOutboxResult> {
    const limit = options.limit ?? 50;
    const maxAttempts = options.maxAttempts ?? 3;
    const now = new Date();

    // Fetch PENDING rows where sendAfter <= now and attempts < maxAttempts

    const pending = await prisma.notificationOutbox.findMany({
        where: {
            status: 'PENDING',
            sendAfter: { lte: now },
            attempts: { lt: maxAttempts },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
    });

    // Cache tenant settings to avoid N+1 queries
    const settingsCache = new Map<string, Awaited<ReturnType<typeof getTenantNotificationSettings>>>();

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of pending) {
        try {
            // Look up tenant settings (cached)
            if (!settingsCache.has(row.tenantId)) {
                settingsCache.set(row.tenantId, await getTenantNotificationSettings(prisma, row.tenantId));
            }
            const settings = settingsCache.get(row.tenantId)!;

            // Skip if tenant disabled notifications after enqueue.
            //
            // Platform mail is exempt at THIS gate as well as at the enqueue
            // one. Checking only at enqueue let an insurance lead through the
            // door and then silenced it here on every sweep, for ever — see
            // `audience.ts`.
            if (!settings.enabled && !isPlatformAudience(row.type)) {
                skipped++;
                continue;
            }

            // ── Claim the row before sending ──
            //
            // A compare-and-swap on (status, attempts). Whoever bumps
            // `attempts` first owns the send; a concurrent runner that read the
            // same row matches zero rows here and moves on.
            //
            // This is load-bearing as of the `process-outbox` schedule: before
            // it, the only scheduled caller was `daily-evidence-expiry`, so two
            // runners never overlapped and a read-send-then-mark loop was safe
            // by accident. With a sweep every 5 minutes, that sweep meets the
            // daily one at 06:00 and can meet its own next tick, and the
            // failure mode is a DUPLICATE EMAIL to a real person — the one
            // outcome an outbox exists to prevent.
            //
            // Claiming also fixes the crash window: `attempts` now increments
            // BEFORE the send, so a process that dies mid-send has spent an
            // attempt rather than leaving a row that retries for ever.
            const claim = await prisma.notificationOutbox.updateMany({
                where: { id: row.id, status: 'PENDING', attempts: row.attempts },
                data: { attempts: row.attempts + 1 },
            });
            if (claim.count === 0) {
                // Another runner has it. Not an error, and not this run's to count.
                skipped++;
                continue;
            }

            await sendEmail({
                to: row.toEmail,
                subject: row.subject,
                text: row.bodyText,
                html: row.bodyHtml || undefined,
                from: `${settings.defaultFromName} <${settings.defaultFromEmail}>`,
                bcc: settings.complianceMailbox || undefined,
            });

            await prisma.notificationOutbox.update({
                where: { id: row.id },
                // `attempts` is NOT touched here — the claim above already
                // spent it. Bumping again would double-count every send.
                data: {
                    status: 'SENT',
                    sentAt: new Date(),
                },
            });

            sent++;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // The claim already spent this attempt; read it, do not add to it.
            const newAttempts = row.attempts + 1;
            const newStatus = newAttempts >= maxAttempts ? 'FAILED' : 'PENDING';

            await prisma.notificationOutbox.update({
                where: { id: row.id },
                data: {
                    status: newStatus,
                    lastError: errorMessage,
                },
            });

            if (newStatus === 'FAILED') {
                failed++;
                logger.error('email permanently failed', { component: 'notifications', dedupeKey: row.dedupeKey, attempts: maxAttempts });
            } else {
                skipped++;
                logger.warn('email attempt failed, will retry', { component: 'notifications', dedupeKey: row.dedupeKey, attempt: newAttempts });
            }
        }
    }

    return { sent, failed, skipped };
}

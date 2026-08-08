/**
 * Compliance Digest Job — Weekly Executive Summary Email
 *
 * Generates and sends a concise compliance digest email to tenant
 * admin/owner users. Reuses ComplianceSnapshot data to avoid
 * redundant aggregation queries.
 *
 * Architecture:
 *   ┌──────────────┐     ┌───────────────────────┐     ┌─────────┐
 *   │  Scheduler    │────▶│  runComplianceDigest() │────▶│  Mailer  │
 *   │  Mon 08:00 UTC│     │  per-tenant loop       │     │  (SMTP)  │
 *   └──────────────┘     └───────────────────────┘     └─────────┘
 *                               │
 *                    ┌──────────┴──────────┐
 *                    │ ComplianceSnapshot   │  ← Reuses daily snapshot
 *                    │ (latest + 7d prior)  │     data, not live queries
 *                    └─────────────────────┘
 *
 * Data Reuse:
 *   The digest reads from the ComplianceSnapshot table (populated by
 *   the daily 05:00 UTC snapshot job), NOT from live operational tables.
 *   This means:
 *     - Zero additional load on operational tables
 *     - Consistent with dashboard trend data
 *     - Digest only works after ≥1 snapshot exists
 *
 * @module app-layer/jobs/compliance-digest
 */
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { sendEmail } from '@/lib/mailer';
import type { JobRunResult } from './types';

// ─── Types ──────────────────────────────────────────────────────────

export interface DigestOptions {
    tenantId?: string;
    recipientOverrides?: string[];
    trendDays?: number;
}

interface DigestData {
    tenantName: string;
    snapshotDate: string;
    // Current KPIs (from latest snapshot)
    controlCoveragePercent: number;
    controlsImplemented: number;
    controlsApplicable: number;
    evidenceOverdue: number;
    evidenceDueSoon7d: number;
    policiesOverdueReview: number;
    tasksOpen: number;
    tasksOverdue: number;
    findingsOpen: number;
    // Trend deltas (vs N days ago)
    coverageDelta: number | null;
    evidenceOverdueDelta: number | null;
    findingsOpenDelta: number | null;
}

// ─── Main Entry Point ───────────────────────────────────────────────

export async function runComplianceDigest(options: DigestOptions = {}): Promise<{ result: JobRunResult }> {
    return runJob('compliance-digest', async () => {
        const startedAt = new Date().toISOString();
        const startMs = performance.now();

        const tenants = options.tenantId
            ? await prisma.tenant.findMany({
                where: { id: options.tenantId },
                select: { id: true, name: true, slug: true },
            })
            : await prisma.tenant.findMany({
                select: { id: true, name: true, slug: true },
            });

        let scanned = 0;
        let actioned = 0;
        let skipped = 0;

        for (const tenant of tenants) {
            scanned++;
            try {
                const sent = await generateAndSendDigest(
                    tenant,
                    options.recipientOverrides,
                    options.trendDays ?? 7,
                );
                if (sent) actioned++;
                else skipped++;
            } catch (err) {
                skipped++;
                logger.error('Digest generation failed for tenant', {
                    component: 'compliance-digest',
                    tenantId: tenant.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        const result: JobRunResult = {
            jobName: 'compliance-digest',
            jobRunId: crypto.randomUUID(),
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startMs),
            itemsScanned: scanned,
            itemsActioned: actioned,
            itemsSkipped: skipped,
            details: { tenantsSkipped: skipped },
        };

        return { result };
    });
}

// ─── Per-Tenant Digest ──────────────────────────────────────────────

async function generateAndSendDigest(
    tenant: { id: string; name: string; slug: string },
    recipientOverrides?: string[],
    trendDays: number = 7,
): Promise<boolean> {
    // 1. Get latest snapshot
    const latestSnapshot = await prisma.complianceSnapshot.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { snapshotDate: 'desc' },
    });

    if (!latestSnapshot) {
        logger.debug('Skipping digest — no snapshots yet', {
            component: 'compliance-digest',
            tenantId: tenant.id,
        });
        return false;
    }

    // 2. Get comparison snapshot (N days ago)
    const comparisonDate = new Date(latestSnapshot.snapshotDate.getTime() - trendDays * 86400000);
    const priorSnapshot = await prisma.complianceSnapshot.findFirst({
        where: {
            tenantId: tenant.id,
            snapshotDate: { lte: comparisonDate },
        },
        orderBy: { snapshotDate: 'desc' },
    });

    // 3. Build digest data
    const data: DigestData = {
        tenantName: tenant.name,
        snapshotDate: latestSnapshot.snapshotDate.toISOString().slice(0, 10),
        controlCoveragePercent: latestSnapshot.controlCoverageBps / 100,
        controlsImplemented: latestSnapshot.controlsImplemented,
        controlsApplicable: latestSnapshot.controlsApplicable,
        evidenceOverdue: latestSnapshot.evidenceOverdue,
        evidenceDueSoon7d: latestSnapshot.evidenceDueSoon7d,
        policiesOverdueReview: latestSnapshot.policiesOverdueReview,
        tasksOpen: latestSnapshot.tasksOpen,
        tasksOverdue: latestSnapshot.tasksOverdue,
        findingsOpen: latestSnapshot.findingsOpen,
        coverageDelta: priorSnapshot
            ? (latestSnapshot.controlCoverageBps - priorSnapshot.controlCoverageBps) / 100
            : null,
        evidenceOverdueDelta: priorSnapshot
            ? latestSnapshot.evidenceOverdue - priorSnapshot.evidenceOverdue
            : null,
        findingsOpenDelta: priorSnapshot
            ? latestSnapshot.findingsOpen - priorSnapshot.findingsOpen
            : null,
    };

    // 4. Resolve recipients
    const recipients = recipientOverrides ?? await getDigestRecipients(tenant.id);
    if (recipients.length === 0) {
        logger.debug('Skipping digest — no eligible recipients', {
            component: 'compliance-digest',
            tenantId: tenant.id,
        });
        return false;
    }

    // 5. Render and send
    const { subject, text, html } = renderDigestEmail(data, trendDays);

    for (const email of recipients) {
        await sendEmail({
            to: email,
            subject,
            text,
            html,
        });
    }

    logger.info('Compliance digest sent', {
        component: 'compliance-digest',
        tenantId: tenant.id,
        recipients: recipients.length,
        snapshotDate: data.snapshotDate,
    });

    return true;
}

/**
 * Get digest recipients: ADMIN members with active status.
 * Returns email addresses only — no PII leaks in logs.
 */
async function getDigestRecipients(tenantId: string): Promise<string[]> {
    const members = await prisma.tenantMembership.findMany({
        where: {
            tenantId,
            status: 'ACTIVE',
            role: 'ADMIN',
        },
        select: {
            user: { select: { email: true } },
        },
    });

    return members
        .map(m => m.user.email)
        .filter((e): e is string => !!e);
}

// ─── Email Rendering ────────────────────────────────────────────────

function formatDelta(val: number | null, suffix: string = ''): string {
    if (val === null) return 'N/A';
    const sign = val > 0 ? '+' : '';
    return `${sign}${val.toFixed(1)}${suffix}`;
}

function deltaColor(val: number | null, invertBetter: boolean = false): string {
    if (val === null) return '#94a3b8';
    const isBetter = invertBetter ? val > 0 : val < 0;
    if (val === 0) return '#94a3b8';
    return isBetter ? '#22c55e' : '#ef4444';
}

function renderDigestEmail(data: DigestData, trendDays: number): { subject: string; text: string; html: string } {
    const subject = `[${data.tenantName}] Weekly Compliance Digest — ${data.snapshotDate}`;

    // Plain text version
    const text = [
        `Weekly Compliance Digest — ${data.tenantName}`,
        `Report Date: ${data.snapshotDate}`,
        ``,
        `── Control Coverage ──`,
        `  Coverage: ${data.controlCoveragePercent.toFixed(1)}% (${data.controlsImplemented}/${data.controlsApplicable})`,
        `  ${trendDays}d change: ${formatDelta(data.coverageDelta, 'pp')}`,
        ``,
        `── Evidence & Deadlines ──`,
        `  Overdue: ${data.evidenceOverdue} | Due ≤7d: ${data.evidenceDueSoon7d}`,
        `  ${trendDays}d overdue change: ${formatDelta(data.evidenceOverdueDelta)}`,
        ``,
        `── Tasks & Findings ──`,
        `  Open tasks: ${data.tasksOpen} (${data.tasksOverdue} overdue)`,
        `  Open findings: ${data.findingsOpen}`,
        `  ${trendDays}d findings change: ${formatDelta(data.findingsOpenDelta)}`,
        ``,
        `── Attention Required ──`,
        ...(data.policiesOverdueReview > 0 ? [`  ${data.policiesOverdueReview} policies need review`] : []),
        ...(data.tasksOverdue > 0 ? [`  ${data.tasksOverdue} overdue tasks`] : []),
        ...(data.evidenceOverdue > 0 ? [`  ${data.evidenceOverdue} overdue evidence items`] : []),
        ...(data.policiesOverdueReview === 0 && data.tasksOverdue === 0 && data.evidenceOverdue === 0
            ? ['  ✓ No urgent items.'] : []),
        ``,
        `— Agrent`,
    ].join('\n');

    // HTML version
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0f172a;color:#f1f5f9;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
  <h1 style="font-size:20px;font-weight:700;margin:0 0 4px;">Weekly Compliance Digest</h1>
  <p style="font-size:13px;color:#94a3b8;margin:0 0 24px;">${data.tenantName} — ${data.snapshotDate}</p>

  <!-- Coverage -->
  <div style="background:rgba(30,41,59,0.8);border:1px solid rgba(51,65,85,0.5);border-radius:12px;padding:16px;margin-bottom:12px;">
    <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Control Coverage</div>
    <div style="display:flex;align-items:baseline;gap:8px;">
      <span style="font-size:28px;font-weight:700;color:#22c55e;">${data.controlCoveragePercent.toFixed(1)}%</span>
      <span style="font-size:13px;color:#94a3b8;">${data.controlsImplemented} of ${data.controlsApplicable}</span>
      <span style="font-size:12px;color:${deltaColor(data.coverageDelta, true)};margin-left:auto;">${formatDelta(data.coverageDelta, 'pp')}</span>
    </div>
    <div style="background:#1e293b;border-radius:999px;height:6px;margin-top:8px;overflow:hidden;">
      <div style="background:linear-gradient(90deg,#6366f1,#22c55e);height:100%;border-radius:999px;width:${Math.min(data.controlCoveragePercent, 100)}%;"></div>
    </div>
  </div>

  <!-- Evidence row -->
  <div style="display:flex;gap:12px;margin-bottom:12px;">
    <div style="flex:1;background:rgba(30,41,59,0.8);border:1px solid rgba(51,65,85,0.5);border-radius:12px;padding:16px;">
      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Evidence</div>
      <div style="font-size:24px;font-weight:700;color:${data.evidenceOverdue > 0 ? '#ef4444' : '#22c55e'};">${data.evidenceOverdue}</div>
      <div style="font-size:11px;color:#94a3b8;">overdue</div>
      ${data.evidenceDueSoon7d > 0 ? `<div style="font-size:11px;color:#f59e0b;margin-top:4px;">${data.evidenceDueSoon7d} due this week</div>` : ''}
    </div>
  </div>

  <!-- Tasks + Findings row -->
  <div style="display:flex;gap:12px;margin-bottom:12px;">
    <div style="flex:1;background:rgba(30,41,59,0.8);border:1px solid rgba(51,65,85,0.5);border-radius:12px;padding:16px;">
      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Tasks</div>
      <div style="font-size:24px;font-weight:700;color:#818cf8;">${data.tasksOpen}</div>
      <div style="font-size:11px;color:#94a3b8;">open</div>
      ${data.tasksOverdue > 0 ? `<div style="font-size:11px;color:#ef4444;margin-top:4px;">${data.tasksOverdue} overdue</div>` : ''}
    </div>
    <div style="flex:1;background:rgba(30,41,59,0.8);border:1px solid rgba(51,65,85,0.5);border-radius:12px;padding:16px;">
      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Findings</div>
      <div style="font-size:24px;font-weight:700;color:#a855f7;">${data.findingsOpen}</div>
      <div style="font-size:11px;color:#94a3b8;">open</div>
    </div>
  </div>

  <!-- Attention Required -->
  ${(() => {
      const items: string[] = [];
      if (data.evidenceOverdue > 0) items.push(`<span style="color:#ef4444;">● ${data.evidenceOverdue} overdue evidence</span>`);
      if (data.tasksOverdue > 0) items.push(`<span style="color:#f59e0b;">● ${data.tasksOverdue} overdue task${data.tasksOverdue > 1 ? 's' : ''}</span>`);
      if (data.policiesOverdueReview > 0) items.push(`<span style="color:#f59e0b;">● ${data.policiesOverdueReview} policies need review</span>`);
      if (items.length === 0) items.push(`<span style="color:#22c55e;">✓ No urgent items</span>`);
      return `
  <div style="background:rgba(30,41,59,0.8);border:1px solid rgba(51,65,85,0.5);border-radius:12px;padding:16px;margin-bottom:24px;">
    <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Attention Required</div>
    <div style="font-size:13px;line-height:1.8;">${items.join('<br>')}</div>
  </div>`;
  })()}

  <p style="font-size:11px;color:#64748b;text-align:center;margin:0;">
    Agrent — automated weekly digest
  </p>
</div>
</body>
</html>`;

    return { subject, text, html };
}

// ─── Exported for Testing ───────────────────────────────────────────

export { renderDigestEmail as _renderDigestEmail };
export { getDigestRecipients as _getDigestRecipients };
export type { DigestData };

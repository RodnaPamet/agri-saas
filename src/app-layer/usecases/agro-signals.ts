/**
 * Agro-signals — turn a location's recent weather into actionable
 * signals (spray-window warnings + disease-risk escalations).
 *
 * Consumes the PURE evaluators in `src/lib/agro/rules.ts`
 * (`evaluateSprayWindow` / `evaluateDiseaseRisk`) over the
 * WeatherObservation rows the daily `weather-pull` job persisted, and:
 *
 *   • SPRAY_WINDOW — when today's window is UNSUITABLE, claim an
 *     AgroSignal(kind=SPRAY_WINDOW, signalDate=today). If the claim
 *     CREATED a new row, fire a spray-warning notification to the
 *     location owner (fallback: the job's admin ctx user).
 *
 *   • DISEASE_RISK — when the recent run reaches HIGH, claim an
 *     AgroSignal(kind=DISEASE_RISK, signalDate=today), and if the claim
 *     CREATED a new row,
 *     and notify.
 *
 * Idempotency: the AgroSignal `@@unique([tenantId, locationId, kind,
 * signalDate])` is the key. We claim via
 * `createMany({ skipDuplicates: true })` and read `count` — count===1
 * means the row is NEW (fire side effects), count===0 means a prior run
 * today already handled it (no-op). This is a claim-then-act pattern,
 * NOT an upsert-that-overwrites, precisely because we must KNOW whether
 * the row is new before firing the notification.
 *
 */
import type { RequestContext } from '../types';
import { assertCanWrite } from '../policies/common';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { createAgroSignalNotification } from '../notifications/agro';
import {
    evaluateSprayWindow,
    evaluateDiseaseRisk,
    type SprayWeather,
    type DiseaseDay,
} from '@/lib/agro/rules';
import { logger } from '@/lib/observability/logger';
import { enqueue } from '../jobs/queue';
import { isLlmConfigured } from '../ai/llm-client';

/** Disease level → (likelihood, impact) on the 1–5 GRC matrix. */

/** Lookback window (days) for the disease-pressure streak. */
const DISEASE_LOOKBACK_DAYS = 10;

export interface EvaluateLocationSignalsResult {
    created: number;
    spray: { fired: boolean; status: string | null };
    disease: { fired: boolean; level: string | null };
    /**
     * When a NEW spray-window warning fired, the Web Push payload for the
     * caller (weather-pull job) to deliver AFTER the tx commits — so the
     * push network send never holds a DB transaction open.
     */
    sprayPush?: { recipientUserId: string; title: string; message: string; linkUrl: string };
}

/** Decimal | number | null → number | null. Prisma Decimals stringify. */
function num(v: unknown): number | null {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

/** UTC calendar-day Date (midnight) — matches `@db.Date` storage. */
function todayUtcDate(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

interface ObsRow {
    obsDate: Date;
    tempMaxC: unknown;
    tempMinC: unknown;
    tempMeanC: unknown;
    precipMm: unknown;
    windMaxKmh: unknown;
    humidityMean: unknown;
}

/**
 * Evaluate spray-window + disease-risk signals for one location.
 *
 * Callable standalone (opens its own `runInTenantContext`) — the daily
 * job calls it once per location after persisting that location's
 * weather. Returns the count of NEW signals created this run.
 */
export async function evaluateLocationSignals(
    ctx: RequestContext,
    locationId: string,
    now: Date = new Date(),
): Promise<EvaluateLocationSignalsResult> {
    assertCanWrite(ctx);

    const signalDate = todayUtcDate(now);
    const result: EvaluateLocationSignalsResult = {
        created: 0,
        spray: { fired: false, status: null },
        disease: { fired: false, level: null },
    };

    // ── Phase 1 — load weather, evaluate, claim signals (one tx). ──
    const phase1 = await runInTenantContext(ctx, async (db) => {
        const location = await db.location.findFirst({
            where: { id: locationId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, ownerUserId: true },
        });
        if (!location) return null;

        const since = new Date(now.getTime() - DISEASE_LOOKBACK_DAYS * 86_400_000);
        const obs = (await db.weatherObservation.findMany({
            where: { tenantId: ctx.tenantId, locationId, obsDate: { gte: since } },
            orderBy: { obsDate: 'asc' },
            take: 64,
            select: {
                obsDate: true,
                tempMaxC: true,
                tempMinC: true,
                tempMeanC: true,
                precipMm: true,
                windMaxKmh: true,
                humidityMean: true,
            },
        })) as ObsRow[];

        if (obs.length === 0) return { location, sprayNew: false, diseaseNew: false, sprayStatus: null, diseaseLevel: null, diseaseReasons: '' };

        // Today's observation (or the most recent we have) for the spray window.
        const todayKey = signalDate.toISOString().slice(0, 10);
        const todays =
            obs.find((o) => o.obsDate.toISOString().slice(0, 10) === todayKey) ??
            obs[obs.length - 1];

        const sprayInput: SprayWeather = {
            windMaxKmh: num(todays.windMaxKmh),
            precipMm: num(todays.precipMm),
            tempMeanC: num(todays.tempMeanC),
        };
        const spray = evaluateSprayWindow(sprayInput);

        const diseaseDays: DiseaseDay[] = obs.map((o) => ({
            date: o.obsDate.toISOString().slice(0, 10),
            precipMm: num(o.precipMm),
            humidityMean: num(o.humidityMean),
            tempMeanC: num(o.tempMeanC),
        }));
        const disease = evaluateDiseaseRisk(diseaseDays);

        // ── Claim SPRAY_WINDOW signal when UNSUITABLE ──
        let sprayNew = false;
        if (spray.status === 'UNSUITABLE') {
            const claim = await db.agroSignal.createMany({
                data: [
                    {
                        tenantId: ctx.tenantId,
                        locationId,
                        kind: 'SPRAY_WINDOW',
                        level: spray.status,
                        signalDate,
                        notified: false,
                        detailsJson: { reasons: spray.reasons },
                    },
                ],
                skipDuplicates: true,
            });
            sprayNew = claim.count > 0;
        }

        // ── Claim DISEASE_RISK signal when HIGH ──
        let diseaseNew = false;
        if (disease.level === 'HIGH') {
            const claim = await db.agroSignal.createMany({
                data: [
                    {
                        tenantId: ctx.tenantId,
                        locationId,
                        kind: 'DISEASE_RISK',
                        level: disease.level,
                        signalDate,
                        notified: false,
                        detailsJson: {
                            reasons: disease.reasons,
                            maxConsecutive: disease.maxConsecutive,
                            conduciveDays: disease.conduciveDays,
                        },
                    },
                ],
                skipDuplicates: true,
            });
            diseaseNew = claim.count > 0;
        }

        // ── Spray notification + audit, inside this tx (no own-tx call). ──
        // Web Push is fanned out by the CALLER after this tx commits (so the
        // network send never holds the tx) — capture its payload here.
        let sprayNotification: { title: string; message: string; linkUrl: string } | null = null;
        let sprayRecipientUserId: string | null = null;
        if (sprayNew) {
            const recipient = location.ownerUserId ?? ctx.userId;
            sprayRecipientUserId = recipient;
            const sprayOut = await createAgroSignalNotification(db, 'SPRAY_WINDOW_WARNING', {
                tenantId: ctx.tenantId,
                recipientUserId: recipient,
                locationId,
                locationLabel: location.name,
                tenantSlug: ctx.tenantSlug ?? '',
                detail: spray.reasons[0] ?? null,
            }, now);
            sprayNotification = sprayOut.notification ?? null;
            await db.agroSignal.updateMany({
                where: { tenantId: ctx.tenantId, locationId, kind: 'SPRAY_WINDOW', signalDate },
                data: { notified: true },
            });
            await logEvent(db, ctx, {
                action: 'AGRO_SPRAY_WINDOW_WARNING',
                entityType: 'AgroSignal',
                entityId: locationId,
                details: `Spray window UNSUITABLE at ${location.name}`,
                detailsJson: {
                    category: 'status_change',
                    summary: 'Spray window unsuitable',
                    locationId,
                    status: spray.status,
                },
            });
        }

        return {
            location,
            sprayNew,
            diseaseNew,
            sprayStatus: spray.status,
            diseaseLevel: disease.level,
            diseaseReasons: disease.reasons.join('; '),
            sprayNotification,
            sprayRecipientUserId,
        };
    });

    if (!phase1) return result;
    result.spray.status = phase1.sprayStatus;
    result.disease.level = phase1.diseaseLevel;
    if (phase1.sprayNew && phase1.sprayNotification && phase1.sprayRecipientUserId) {
        result.sprayPush = { recipientUserId: phase1.sprayRecipientUserId, ...phase1.sprayNotification };
    }
    if (phase1.sprayNew) {
        result.created += 1;
        result.spray.fired = true;
    }

    // ── Phase 2 — disease signal side effects. ──
    //
    // This used to also raise a GRC Risk row and back-link it; the risk
    // register was removed and the AgroSignal row IS the record now. The
    // notification, the `notified` mark and the counters are unchanged —
    // they were never about the Risk.
    //
    // Runs in its own short tx after the claim tx commits, so a
    // notification failure can never roll the (idempotent) claim back.
    if (phase1.diseaseNew) {
        result.created += 1;
        result.disease.fired = true;
        try {
            await runInTenantContext(ctx, async (db: PrismaTx) => {
                await db.agroSignal.updateMany({
                    where: { tenantId: ctx.tenantId, locationId, kind: 'DISEASE_RISK', signalDate },
                    data: { notified: true },
                });
                const recipient = phase1.location.ownerUserId ?? ctx.userId;
                await createAgroSignalNotification(db, 'DISEASE_RISK_RAISED', {
                    tenantId: ctx.tenantId,
                    recipientUserId: recipient,
                    locationId,
                    locationLabel: phase1.location.name,
                    tenantSlug: ctx.tenantSlug ?? '',
                    detail: phase1.diseaseReasons || null,
                }, now);
            });
        } catch (err) {
            // The signal row is already committed (idempotency holds); a
            // notification failure is logged, not fatal — the next run
            // won't re-fire because the signal already exists.
            logger.warn('agro-signals: disease signal notification failed', {
                component: 'agro-signals',
                tenantId: ctx.tenantId,
                locationId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // ── Agronomy copilot — enrich a NEW signal with a plain-language
    //    explanation (async, fail-safe). Gated on LLM config so the
    //    signal path stays free when AI is off. A queue failure must
    //    never fail signal evaluation, so it's swallowed + logged.
    if (isLlmConfigured()) {
        const signalDateIso = signalDate.toISOString();
        const newSignals: Array<'SPRAY_WINDOW' | 'DISEASE_RISK'> = [
            ...(phase1.sprayNew ? (['SPRAY_WINDOW'] as const) : []),
            ...(phase1.diseaseNew ? (['DISEASE_RISK'] as const) : []),
        ];
        for (const kind of newSignals) {
            try {
                await enqueue('agronomy-copilot', { tenantId: ctx.tenantId, locationId, kind, signalDateIso });
            } catch (err) {
                logger.warn('agro-signals: copilot enqueue failed', {
                    component: 'agro-signals',
                    tenantId: ctx.tenantId,
                    locationId,
                    kind,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    return result;
}

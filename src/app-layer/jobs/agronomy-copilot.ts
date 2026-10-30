/**
 * Agronomy Copilot job — on-demand, enqueued when a NEW AgroSignal fires.
 *
 * Loads the signal's weather context, asks Claude for a plain-language
 * explanation, merges it into `AgroSignal.detailsJson.copilot`, and fires
 * an "explanation ready" notification. Fail-safe: if the LLM is off or
 * returns nothing, the job succeeds as a no-op (the signal already exists
 * and already notified).
 *
 * @module app-layer/jobs/agronomy-copilot
 */
import prisma from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import {
    generateCopilotExplanation,
    computeGddSum,
    type CopilotWeatherDay,
} from '@/app-layer/ai/agronomy/copilot';
import { createAgroSignalNotification } from '@/app-layer/notifications/agro';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { isLocale } from '@/lib/i18n/locales';
import type { JobRunResult, AgronomyCopilotPayload } from './types';

export interface AgronomyCopilotResult {
    result: JobRunResult;
    explained: boolean;
}

function num(d: unknown): number | null {
    if (d === null || d === undefined) return null;
    return typeof d === 'number' ? d : Number(d as { toString(): string });
}

const LOOKBACK_DAYS = 10;

export async function runAgronomyCopilot(payload: AgronomyCopilotPayload): Promise<AgronomyCopilotResult> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob(
        'agronomy-copilot',
        async () => {
            const { tenantId, locationId, kind } = payload;
            const signalDate = new Date(payload.signalDateIso);
            let explained = false;

            const signal = await prisma.agroSignal.findFirst({
                where: { tenantId, locationId, kind, signalDate },
                select: { id: true, level: true, detailsJson: true },
            });
            const location = await prisma.location.findFirst({
                where: { id: locationId, tenantId },
                select: {
                    name: true,
                    ownerUserId: true,
                    owner: { select: { uiLanguage: true } },
                    tenant: { select: { slug: true } },
                },
            });

            if (signal && location) {
                const since = new Date(signalDate.getTime() - LOOKBACK_DAYS * 86_400_000);
                const obs = await prisma.weatherObservation.findMany({
                    where: { tenantId, locationId, obsDate: { gte: since } },
                    orderBy: { obsDate: 'asc' },
                    take: 32,
                    select: { obsDate: true, tempMeanC: true, precipMm: true, windMaxKmh: true, humidityMean: true },
                });
                const weather: CopilotWeatherDay[] = obs.map((o) => ({
                    date: o.obsDate.toISOString().slice(0, 10),
                    tempMeanC: num(o.tempMeanC),
                    precipMm: num(o.precipMm),
                    windMaxKmh: num(o.windMaxKmh),
                    humidityMean: num(o.humidityMean),
                }));

                // Most-recent active planting on this location → crop context.
                const planting = await prisma.planting.findFirst({
                    where: { tenantId, locationId, deletedAt: null },
                    orderBy: { createdAt: 'desc' },
                    select: { cropPlan: { select: { cropType: { select: { name: true } } } }, status: true },
                });

                const reasons = ((signal.detailsJson as { reasons?: string[] } | null)?.reasons ?? []).filter(
                    (r): r is string => typeof r === 'string',
                );

                const explanation = await generateCopilotExplanation({
                    kind,
                    level: signal.level,
                    locationName: location.name,
                    reasons,
                    weather,
                    gddSum: computeGddSum(weather),
                    cropType: planting?.cropPlan?.cropType?.name ?? null,
                    growthStage: planting?.status ?? null,
                    locale: isLocale(location.owner?.uiLanguage) ? location.owner.uiLanguage : undefined,
                });

                if (explanation) {
                    // Merge under detailsJson.copilot (preserve the rule data).
                    const existing = (signal.detailsJson as Record<string, unknown> | null) ?? {};
                    await prisma.agroSignal.update({
                        where: { id: signal.id },
                        // JSON-normalise the typed object into a plain Prisma JSON value.
                        data: { detailsJson: JSON.parse(JSON.stringify({ ...existing, copilot: explanation })) },
                    });
                    explained = true;

                    const recipient = location.ownerUserId;
                    if (recipient) {
                        await createAgroSignalNotification(
                            prisma,
                            'AGRO_COPILOT_READY',
                            {
                                tenantId,
                                recipientUserId: recipient,
                                locationId,
                                locationLabel: location.name,
                                tenantSlug: location.tenant?.slug ?? '',
                                // Already in the recipient's language: the
                                // generator above is passed the same
                                // `uiLanguage`, which pins its OUTPUT locale.
                                detail: explanation.explanation.slice(0, 140),
                                // TWO narrowings of one column, deliberately
                                // not unified. The prompt above takes
                                // `isLocale(x) ? x : undefined`, where
                                // `undefined` lets the generator choose; a
                                // notification has to NAME a language, so it
                                // takes the `bg` fallback the column default
                                // justifies. Collapsing them would either
                                // hand the generator a locale it was not
                                // given, or leave the row's language unset.
                                locale: resolveRecipientLocale(location.owner?.uiLanguage),
                            },
                            new Date(),
                        );
                    }
                }
            }

            logger.info('agronomy copilot completed', {
                component: 'job',
                jobName: 'agronomy-copilot',
                tenantId,
                locationId,
                kind,
                explained,
            });

            const durationMs = Math.round(performance.now() - startMs);
            const result: JobRunResult = {
                jobName: 'agronomy-copilot',
                jobRunId,
                success: true,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs,
                itemsScanned: 1,
                itemsActioned: explained ? 1 : 0,
                itemsSkipped: explained ? 0 : 1,
                details: { explained },
            };
            return { result, explained };
        },
        { tenantId: payload.tenantId },
    );
}

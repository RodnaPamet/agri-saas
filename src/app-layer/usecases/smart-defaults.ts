/**
 * Smart defaults — recall over EXISTING rows (recency / frequency), NO ML and
 * NO schema change. Powers the SprayJobWizard + location detail "do it again"
 * affordances: repeat the last job, pre-fill each parcel with what it last
 * received, default the rate unit, surface today's spray-window suitability,
 * and point at the next crop-plan milestone. Read-only; every query is
 * tenant-filtered AND bounded (take:).
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import {
    evaluateSprayWindow,
    computeSprayWindows,
    DEFAULT_SPRAY_THRESHOLDS,
    type SprayWindowStatus,
    type SprayReason,
    type SprayHour,
    type SprayWindow,
} from '@/lib/agro/rules';
import { appliesAProduct } from '@/lib/operations/line-kind';

/**
 * The most recent field operation on a location's parcels, regrouped into a
 * single repeatable job — one product + dose across its parcels (the wizard
 * collects exactly one).
 */
export interface SmartJobSuggestion {
    parcelIds: string[];
    productItemId: string;
    /** Decimal → number. */
    doseValue: number;
    doseUnitId: string;
    /** ISO; the createdAt of the latest line in the job. */
    occurredAt: string;
}

export interface SmartParcelDefault {
    productItemId: string;
    /** Decimal → number. */
    doseValue: number;
    doseUnitId: string;
}

export interface SmartSprayWindow {
    status: SprayWindowStatus;
    reasons: string[];
    /** Structured reasons for i18n at the UI layer (see SmartDefaultsBanner). */
    reasonCodes: SprayReason[];
    obsDate: string;
    /**
     * The real suitable time ranges today (location-local, hours already passed
     * dropped/clipped). Empty ⇒ no suitable window left today. Derived from the
     * WeatherObservation's hourly series; the daily `status`/`reasons` above
     * still carry the tone + the CAUTION explanation.
     */
    windows: SprayWindow[];
}

export interface SmartNextPlanting {
    id: string;
    label: string;
    stage: 'sow' | 'transplant' | 'harvest';
    date: string;
}

export interface LocationSmartDefaults {
    /** The latest field operation on this location's parcels, regrouped into one job. */
    repeatLast: SmartJobSuggestion | null;
    /** Per-parcel last-used product+dose (recency). Keyed by parcelId. */
    byParcel: Record<string, SmartParcelDefault>;
    /** Most-recently-used RATE unit across this location's operations. null if none. */
    defaultUnitId: string | null;
    /** Today's spray-window suitability from the latest WeatherObservation. null if no weather. */
    sprayWindow: SmartSprayWindow | null;
    /** The next upcoming crop-plan milestone for this location. null if none. */
    nextPlanting: SmartNextPlanting | null;
}

// Decimal | number | null → number (Prisma Decimal carries .toNumber()).
function toNumber(v: unknown): number {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && 'toNumber' in (v as object) && typeof (v as { toNumber: unknown }).toNumber === 'function') {
        return (v as { toNumber: () => number }).toNumber();
    }
    return Number(v);
}

// Decimal | number | null → number | null (preserves "no observation value").
function toNumberOrNull(v: unknown): number | null {
    if (v == null) return null;
    return toNumber(v);
}

export async function getLocationSmartDefaults(ctx: RequestContext, locationId: string): Promise<LocationSmartDefaults> {
    assertCanRead(ctx);
    const t = ctx.tenantId;
    const now = new Date();

    return runInTenantContext(ctx, async (db) => {
        // 1. This location's live parcels.
        const parcels = await db.parcel.findMany({
            where: { tenantId: t, locationId, deletedAt: null },
            select: { id: true },
            take: 500,
        });
        const parcelIds = parcels.map((p) => p.id);

        // No parcels ⇒ nothing op-derived to recall (weather + planting still apply).
        if (parcelIds.length === 0) {
            const [obs, planting] = await Promise.all([
                loadSprayWindow(db, t, locationId, now),
                loadNextPlanting(db, t, locationId, now),
            ]);
            return { repeatLast: null, byParcel: {}, defaultUnitId: null, sprayWindow: obs, nextPlanting: planting };
        }

        // 2. ONE bounded query over every op line on these parcels, newest first.
        //    Reused for byParcel, defaultUnitId, and to find the latest job's taskId.
        const lines = await db.operationParcel.findMany({
            where: { tenantId: t, parcelId: { in: parcelIds } },
            orderBy: { createdAt: 'desc' },
            select: { parcelId: true, taskId: true, productItemId: true, doseValue: true, doseUnitId: true, createdAt: true },
            take: 500,
        });

        // byParcel — first-seen-per-parcel == most recent (rows are createdAt desc).
        const byParcel: Record<string, SmartParcelDefault> = {};
        for (const l of lines) {
            // A bare activity — pruning, cultivation (#2316) — has no product
            // to suggest. Skipped rather than defaulted: an empty suggestion
            // would prefill the wizard with a product nobody chose.
            if (!appliesAProduct(l)) continue;
            if (!(l.parcelId in byParcel)) {
                byParcel[l.parcelId] = {
                    productItemId: l.productItemId,
                    doseValue: toNumber(l.doseValue),
                    doseUnitId: l.doseUnitId,
                };
            }
        }

        // defaultUnitId — unit of the most recent op line overall.
        const defaultUnitId = lines.length > 0 ? lines[0].doseUnitId : null;

        // 3. repeatLast — the latest line's taskId → load that job's lines, regroup.
        const [repeatLast, sprayWindow, nextPlanting] = await Promise.all([
            loadRepeatLast(db, t, lines.length > 0 ? lines[0].taskId : null),
            loadSprayWindow(db, t, locationId, now),
            loadNextPlanting(db, t, locationId, now),
        ]);

        return { repeatLast, byParcel, defaultUnitId, sprayWindow, nextPlanting };
    });
}

type Db = Parameters<Parameters<typeof runInTenantContext>[1]>[0];

async function loadRepeatLast(db: Db, tenantId: string, taskId: string | null): Promise<SmartJobSuggestion | null> {
    if (!taskId) return null;
    const jobLines = await db.operationParcel.findMany({
        where: { tenantId, taskId },
        orderBy: { createdAt: 'desc' },
        select: { parcelId: true, productItemId: true, doseValue: true, doseUnitId: true, createdAt: true },
        take: 100,
    });
    // Bare activity lines (#2316) carry no product or dose and cannot seed a
    // spray wizard, so they are dropped BEFORE the head is taken. Taken first
    // and filtered after, a single pruning row as the latest line would
    // collapse the whole suggestion to null with product lines right behind it.
    const productLines = jobLines.filter(appliesAProduct);
    if (productLines.length === 0) return null;

    // The wizard collects ONE product+dose across the job's parcels, so take
    // the product/dose from the latest such line; if lines somehow differ, the
    // latest wins by design.
    const head = productLines[0];
    return {
        parcelIds: productLines.map((l) => l.parcelId),
        productItemId: head.productItemId,
        doseValue: toNumber(head.doseValue),
        doseUnitId: head.doseUnitId,
        occurredAt: head.createdAt.toISOString(),
    };
}

// hourlyJson (Json?) → SprayHour[] — defensively typed; a legacy/absent series
// yields no hours (⇒ no windows), never a throw.
function parseHourly(raw: unknown): SprayHour[] {
    if (!Array.isArray(raw)) return [];
    const out: SprayHour[] = [];
    for (const item of raw) {
        if (item && typeof item === 'object') {
            const h = item as Record<string, unknown>;
            if (typeof h.hour === 'number') {
                out.push({
                    hour: h.hour,
                    windKmh: typeof h.windKmh === 'number' ? h.windKmh : null,
                    precipMm: typeof h.precipMm === 'number' ? h.precipMm : null,
                    tempC: typeof h.tempC === 'number' ? h.tempC : null,
                });
            }
        }
    }
    return out;
}

// obsDate (@db.Date, UTC midnight) → its YYYY-MM-DD calendar-day key.
function dayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
}

async function loadSprayWindow(db: Db, tenantId: string, locationId: string, now: Date): Promise<SmartSprayWindow | null> {
    // Pull a small recent window (latest first): enough to hold "today" and to
    // read the location's UTC offset (identical across a location's rows).
    const rows = await db.weatherObservation.findMany({
        where: { tenantId, locationId },
        orderBy: { obsDate: 'desc' },
        select: { obsDate: true, windMaxKmh: true, precipMm: true, tempMeanC: true, hourlyJson: true, utcOffsetSeconds: true },
        take: 10,
    });
    if (rows.length === 0) return null;

    // Location-local "now" — server UTC shifted by the stored offset. From that
    // shifted instant, UTC getters read the location-local clock.
    const offsetSec = rows.find((r) => r.utcOffsetSeconds != null)?.utcOffsetSeconds ?? 0;
    const localNow = new Date(now.getTime() + offsetSec * 1000);
    const localHour = localNow.getUTCHours();
    const localDate = dayKey(localNow);

    // "Today" = the row whose obsDate matches the location-local calendar date;
    // fall back to the most-recent row so the daily verdict still shows.
    const todayRow = rows.find((r) => dayKey(r.obsDate) === localDate) ?? rows[0];
    const isToday = dayKey(todayRow.obsDate) === localDate;

    const { status, reasons, reasonCodes } = evaluateSprayWindow({
        windMaxKmh: toNumberOrNull(todayRow.windMaxKmh),
        precipMm: toNumberOrNull(todayRow.precipMm),
        tempMeanC: toNumberOrNull(todayRow.tempMeanC),
    });

    // Only clip to "now" when the row really is today's — a fallback (no data
    // for today) shouldn't have its morning hours dropped by today's clock.
    const windows = computeSprayWindows(
        parseHourly(todayRow.hourlyJson),
        DEFAULT_SPRAY_THRESHOLDS,
        isToday ? { fromHour: localHour } : {},
    );

    return { status, reasons, reasonCodes, obsDate: todayRow.obsDate.toISOString(), windows };
}

async function loadNextPlanting(db: Db, tenantId: string, locationId: string, now: Date): Promise<SmartNextPlanting | null> {
    // Planting carries an optional locationId (planning.prisma) — scope to it.
    // The real PlantingStatus enum has no IN_PROGRESS; the not-yet-finished
    // states are PLANNED + the in-flight SOWN / TRANSPLANTED / HARVESTING
    // (HARVESTED / TERMINATED are done, so excluded).
    const plantings = await db.planting.findMany({
        where: {
            tenantId,
            locationId,
            deletedAt: null,
            status: { in: ['PLANNED', 'SOWN', 'TRANSPLANTED', 'HARVESTING'] },
        },
        select: {
            id: true,
            sowDate: true,
            transplantDate: true,
            harvestStartDate: true,
            variety: { select: { name: true } },
        },
        take: 200,
    });

    let best: SmartNextPlanting | null = null;
    let bestTime = Infinity;
    for (const p of plantings) {
        const label = p.variety?.name ?? 'Planting';
        const candidates: Array<{ stage: SmartNextPlanting['stage']; date: Date | null }> = [
            { stage: 'sow', date: p.sowDate },
            { stage: 'transplant', date: p.transplantDate },
            { stage: 'harvest', date: p.harvestStartDate },
        ];
        for (const c of candidates) {
            if (!c.date) continue;
            const ms = c.date.getTime();
            if (ms > now.getTime() && ms < bestTime) {
                bestTime = ms;
                best = { id: p.id, label, stage: c.stage, date: c.date.toISOString() };
            }
        }
    }
    return best;
}

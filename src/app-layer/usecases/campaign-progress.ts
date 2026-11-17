/**
 * The field campaign's progress for Табло (#3173, agrent-ios#635): the
 * newest МЗХ bulletin's harvest and sowing tables, as the weekly job stored
 * them. Owner ruling 2026-11-17 — harvest as a share, sowing as hectares and
 * the change on last year.
 */
import type { HarvestProgressRow, ProgressTable, SowingProgressRow } from '@/lib/market/mzh-progress';
import { prisma } from '@/lib/prisma';

export interface CampaignProgressView {
    /** The newest «към» date among the tables, `YYYY-MM-DD`. */
    asOf: string;
    /** The bulletin's own date, `YYYY-MM-DD`. */
    bulletinDate: string;
    sourceUrl: string;
    harvest: ProgressTable<HarvestProgressRow>[];
    sowing: ProgressTable<SowingProgressRow>[];
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The newest snapshot, or null before the job has stored one.
 *
 * Global reference data read with the global client — there is no tenant to
 * bind (see `no-direct-prisma`'s entry for this file).
 */
export async function getCampaignProgress(): Promise<CampaignProgressView | null> {
    const row = await prisma.campaignProgressSnapshot.findFirst({
        orderBy: [{ asOf: 'desc' }, { bulletinDate: 'desc' }],
        select: { asOf: true, bulletinDate: true, sourceUrl: true, tablesJson: true },
    });
    if (!row) return null;
    const tables = row.tablesJson as unknown as Pick<CampaignProgressView, 'harvest' | 'sowing'>;
    return {
        asOf: day(row.asOf),
        bulletinDate: day(row.bulletinDate),
        sourceUrl: row.sourceUrl,
        harvest: tables.harvest ?? [],
        sowing: tables.sowing ?? [],
    };
}

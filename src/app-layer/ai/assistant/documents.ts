/**
 * The ДНЕВНИК documents the assistant may OFFER — agri-saas#3158.
 *
 * Owner ruling 2026-11-17: asked in the chat for a journal PDF, the assistant
 * answers with a DOWNLOAD the person taps. It writes nothing and generates
 * nothing: the client calls the same PDF route its own screens call, under the
 * person's own session, when they tap. Recording stays the filled form
 * (`propose.ts`, the 2026-10-31 ruling) — an offer is the read-side sibling of
 * a proposal, never a way round it.
 *
 * ## Three documents, each a route that already exists
 *
 * | kind             | route                                                   |
 * |------------------|---------------------------------------------------------|
 * | `farm-campaign`  | `POST /reports/campaign-diary?campaign=YYYY-YYYY`       |
 * | `block-register` | `POST /locations/{id}/farm-record` `{ from, to }`       |
 * | `treatment`      | `GET /journal/treatments/{treatmentGroupId}/farm-record`|
 *
 * ## An id from the model is CHECKED by a read, never trusted
 *
 * `locationId` and `treatmentGroupId` come from the model, as
 * `analyze_block_risk`'s `locationId` does — and, like it, they are resolved
 * through a usecase under the caller's context before anything is offered. A
 * block or treatment the person cannot read is a refused tool call, so the
 * offer never names a record the person could not open. The LABEL is built
 * here from what that read returned, never from model text.
 *
 * ## Empty is decided when the person taps, not here
 *
 * The routes answer `REGISTER_EMPTY_FOR_PERIOD` for a period with nothing in
 * it, and both clients already say «Няма записи…». Counting rows here would be
 * a second, earlier answer to the same question that could disagree with the
 * document by the time it is tapped.
 */
import { z } from 'zod';

import { getLocation } from '@/app-layer/usecases/location';
import { getDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import type { RequestContext } from '@/app-layer/types';
import { campaignWindow, currentCampaignLabel, InvalidCampaignError } from '@/lib/reports/campaign-window';

export const DIARY_DOCUMENT_KINDS = ['farm-campaign', 'block-register', 'treatment'] as const;
export type DiaryDocumentKind = (typeof DIARY_DOCUMENT_KINDS)[number];

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Campaign = z.string().regex(/^\d{4}-\d{4}$/);

/** What the model may send. `.strict()`: an unknown field is a refusal. */
export const OfferDiaryDocumentArgs = z
    .object({
        document: z.enum(DIARY_DOCUMENT_KINDS),
        campaign: Campaign.optional(),
        locationId: z.string().min(1).max(64).optional(),
        from: Day.optional(),
        to: Day.optional(),
        treatmentGroupId: z.string().min(1).max(64).optional(),
    })
    .strict();
export type OfferDiaryDocumentArgsT = z.infer<typeof OfferDiaryDocumentArgs>;

/** The offer as it rides the `answer` event. */
export const DiaryDocumentOfferSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('farm-campaign'), label: z.string().min(1), campaign: Campaign }).strict(),
    z
        .object({
            kind: z.literal('block-register'),
            label: z.string().min(1),
            locationId: z.string().min(1),
            from: Day,
            to: Day,
        })
        .strict(),
    z.object({ kind: z.literal('treatment'), label: z.string().min(1), treatmentGroupId: z.string().min(1) }).strict(),
]);
export type DiaryDocumentOffer = z.infer<typeof DiaryDocumentOfferSchema>;

/** «2025–2026», the campaign as the documents print it. */
function campaignWords(label: string): string {
    return label.replace('-', '–');
}

/** «12.11.2026» — the date as the ДНЕВНИК prints it. */
function bgDay(day: string): string {
    const [y, m, d] = day.split('-');
    return `${d}.${m}.${y}`;
}

/** The campaign's window as inclusive days: 1 October to 30 September. */
function campaignDays(label: string): { from: string; to: string } {
    const w = campaignWindow(label);
    return { from: `${w.startYear}-10-01`, to: `${w.endYear}-09-30` };
}

/**
 * Build the offer, reading every id the model sent under the caller's
 * context. Throws — which `runTool` reports to the model as a failed tool —
 * when an argument is missing, malformed, or names nothing the caller can read.
 */
export async function buildDiaryOffer(
    ctx: RequestContext,
    args: OfferDiaryDocumentArgsT,
    now: Date = new Date(),
): Promise<DiaryDocumentOffer> {
    const campaign = args.campaign ?? currentCampaignLabel(now);
    try {
        campaignWindow(campaign);
    } catch (err) {
        if (err instanceof InvalidCampaignError) throw new Error('campaign must be two consecutive years, YYYY-YYYY.');
        throw err;
    }

    switch (args.document) {
        case 'farm-campaign':
            return {
                kind: 'farm-campaign',
                label: `Дневник на стопанството ${campaignWords(campaign)}`,
                campaign,
            };
        case 'block-register': {
            if (!args.locationId) throw new Error('block-register needs locationId from list_blocks.');
            // The READ is the check: a block outside the caller's farm, or one
            // they may not read, throws here and no offer is made.
            const block = await getLocation(ctx, args.locationId);
            const window = campaignDays(campaign);
            const from = args.from ?? window.from;
            const to = args.to ?? window.to;
            if (from > to) throw new Error('from must not be after to.');
            return {
                kind: 'block-register',
                label: `ДНЕВНИК за блок «${block.name}», ${bgDay(from)} – ${bgDay(to)}`,
                locationId: block.id,
                from,
                to,
            };
        }
        case 'treatment': {
            if (!args.treatmentGroupId) {
                throw new Error('treatment needs treatmentGroupId from list_journal_entries.');
            }
            const treatment = await getDiaryTreatment(ctx, args.treatmentGroupId);
            if (!treatment) throw new Error('No recorded treatment with that treatmentGroupId.');
            return {
                kind: 'treatment',
                label: treatment.occurredOn
                    ? `ДНЕВНИК за третирането от ${bgDay(treatment.occurredOn)}`
                    : 'ДНЕВНИК за третирането',
                treatmentGroupId: treatment.treatmentGroupId,
            };
        }
    }
}

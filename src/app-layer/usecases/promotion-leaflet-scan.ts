/**
 * «Прочети брошура» — store a supplier's leaflet and PROPOSE its offers (#2664).
 *
 * Owner, 2026-11-01 (relayed): a list of product promotions from trading
 * companies, loaded by the superuser for all farms, uploaded **as the file
 * came**, and **checked by the owner before use**.
 *
 * ## IT CREATES NO PROMOTION
 *
 * `invoice-scan`'s ruling, and it matters more here. There, a misread figure
 * reaching the Калкулатор unseen is the harm. Here a misread PRICE or END DATE
 * would be repeated by the assistant to farmers as fact, and a misread product
 * could be a pesticide. So the response is a PROPOSAL in the console's own
 * shape, and `POST /admin/promotions` is what writes a row — with
 * `publishedAt` null until somebody publishes it, which is a second deliberate
 * action that already exists.
 *
 * The only row this creates is the `FileRecord` for the bytes.
 *
 * ## INGEST BEFORE THE MODEL, AND THE GATE BEFORE BOTH
 *
 * `ingestUploadedFile` is allowlist → write → MIME-reconcile → scan, so an
 * infected upload is refused before a token is spent. The platform AI spend
 * gate is asserted first, because a document read sends a whole PDF on every
 * attempt and is the most expensive call shape in this product — a stuck retry
 * loop is what the ceiling is for.
 *
 * The gate and the usage ledger live in the READER, beside the call they are
 * about, so a second caller cannot arrive ungated. The check here is an early
 * exit that keeps an upload from being stored when the month has no budget
 * left — see its comment.
 *
 * ## A WORKBOOK IS STORED AND NOT READ, AND SAYS SO
 *
 * The owner asked to upload PDF, Excel or a photo. There is no spreadsheet
 * block in the Messages API, so an XLSX is scanned and stored like any other
 * upload and then refused for READING with its own code. Returning an empty
 * read would be indistinguishable from a leaflet with no offers on it.
 */
import { isPlatformAiSpendAllowed } from '@/app-layer/ai/platform-budget';
import {
    isReadableLeafletMedia,
    leafletReaderAvailable,
    readPromotionLeaflet,
    type OfferDraft,
} from '@/app-layer/ai/promotion-leaflet-reader';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import type { RequestContext } from '@/app-layer/types';
import { codedClientError, codedUnsupportedMediaType } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { log } from '@/lib/observability';
import { ingestUploadedFile } from '@/lib/upload/ingest';

const LEAFLET_DOMAIN = 'promotion-leaflet' as const;

export interface LeafletScanResult {
    /**
     * The stored source document's `FileRecord` id.
     *
     * It CANNOT be attached to the promotion, and this comment said it could
     * until #2750 — "so the console can attach it to the row it creates".
     * `Promotion` has no column for a file and neither write schema accepts
     * one. I corrected the same sentence in the OpenAPI description and left
     * this one standing, which is its own small lesson: the claim existed in
     * two places and fixing one made the other look reviewed.
     *
     * What it is for today: correlating this result with the `leafletFileId`
     * the 415 and 422 refusals carry, so a client can say WHICH stored file
     * could not be read. Linking it to the row is #2750.
     */
    fileId: string;
    /** As printed on the leaflet, for the operator to match against `Company`. */
    companyName: string | null;
    offers: OfferDraft[];
    /**
     * Offers the model SAW and could not read.
     *
     * Surfaced rather than swallowed: a six-offer leaflet read as four is
     * otherwise indistinguishable from a four-offer leaflet, and the operator
     * is the only one who can open the PDF and check.
     */
    unreadableOfferCount: number;
}

export async function scanPromotionLeaflet(
    ctx: RequestContext,
    input: { file: File },
): Promise<LeafletScanResult> {
    if (!leafletReaderAvailable()) {
        // 503 and not a 500: the operator's file is fine and nothing they do
        // will help, so the sentence belongs to whoever configures the
        // deployment. `invoice-scan`'s `INVOICE_SCAN_UNAVAILABLE` verbatim.
        throw codedClientError(
            503,
            'LEAFLET_READER_UNAVAILABLE',
            'Reading leaflets is not configured on this installation.',
        );
    }

    // AN EARLY CHECK, NOT THE GATE. The gate and the ledger live in
    // `promotion-leaflet-reader.ts`, beside the call they are about, so a
    // second caller cannot arrive ungated. This one exists for a different
    // reason: refusing AFTER the upload would leave a stored `FileRecord`
    // nothing can ever propose from, and the AV scan and the write are the
    // expensive part of this request. It is deliberately the same predicate
    // rather than a cached verdict — two reads of one Redis key, and the
    // second is the one that decides.
    if (!(await isPlatformAiSpendAllowed('promotion-leaflet-read'))) {
        throw codedClientError(
            503,
            'PLATFORM_AI_BUDGET_EXCEEDED',
            'The platform AI budget for this month is spent. Type the offers in, or raise the ceiling.',
        );
    }

    const ingested = await ingestUploadedFile(ctx.tenantId, input.file, {
        domain: LEAFLET_DOMAIN,
        fallbackName: 'leaflet',
        component: 'promotion-leaflet-scan',
    });

    const stored = await runInTenantContext(ctx, async (db) => {
        const record = await FileRepository.createPending(db, ctx, {
            pathKey: ingested.pathKey,
            originalName: ingested.originalName,
            mimeType: ingested.mimeType,
            sizeBytes: ingested.sizeBytes,
            sha256: ingested.sha256,
            storageProvider: ingested.storageProvider,
            bucket: ingested.bucket,
            domain: ingested.domain,
        });
        await FileRepository.markStored(db, ctx, record.id, ingested.scanStatus);
        return record;
    });

    // The RESOLVED type, never the client's claim. The shared allowlist is
    // wider than what the Messages API can read — a workbook lands here.
    //
    // CHECKED, not assumed: `FILE_ALLOWED_MIME` carries both
    // `…spreadsheetml.sheet` and `application/vnd.ms-excel`, so an Excel
    // leaflet really is accepted, stored and scanned before reaching this
    // line. Worth verifying rather than inferring from the owner asking for
    // Excel — if the allowlist had refused it at ingest, this branch and the
    // 415 in the OpenAPI description would both be documenting a state that
    // cannot occur, and the unit test above mocks the ingest so it could
    // never have told me.
    if (!isReadableLeafletMedia(ingested.mimeType)) {
        throw codedUnsupportedMediaType(
            'LEAFLET_MEDIA_UNSUPPORTED',
            'The file is stored, but only a PDF or a photo can be read automatically. '
                + 'Type the offers in instead.',
            { leafletFileId: stored.id },
        );
    }

    // `ingested.buffer` rather than a read-back from storage: the bytes are
    // already in hand, and the three local `streamToBuffer` helpers in this
    // repo are three copies of one function — a fourth would be worse than
    // reusing what the ingest already returns.
    const outcome = await readPromotionLeaflet({
        bytes: ingested.buffer,
        mimeType: ingested.mimeType,
    });

    // The budget turned between the early check and the call — a long upload
    // on a month's last tokens. Distinguished from an unusable read because
    // the remedies differ: wait or raise the ceiling, versus type it in.
    if (outcome.refused) {
        throw codedClientError(
            503,
            'PLATFORM_AI_BUDGET_EXCEEDED',
            'The platform AI budget for this month is spent. Type the offers in, or raise the ceiling.',
            { leafletFileId: stored.id },
        );
    }

    if (!outcome.read || !outcome.read.isLeaflet) {
        log('info', 'promotion.leaflet_not_recognised', {
            component: 'promotion-leaflet-scan',
            fileId: stored.id,
            // The REASON, because "not a leaflet" and "could not read it"
            // have the same remedy for the operator and different causes for
            // whoever tunes the prompt — and the coded refusal below
            // deliberately tells the operator only the remedy.
            cause: outcome.read ? 'not_a_leaflet' : 'no_valid_tool_output',
        });
        // 422, matching `INVOICE_NOT_RECOGNISED`: the request was
        // well-formed and the CONTENT is not what this surface reads.
        throw codedClientError(
            422,
            'LEAFLET_NOT_RECOGNISED',
            'This does not look like a promotion leaflet. The file is stored — type the offers in.',
            { leafletFileId: stored.id },
        );
    }

    return {
        fileId: stored.id,
        companyName: outcome.read.companyName,
        offers: outcome.read.offers,
        unreadableOfferCount: outcome.read.unreadableOfferCount,
    };
}

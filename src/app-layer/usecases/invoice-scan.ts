/**
 * «Сканирай фактура» — read an invoice, propose cost-sheet lines (#482).
 *
 * Owner, 2026-10-31: *"use visual recognition to include each invoice scanned
 * to expenses automatically"*, and in the same breath what automatic means —
 * **"Automatic means filled, not saved. The invoice fills the form and the
 * person checks it and taps «Запиши». A misread amount never reaches the
 * calculator unseen."** So this usecase WRITES NOTHING to the cost sheet. It
 * returns a proposal in the batch endpoint's own line shape, and
 * `POST /grain/costs/batch` is what persists it when the farmer taps.
 *
 * Two entry points, one route (the #482 contract sent to agrent-ios):
 *
 *   - «Нов разход» camera → `file`, the bytes themselves.
 *   - «Документи» → `fileId`, a `FileRecord` the document upload already
 *     stored. No second copy of the bytes.
 *
 * Exactly one of the two. Both or neither is `INVOICE_SCAN_INPUT_AMBIGUOUS`
 * rather than a silent preference, because a client that sent both has a bug
 * and the cheapest place to learn that is the first call.
 */
import type { RequestContext } from '@/app-layer/types';
import { assertCanWrite } from '@/app-layer/policies/common';
import { assertAiBudget } from '@/app-layer/ai/budget';
import { recordAiUsage } from '@/app-layer/ai/usage';
import { estimateCostMicros } from '@/app-layer/ai/cost';
import {
    readInvoice,
    isReadableInvoiceMedia,
    invoiceReaderAvailable,
    type InvoiceLineDraft,
} from '@/app-layer/ai/invoice-reader';
import { assertUsableInvoice } from '@/app-layer/usecases/cost-entry';
import {
    MAX_COST_BATCH_LINES,
    type CreateCostEntryInput,
} from '@/app-layer/schemas/grain.schemas';
import { normaliseCostToEur } from '@/lib/grain/currencies';
import { ingestUploadedFile } from '@/lib/upload/ingest';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { runInTenantContext } from '@/lib/db-context';
import { getProviderByName } from '@/lib/storage';
import type { StorageProviderType } from '@/lib/storage/types';
import {
    codedBadRequest,
    codedClientError,
    codedNotFound,
    codedUnsupportedMediaType,
} from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { withDeleted } from '@/lib/soft-delete';
import type { Readable } from 'stream';

/**
 * Storage domain for an invoice — the SAME one the attach route uses
 * (`cost-entry.ts`), so a scanned invoice and an attached one land in one
 * place. `StorageDomain` is a closed union; `'invoices'` is not a member.
 */
const INVOICE_DOMAIN = 'cost-invoice';

/**
 * Cap on the bytes read back for the `fileId` path.
 *
 * Mirrors `classify-photo`'s cap in purpose: the model call is bounded by the
 * document, and a 60 MB scan is a request to spend an unbounded number of
 * tokens. Higher than the photo cap because a multi-page PDF invoice is
 * legitimately larger than one field photo.
 */
const MAX_INVOICE_BYTES = 16 * 1024 * 1024;

/**
 * A finding about the INVOICE rather than about one line.
 *
 * **A code and numbers, never prose.** `no-server-authored-user-copy` is
 * ratcheting server-authored sentences down, and a `detail: string` here would
 * be English displayed verbatim to a Bulgarian farmer — the same defect
 * `DueItem.reason` was (a sentence built far from its reader, routed to
 * recipients whose language is not knowable where it is built). The client
 * words these from `code`; `params` carries the figures a sentence needs.
 *
 * It is NOT routed through `localizeErrorPayload` either: that resolves the
 * locale and replaces `message` on an ERROR payload, and these ride a 200.
 */
export interface InvoiceScanWarning {
    code: string;
    /** Figures a client sentence may need. Numbers only — never personal data. */
    params?: Record<string, number>;
}

export interface InvoiceScanResult {
    /** The stored invoice — pre-filled on every proposed line. */
    invoiceFileId: string;
    /** `CreateCostEntrySchema`'s shape, verbatim, so it posts back unchanged. */
    lines: CreateCostEntryInput[];
    warnings: InvoiceScanWarning[];
}

export interface ScanInvoiceInput {
    file?: File | null;
    fileId?: string | null;
    /**
     * A «Документи» row, which is what the phone's «Към разходи» actually
     * holds.
     *
     * `FarmDocument.fileRecordId` is not on the document DTO — a client that
     * can see a document cannot name its `FileRecord` — so without this the
     * «Документи» entry point could not be built at all. Resolved here,
     * through the same gate `downloadFarmDocument` uses and with its codes, so
     * a purged tombstone answers `DOCUMENT_PURGED` rather than being read as a
     * missing file.
     */
    documentId?: string | null;
}

async function streamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
        total += buf.length;
        if (total > maxBytes) return null;
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

/**
 * Map one model-reported line onto the batch's line shape.
 *
 * Returns `null` when the line cannot be represented, which is NOT the same as
 * refusing the scan: one unreadable line among nine good ones should cost the
 * farmer that line, not the whole invoice.
 */
function toProposedLine(
    draft: InvoiceLineDraft,
    invoiceFileId: string,
): { line: CreateCostEntryInput } | { skip: string } {
    const { eur, refusal } = normaliseCostToEur(draft.amount, draft.currency);
    if (refusal === 'FOREIGN') {
        // The EUR-only ruling named euro spellings, blanks and lev. A dollar
        // invoice needs a market quote this product does not have, and
        // relabelling it as euro would misstate money by whatever the rate is.
        return { skip: 'INVOICE_LINE_FOREIGN_CURRENCY' };
    }
    if (eur == null) return { skip: 'INVOICE_LINE_AMOUNT_UNREADABLE' };

    /**
     * The original lev figure goes in `description`, because there is no
     * column for it.
     *
     * Checked against the schema and the model: no `originalAmount`,
     * `amountOriginal` or `sourceAmount` exists. `amount` is EUR and
     * `currency` is `'EUR'` — the save path REFUSES anything else
     * (`COST_ENTRY_CURRENCY_NOT_EUR`), so there is nowhere else for it to go.
     *
     * This is the weakest part of the #482 contract and it was flagged as such
     * when the contract was sent: a description is prose, so nothing can
     * compute on it later. If the original belongs in a FIELD — for a VAT
     * report, say — that is a migration and an owner decision, not something
     * to add on my own judgement.
     */
    const isLev = eur !== draft.amount;
    const prefix = isLev
        ? `${draft.amount.toFixed(2)} лв. · `
        : '';
    const description = `${prefix}${draft.description ?? ''}`.trim() || null;

    return {
        line: {
            category: draft.category as CreateCostEntryInput['category'],
            amount: Math.round(eur * 100) / 100,
            currency: 'EUR',
            incurredOn: draft.incurredOn,
            supplier: draft.supplier ?? null,
            description,
            invoiceFileId,
            /**
             * Every attribution field stays NULL, deliberately.
             *
             * The model cannot know which planting a drum of diesel belongs
             * to, and a guess would put a wrong attribution into the
             * Калкулатор — the one number the owner checks. The farmer picks.
             *
             * `commodityCanonical` and `allocationBasis` are absent TOGETHER:
             * the schema requires the commodity for `CROP` and refuses it
             * otherwise (`assertAllocationBasis`), so a proposal that set one
             * without the other would 400 on save — the model's guess becoming
             * the farmer's error.
             */
            plantingId: null,
            seasonId: null,
            locationId: null,
            parcelId: null,
            leaseId: null,
            itemId: null,
        },
    };
}

/**
 * Read an invoice and propose lines. Writes a `FileRecord` for the `file`
 * path; writes nothing to the cost sheet on either path.
 */
export async function scanInvoice(
    ctx: RequestContext,
    input: ScanInvoiceInput,
): Promise<InvoiceScanResult> {
    assertCanWrite(ctx);

    // EXACTLY ONE of the three. Counting beats a chain of booleans: a fourth
    // entry point added later cannot slip past a pairwise comparison.
    const supplied = [Boolean(input.file), Boolean(input.fileId), Boolean(input.documentId)]
        .filter(Boolean).length;
    if (supplied !== 1) {
        throw codedBadRequest(
            'INVOICE_SCAN_INPUT_AMBIGUOUS',
            supplied === 0
                ? 'Send the invoice file, the id of one already uploaded, or a document id.'
                : 'Send only one of the invoice file, an uploaded file id, or a document id.',
        );
    }

    if (!invoiceReaderAvailable()) {
        // A deployment with no key cannot read an invoice. Said plainly rather
        // than as a 500: the farmer's document is fine and nothing they do
        // will help, so the sentence belongs to the operator.
        throw codedClientError(
            503,
            'INVOICE_SCAN_UNAVAILABLE',
            'Invoice scanning is not configured on this installation.',
        );
    }

    /**
     * A `documentId` becomes a `fileId` here, so there is ONE read path below
     * rather than two that could drift about what counts as a usable invoice.
     */
    let resolvedFileId = input.fileId ?? null;
    if (input.documentId) {
        const documentId = input.documentId;
        resolvedFileId = await runInTenantContext(ctx, async (db) => {
            const doc = await db.farmDocument.findFirst({
                where: { id: documentId, tenantId: ctx.tenantId },
                select: { id: true, purgedAt: true, fileRecordId: true },
            });
            if (!doc) throw codedNotFound('DOCUMENT_NOT_FOUND', 'That document was not found.');
            // A tombstone keeps its row and its `fileRecordId` on purpose, so
            // "what was this file" survives the bytes. There is nothing to
            // read, and this is the code the download route already answers.
            if (doc.purgedAt) {
                throw codedNotFound('DOCUMENT_PURGED', 'That document has been deleted.');
            }
            return doc.fileRecordId;
        });
    }

    let invoiceFileId: string;
    let bytes: Buffer;
    let mimeType: string;

    if (input.file) {
        /**
         * Ingest BEFORE the model call, and that order is the point.
         *
         * `ingestUploadedFile` is allowlist → write → MIME-reconcile → scan,
         * and it carries this module's `'upload'` past-due gate. So an
         * INFECTED or past-due upload is refused before a single token is
         * spent — the security answer and the cheap one at once.
         */
        const ingested = await ingestUploadedFile(ctx.tenantId, input.file, {
            domain: INVOICE_DOMAIN,
            fallbackName: 'invoice',
            component: 'invoice-scan',
        });

        if (!isReadableInvoiceMedia(ingested.mimeType)) {
            // The RESOLVED type, never the client's claim. The shared
            // allowlist is wider than what the Messages API can read.
            throw codedUnsupportedMediaType(
                'INVOICE_SCAN_MEDIA_UNSUPPORTED',
                'An invoice must be a photo (JPEG, PNG, GIF or WebP) or a PDF.',
            );
        }

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

        invoiceFileId = stored.id;
        mimeType = ingested.mimeType;
        const provider = getProviderByName(ingested.storageProvider as StorageProviderType);
        const read = await streamToBuffer(provider.readStream(ingested.pathKey), MAX_INVOICE_BYTES);
        if (!read) {
            throw codedClientError(
                413,
                'INVOICE_SCAN_TOO_LARGE',
                'That invoice is too large to read.',
                { limitBytes: MAX_INVOICE_BYTES },
            );
        }
        bytes = read;
    } else {
        const fileId = resolvedFileId as string;
        const file = await runInTenantContext(ctx, async (db) => {
            // The SAME gate the attach path uses — tenant, STORED, not
            // deleted — so the two paths cannot disagree about what counts as
            // a usable invoice, and its three codes already have bg + en
            // entries.
            await assertUsableInvoice(db, ctx, fileId);
            return db.fileRecord.findFirst(
                withDeleted({
                    where: { id: fileId, tenantId: ctx.tenantId },
                    select: { id: true, pathKey: true, mimeType: true, storageProvider: true },
                }),
            );
        });
        if (!file) {
            throw codedBadRequest(
                'COST_ENTRY_INVOICE_FILE_NOT_FOUND',
                'Invoice file not found or belongs to a different tenant',
            );
        }
        if (!isReadableInvoiceMedia(file.mimeType)) {
            throw codedUnsupportedMediaType(
                'INVOICE_SCAN_MEDIA_UNSUPPORTED',
                'An invoice must be a photo (JPEG, PNG, GIF or WebP) or a PDF.',
            );
        }
        invoiceFileId = file.id;
        mimeType = file.mimeType;
        const provider = getProviderByName(file.storageProvider as StorageProviderType);
        const read = await streamToBuffer(provider.readStream(file.pathKey), MAX_INVOICE_BYTES);
        if (!read) {
            throw codedClientError(
                413,
                'INVOICE_SCAN_TOO_LARGE',
                'That invoice is too large to read.',
                { limitBytes: MAX_INVOICE_BYTES },
            );
        }
        bytes = read;
    }

    /**
     * The budget gate, and the ledger write below it.
     *
     * BOTH are required and neither is optional — `ai-spend-gate-covers-
     * embeddings` states the rule: an assertion against a total nothing
     * contributes to is a cap that never binds. This surface calls the
     * Anthropic API directly rather than through `completeWithRouting` (which
     * is what gates and records for every text path), so the two calls are
     * this usecase's own responsibility. #2596 is the same gap on the vision
     * path next door, where neither call was made.
     */
    await assertAiBudget(ctx);

    const outcome = await readInvoice({ bytes, mimeType });

    // Recorded whether or not the read succeeded: an unreadable document still
    // spent the tokens, and those are exactly the requests a farmer retries.
    await recordAiUsage(ctx, {
        task: 'invoice-scan',
        model: outcome.usage.model,
        backend: 'claude',
        promptTokens: outcome.usage.promptTokens,
        completionTokens: outcome.usage.completionTokens,
        totalTokens: outcome.usage.totalTokens,
        costMicros: estimateCostMicros(outcome.usage.model, {
            promptTokens: outcome.usage.promptTokens,
            completionTokens: outcome.usage.completionTokens,
            totalTokens: outcome.usage.totalTokens,
        }),
        cacheHit: false,
        // The document's own digest, not a prompt hash: the prompt is a
        // constant here, so hashing it would correlate nothing. Never the
        // bytes and never the supplier.
        promptHash: invoiceFileId,
    });

    const read = outcome.read;
    if (!read || !read.isInvoice || read.lines.length === 0) {
        /**
         * 422, not 500 and not an empty 200.
         *
         * An unreadable photo is an ordinary outcome — a farmer photographs a
         * delivery note, or a hand, or shoots into the sun — and the remedy is
         * "take it again in better light", which a 500 cannot say and an empty
         * 200 states as "this invoice has no lines". The stored file id rides
         * along in `params` so the client need not re-upload to retry.
         */
        throw codedClientError(
            422,
            'INVOICE_NOT_RECOGNISED',
            'That does not look like an invoice we can read. Try a clearer photo of the whole page.',
            { invoiceFileId },
        );
    }

    const warnings: InvoiceScanWarning[] = [];
    const lines: CreateCostEntryInput[] = [];
    let skipped = 0;

    for (const draft of read.lines) {
        if (lines.length >= MAX_COST_BATCH_LINES) break;
        const mapped = toProposedLine(draft, invoiceFileId);
        if ('skip' in mapped) {
            skipped += 1;
            const existing = warnings.find((w) => w.code === mapped.skip);
            if (existing) {
                existing.params = { count: (existing.params?.count ?? 0) + 1 };
            } else {
                warnings.push({ code: mapped.skip, params: { count: 1 } });
            }
            continue;
        }
        lines.push(mapped.line);
    }

    /**
     * An overflow is REPORTED, never silently truncated.
     *
     * `MAX_COST_BATCH_LINES` is 25 because the batch is one interactive
     * transaction. Dropping 15 lines of a farmer's invoice without saying so
     * would be the worst failure available here: the sheet would look
     * complete and the total would be wrong.
     */
    if (read.lines.length > MAX_COST_BATCH_LINES) {
        warnings.push({
            code: 'INVOICE_LINES_TRUNCATED',
            params: { found: read.lines.length, proposed: MAX_COST_BATCH_LINES },
        });
    }
    if (read.unreadableLineCount > 0) {
        warnings.push({
            code: 'INVOICE_LINES_UNREADABLE',
            params: { count: read.unreadableLineCount },
        });
    }

    if (lines.length === 0) {
        // Every line was refused by the mapper — a lev-only invoice in a
        // foreign currency, say. The document WAS an invoice, so the code
        // differs from the not-recognised case above.
        throw codedClientError(
            422,
            'INVOICE_NO_USABLE_LINES',
            'We read the invoice but none of its lines can be recorded as a cost.',
            { invoiceFileId, skipped },
        );
    }

    logger.info('invoice scan proposed', {
        component: 'invoice-scan',
        tenantId: ctx.tenantId,
        proposed: lines.length,
        skipped,
        warnings: warnings.length,
    });

    return { invoiceFileId, lines, warnings };
}

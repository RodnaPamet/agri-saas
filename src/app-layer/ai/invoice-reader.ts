/**
 * Reading an invoice into proposed cost-sheet lines (#482).
 *
 * SERVER-ONLY — the Anthropic SDK and its key must never enter a client
 * bundle. Mirrors `ai/vision/claude-vision-provider.ts` deliberately: one
 * FORCED tool whose `input_schema` is a Zod schema, so the model returns a
 * validated object rather than JSON we have to reprompt for. That provider's
 * docblock is the reference for the pattern; what differs here is the input.
 *
 * **PDFs do not ride an `image` block.** The Messages API takes an image only
 * as one of four raster types (`SUPPORTED_MEDIA` in the pest provider), and the
 * owner's spec for this feature says "the invoice image or PDF" — a scan from
 * «Документи» is routinely one PDF. A PDF goes in a `document` block with
 * `media_type: 'application/pdf'` (`Anthropic.Messages.Base64PDFSource`), which
 * is a different content block, not a different media type on the same one.
 * Sending PDF bytes as an `image` is rejected by the API, so this is a
 * correctness requirement rather than a nicety.
 *
 * **This module proposes; it never writes.** Owner ruling on #482: "Automatic
 * means filled, not saved. A misread amount never reaches the calculator
 * unseen." So the output is a DRAFT in the shape the batch endpoint accepts,
 * and the farmer's tap is what persists it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { env } from '@/env';
import { COST_CATEGORIES } from '@/app-layer/schemas/grain.schemas';
import { logger } from '@/lib/observability/logger';

/**
 * The vision-capable model for this surface.
 *
 * Its own constant rather than an import of `DEFAULT_VISION_MODEL`: that one
 * is the pest classifier's choice and is free to move for agronomic reasons
 * that have nothing to do with reading a table of numbers.
 */
export const DEFAULT_INVOICE_MODEL = 'claude-sonnet-4-6';

/** Raster types the `image` block accepts; anything else must be a PDF. */
const SUPPORTED_IMAGE_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SupportedImageMedia = (typeof SUPPORTED_IMAGE_MEDIA)[number];

export const PDF_MEDIA = 'application/pdf';

/** True when these bytes must ride a `document` block rather than an `image`. */
export function isPdf(mimeType: string): boolean {
    return mimeType.trim().toLowerCase() === PDF_MEDIA;
}

/** True when this type can be sent at all. The ingest allowlist is the gate; this is the shape check. */
export function isReadableInvoiceMedia(mimeType: string): boolean {
    const m = mimeType.trim().toLowerCase();
    return isPdf(m) || (SUPPORTED_IMAGE_MEDIA as readonly string[]).includes(m);
}

function toImageMedia(mimeType: string): SupportedImageMedia {
    const m = mimeType.trim().toLowerCase();
    return (SUPPORTED_IMAGE_MEDIA as readonly string[]).includes(m)
        ? (m as SupportedImageMedia)
        : 'image/jpeg';
}

/**
 * One line as the MODEL reports it — not the line we propose.
 *
 * Two deliberate differences from `CreateCostEntrySchema`:
 *
 * - `currency` is what is PRINTED on the invoice, so a lev invoice comes back
 *   `BGN` and the usecase converts at the fixed peg. Asking the model to
 *   convert would put arithmetic in the one place we cannot check it.
 * - every attribution field is absent. The model cannot know which planting a
 *   drum of diesel belongs to, and a guess would put a wrong attribution into
 *   the Калкулатор — the one number the owner checks.
 */
const InvoiceLineDraftSchema = z.object({
    category: z
        .enum(COST_CATEGORIES)
        .describe(
            'The cost category this line belongs to. Use OTHER when none of the others clearly fits — never guess a specific one.',
        ),
    amount: z
        .number()
        .positive()
        .describe('The line total as printed, in the invoice currency. Not a unit price, and never negative.'),
    currency: z
        .string()
        .min(1)
        .max(8)
        .describe('The currency as printed: "BGN" for лв/лева, "EUR" for €/евро. Do not convert.'),
    incurredOn: z
        .string()
        .describe('The invoice date in YYYY-MM-DD. Use the document date, not today, and not a due date.'),
    supplier: z
        .string()
        .max(200)
        .nullable()
        .describe('The supplier/vendor name as printed, or null if it cannot be read.'),
    description: z
        .string()
        .max(400)
        .nullable()
        .describe('What this line is for, as printed on the invoice. Null if the line has no description.'),
    commodity: z
        .string()
        .max(80)
        .nullable()
        .describe(
            'The crop this line is for, ONLY if the invoice says so explicitly. Null otherwise — do not infer a crop from the product.',
        ),
});

export type InvoiceLineDraft = z.infer<typeof InvoiceLineDraftSchema>;

const InvoiceReadSchema = z.object({
    /**
     * `false` is a FIRST-CLASS answer, not a failure.
     *
     * A photo of a hand, a field, or a delivery note is an ordinary thing for a
     * farmer to send, and the remedy is "take it again" — which a 500 cannot
     * say. The usecase turns this into `INVOICE_NOT_RECOGNISED`.
     */
    isInvoice: z
        .boolean()
        .describe('True only if this document is an invoice, receipt or fiscal bill with at least one priced line.'),
    lines: z
        .array(InvoiceLineDraftSchema)
        .describe('One entry per priced line. Empty when isInvoice is false.'),
    /**
     * Lines the model SAW but could not read, counted rather than guessed.
     *
     * Without this, a 12-line invoice read as 9 is indistinguishable from a
     * 9-line invoice, and the farmer silently saves three lines short.
     */
    unreadableLineCount: z
        .number()
        .int()
        .min(0)
        .describe('How many priced lines you could see but could not read reliably. 0 if none.'),
});

export type InvoiceRead = z.infer<typeof InvoiceReadSchema>;

const SYSTEM_PROMPT =
    'You read agricultural invoices for a Bulgarian farm-accounting app and report their lines through the ' +
    'provided tool. Most documents are in Bulgarian and priced in лева (BGN) or euro (EUR). ' +
    'Report amounts EXACTLY as printed — never convert between currencies, never apply or remove VAT, ' +
    'and never total the lines yourself. Report the LINE total for each priced line, not a unit price. ' +
    'Be conservative: a phone photo of a paper invoice is often skewed, shadowed or partly cut off, and a ' +
    'confidently wrong number costs a farmer more than an unread one. If a line is not reliably legible, ' +
    'leave it out and count it in unreadableLineCount rather than guessing. If the document is not an ' +
    'invoice at all, set isInvoice to false and return no lines. Never invent a supplier, a date or a crop.';

/** Convert the Zod schema to an Anthropic `input_schema` without an `any`. */
function toInputSchema(): Anthropic.Messages.Tool.InputSchema {
    try {
        const native = z.toJSONSchema(InvoiceReadSchema) as Record<string, unknown>;
        if (native && Object.keys(native).some((k) => k !== '$schema')) {
            return native as Anthropic.Messages.Tool.InputSchema;
        }
    } catch {
        // Fall through to the package converter.
    }
    const convert = zodToJsonSchema as unknown as (
        s: unknown,
        opts: { target: string },
    ) => Record<string, unknown>;
    return convert(InvoiceReadSchema, { target: 'jsonSchema7' }) as Anthropic.Messages.Tool.InputSchema;
}

/** True when an Anthropic API key is configured. */
export function invoiceReaderAvailable(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
}

function client(): Anthropic {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('readInvoice requires ANTHROPIC_API_KEY to be set.');
    }
    return new Anthropic({
        apiKey,
        ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    });
}

/** The document, as bytes plus the type the INGEST resolved (never the client's claim). */
export interface InvoiceDocument {
    bytes: Buffer;
    mimeType: string;
}

/** Tokens the call cost, so the caller can write the usage ledger. */
export interface InvoiceReadUsage {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/**
 * The call's outcome AND what it cost.
 *
 * `usage` is present even when `read` is null, and that is the point: a
 * document the model could not read still SPENT tokens, so a caller that
 * recorded usage only on success would undercount exactly the requests a
 * farmer is most likely to repeat. `ai-spend-gate-covers-embeddings` is
 * explicit that the assertion and the ledger write are both required — an
 * assertion against a total nothing contributes to is a cap that never binds.
 */
export interface InvoiceReadOutcome {
    read: InvoiceRead | null;
    usage: InvoiceReadUsage;
}

/**
 * Read one invoice. `read` is `null` when the model produced no valid tool
 * output — the caller turns that into `INVOICE_NOT_RECOGNISED`, same as an
 * explicit `isInvoice: false`, because "could not read it" and "this is not an
 * invoice" have the same remedy for the person holding the phone.
 */
export async function readInvoice(
    doc: InvoiceDocument,
    opts: { model?: string } = {},
): Promise<InvoiceReadOutcome> {
    const anthropic = client();
    const tool: Anthropic.Messages.Tool = {
        name: 'report_invoice_lines',
        description: 'Report the structured lines read from this invoice.',
        input_schema: toInputSchema(),
    };

    const source: Anthropic.Messages.ContentBlockParam = isPdf(doc.mimeType)
        ? {
              type: 'document',
              source: { type: 'base64', media_type: PDF_MEDIA, data: doc.bytes.toString('base64') },
          }
        : {
              type: 'image',
              source: {
                  type: 'base64',
                  media_type: toImageMedia(doc.mimeType),
                  data: doc.bytes.toString('base64'),
              },
          };

    const model = opts.model ?? DEFAULT_INVOICE_MODEL;
    const response = await anthropic.messages.create({
        model,
        // Generous against 25 lines of structured output; the batch bound is
        // what stops a 200-line document, not this.
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [
            {
                role: 'user',
                content: [
                    source,
                    {
                        type: 'text',
                        text: 'Read this document and report its invoice lines via the tool.',
                    },
                ],
            },
        ],
    });

    let toolInput: unknown = null;
    for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === tool.name) {
            toolInput = block.input;
            break;
        }
    }

    const usage: InvoiceReadUsage = {
        model,
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
        totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };

    const parsed = InvoiceReadSchema.safeParse(toolInput);
    if (!parsed.success) {
        // NOT an error log: an unreadable photo is an ordinary outcome on this
        // surface, and paging on it would make the signal useless.
        logger.info('invoice read returned no valid tool output', {
            stopReason: response.stop_reason,
            isPdf: isPdf(doc.mimeType),
        });
        return { read: null, usage };
    }

    logger.info('invoice read', {
        isInvoice: parsed.data.isInvoice,
        lineCount: parsed.data.lines.length,
        unreadableLineCount: parsed.data.unreadableLineCount,
        isPdf: isPdf(doc.mimeType),
        totalTokens: usage.totalTokens,
    });

    return { read: parsed.data, usage };
}

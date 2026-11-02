/**
 * Read a supplier's promotion leaflet and PROPOSE its offers (#2664).
 *
 * The owner: *"I need to be able to give it context - like list of product
 * promotions from trading companies"*, uploaded as the file came and
 * **checked by the owner before use**. This module is the read half. It
 * proposes; a person confirms; `Promotion.publishedAt` stays null until they
 * do. `invoice-reader.ts` is the pattern and most of the reasoning here is
 * its reasoning — a forced tool whose `input_schema` is a Zod schema, so the
 * model returns a shape rather than prose to parse.
 *
 * ## IT DOES NOT PROPOSE `pppRegistrationNo`, AND THAT IS THE POINT
 *
 * `Promotion.pppRegistrationNo` decides whether Reg. (EC) 1107/2009 Art 66
 * applies — prescribed safety wording, prohibited claim types — so it decides
 * which legal regime a promotion is advertised under. Its own schema docblock
 * says it is "set by the owner at REVIEW time, resolved against
 * `PppRegisterEntry`" and "deliberately not derived from the AI read of a
 * supplier leaflet: a misread registration number would silently reclassify a
 * pesticide as a fertiliser, which is the one error in this feature that
 * matters."
 *
 * So the field is ABSENT FROM THE SCHEMA BELOW rather than present and
 * ignored. A model cannot report a value there is no slot for, which is a
 * guarantee where "we don't read that field" is a convention somebody can
 * tidy away. `tests/guards/promotion-read-proposes-no-ppp-number.test.ts`
 * holds it, because adding the field would look like an improvement.
 *
 * It also reports no PRICE as a number. `priceText` is the string as printed,
 * because a leaflet's price is routinely conditional — per tonne, on a minimum
 * order, "до изчерпване" — and a bare number loses the condition that makes it
 * true. The owner retypes what they mean into `body`.
 *
 * ## `isLeaflet: false` is a first-class answer
 *
 * A photo of a delivery note or a price list that is not a promotion is an
 * ordinary thing for support to be sent. The remedy is "this is not a
 * leaflet", which a 500 cannot say.
 *
 * ## XLSX is storable and NOT readable, stated rather than discovered
 *
 * The owner asked to upload "PDF, Excel, photo of a leaflet". The Anthropic
 * `document` block takes PDF; there is no spreadsheet block. So a workbook is
 * accepted, scanned and stored like any other upload, and this module refuses
 * it with a code the console can turn into "stored — type the offers in".
 * Silently returning an empty read would look identical to a leaflet with no
 * offers on it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { env } from '@/env';
import { isPdf, isReadableInvoiceMedia, PDF_MEDIA } from './invoice-reader';
import { isPlatformAiSpendAllowed, recordPlatformAiUsage } from './platform-budget';

export const DEFAULT_LEAFLET_MODEL = 'claude-sonnet-4-6';

/** The media this module can actually send to a model. */
export function isReadableLeafletMedia(mimeType: string): boolean {
    // Deliberately the invoice predicate rather than a second copy: the two
    // read the same block types, and a divergence would mean one reader
    // accepting bytes the other cannot send.
    return isReadableInvoiceMedia(mimeType);
}

const OfferDraftSchema = z.object({
    productName: z
        .string()
        .max(200)
        .describe('The product or service on offer, as printed. Never translated, never expanded.'),
    priceText: z
        .string()
        .max(200)
        .nullable()
        .describe(
            'The price EXACTLY as printed, including its unit and any condition — "от 1 200 лв./т", '
            + '"-15% до изчерпване". Null if the leaflet states no price. Never convert a currency '
            + 'and never drop a condition to make it a plain number.',
        ),
    validityText: z
        .string()
        .max(200)
        .nullable()
        .describe('The offer period as printed, if the leaflet states one for this offer. Null otherwise.'),
    note: z
        .string()
        .max(400)
        .nullable()
        .describe('Any further condition printed beside this offer. Null if there is none.'),
});

export type OfferDraft = z.infer<typeof OfferDraftSchema>;

/**
 * EXPORTED for the guard, which serialises it and asserts no plant-protection
 * field exists at any depth. Asserting on the generated JSON Schema rather
 * than this file's text is the stronger check: the JSON Schema is what the
 * model is actually offered, and a field reachable through a `.extend()` or a
 * nested object would satisfy a source grep for `pppRegistrationNo` and still
 * reach the model.
 */
export const LeafletReadSchema = z.object({
    isLeaflet: z
        .boolean()
        .describe(
            'True only if this document is a commercial promotion, offer sheet or price leaflet from a '
            + 'supplier. False for a delivery note, an invoice, a field photo or an internal document.',
        ),
    companyName: z
        .string()
        .max(200)
        .nullable()
        .describe(
            'The company presenting the offers, as printed. Null if the document does not name one. '
            + 'Do not infer it from a logo you are unsure of.',
        ),
    offers: z
        .array(OfferDraftSchema)
        .describe('One entry per distinct offer. Empty when isLeaflet is false.'),
    unreadableOfferCount: z
        .number()
        .int()
        .min(0)
        .describe(
            'How many offers you could see but could not read reliably. 0 if none. Counted rather '
            + 'than guessed: a six-offer leaflet read as four is otherwise indistinguishable from a '
            + 'four-offer leaflet.',
        ),
});

export type LeafletRead = z.infer<typeof LeafletReadSchema>;

const SYSTEM_PROMPT =
    'You read supplier promotion leaflets for a Bulgarian agriculture app and report their offers '
    + 'through the provided tool. Most leaflets are in Bulgarian and priced in лева (BGN) or euro (EUR). '
    + 'Report what is PRINTED. Do not infer a price from a similar product, do not convert currencies, '
    + 'do not translate product names, and do not describe a product as safe, harmless or non-toxic '
    + 'even if the leaflet does — report the product name and leave claims out.';

export function leafletReaderAvailable(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
}

function client(): Anthropic {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('readPromotionLeaflet requires ANTHROPIC_API_KEY to be set.');
    }
    return new Anthropic({
        apiKey,
        ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    });
}

/** The leaflet, as bytes plus the type the INGEST resolved — never the client's claim. */
export interface LeafletDocument {
    bytes: Buffer;
    mimeType: string;
}

export interface LeafletReadUsage {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/**
 * The outcome AND what it cost.
 *
 * `usage` is present even when `read` is null, for `invoice-reader`'s reason:
 * a document the model could not read still SPENT tokens, so a caller that
 * recorded usage only on success would undercount exactly the uploads a person
 * is most likely to repeat.
 */
export interface LeafletReadOutcome {
    read: LeafletRead | null;
    usage: LeafletReadUsage;
    /**
     * The PLATFORM budget refused this call, so no tokens were spent.
     *
     * Distinguished from `read: null`, which means the model answered and the
     * answer was unusable. The two have different remedies — wait for the
     * month to turn or raise the ceiling, versus type the offers in — and
     * collapsing them would tell an operator to retype a leaflet that would
     * have read perfectly tomorrow.
     */
    refused: boolean;
}

function toInputSchema(): Anthropic.Messages.Tool['input_schema'] {
    return z.toJSONSchema(LeafletReadSchema, {
        target: 'draft-7',
        io: 'input',
    }) as Anthropic.Messages.Tool['input_schema'];
}

/**
 * THE GATE AND THE LEDGER LIVE HERE, beside the call they are about.
 *
 * Not in the usecase. An exemption reading "my only caller gates" is a claim
 * nothing enforces, in a guard whose population is derived from the filesystem
 * precisely so a second caller cannot arrive ungated — so this file does both
 * halves, which is how its four `PLATFORM_GATED` siblings are arranged.
 *
 * Both halves are required and for different reasons: the assertion alone caps
 * against a total nothing contributes to, so the cap never binds; the
 * recording alone gives an operator a number with no lever.
 *
 * Usage is recorded even when the read is UNUSABLE, because a document the
 * model could not read still spent the tokens. It is NOT recorded when the
 * budget refused, because then nothing was spent.
 */
export async function readPromotionLeaflet(
    doc: LeafletDocument,
    opts: { model?: string } = {},
): Promise<LeafletReadOutcome> {
    const model = opts.model ?? DEFAULT_LEAFLET_MODEL;
    const zero: LeafletReadUsage = { model, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    if (!(await isPlatformAiSpendAllowed('promotion-leaflet-read'))) {
        return { read: null, usage: zero, refused: true };
    }

    const anthropic = client();
    const tool: Anthropic.Messages.Tool = {
        name: 'report_leaflet_offers',
        description: 'Report the structured offers read from this promotion leaflet.',
        input_schema: toInputSchema(),
    };

    const source = isPdf(doc.mimeType)
        ? ({
              type: 'document' as const,
              source: {
                  type: 'base64' as const,
                  media_type: PDF_MEDIA as 'application/pdf',
                  data: doc.bytes.toString('base64'),
              },
          })
        : ({
              type: 'image' as const,
              source: {
                  type: 'base64' as const,
                  media_type: doc.mimeType.trim().toLowerCase() as 'image/jpeg',
                  data: doc.bytes.toString('base64'),
              },
          });

    const response = await anthropic.messages.create({
        model,
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
                        text: 'Read this leaflet and report its offers via the tool.',
                    },
                ],
            },
        ],
    });

    const usage: LeafletReadUsage = {
        model,
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
        totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };

    await recordPlatformAiUsage({
        job: 'promotion-leaflet-read',
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
    });

    const block = response.content.find((c) => c.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return { read: null, usage, refused: false };

    const parsed = LeafletReadSchema.safeParse(block.input);
    // A tool call whose payload does not satisfy the schema is NOT a partial
    // success. Returning the valid half would hand the console a leaflet with
    // some offers missing and nothing saying so.
    return { read: parsed.success ? parsed.data : null, usage, refused: false };
}

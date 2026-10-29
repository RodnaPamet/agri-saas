/**
 * Cloud vision fallback — Anthropic Messages-API vision via the official
 * `@anthropic-ai/sdk`. Used when the on-device ONNX model is absent or
 * its confidence is below the orchestrator's fallback threshold.
 *
 * SERVER-ONLY — the Anthropic SDK + API key must never enter a client
 * bundle. Reuses the same `ANTHROPIC_API_KEY` (+ optional
 * `ANTHROPIC_BASE_URL`) config as `provider/claude-provider.ts`, and the
 * same forced-tool structured-output pattern: the image rides as a
 * base64 `image` content block, and a single FORCED tool whose
 * `input_schema` is the pest-result Zod schema makes the model return a
 * validated structured object (more reliable than JSON reprompting).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import type { PestIdentification, VisionImage, VisionProvider } from './types';

/** Default vision-capable Claude model for the photo-classification path. */
export const DEFAULT_VISION_MODEL = 'claude-sonnet-4-6';

/** Media types the Anthropic image block accepts. */
const SUPPORTED_MEDIA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SupportedMedia = (typeof SUPPORTED_MEDIA)[number];

function toSupportedMedia(mimeType: string): SupportedMedia {
    const m = mimeType.toLowerCase();
    return (SUPPORTED_MEDIA as readonly string[]).includes(m) ? (m as SupportedMedia) : 'image/jpeg';
}

/**
 * The forced-tool input schema — what the model must return. Mirrors
 * `PestIdentification` minus the fields the provider stamps itself
 * (`modelVersion`, `backend`).
 */
const ClaudePestSchema = z.object({
    identifiedPest: z
        .string()
        .describe('Best-guess pest, disease, or deficiency name; "unknown" if unclear or healthy.'),
    confidence: z.number().min(0).max(1).describe('Confidence in [0,1]. Be conservative on noisy field photos.'),
    recommendation: z
        .string()
        .min(1)
        .max(600)
        .describe('Brief, practical next step, always framed as provisional pending agronomist confirmation.'),
});
type ClaudePestResult = z.infer<typeof ClaudePestSchema>;

const SYSTEM_PROMPT =
    'You are a careful crop-scouting assistant examining a single field photo of a plant leaf or crop. ' +
    'Identify any pest, disease, or nutrient deficiency visible. Be conservative: field photos are noisier ' +
    'than lab images, so when the image is unclear or you are not reasonably sure, set identifiedPest to ' +
    '"unknown" with a low confidence. NEVER fabricate a specific diagnosis. Always frame the recommendation ' +
    'as provisional, pending confirmation by a qualified agronomist.';

/** Convert the Zod schema to an Anthropic tool input_schema (no `any`). */
function toInputSchema(): Anthropic.Messages.Tool.InputSchema {
    try {
        const native = z.toJSONSchema(ClaudePestSchema) as Record<string, unknown>;
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
    return convert(ClaudePestSchema, { target: 'jsonSchema7' }) as Anthropic.Messages.Tool.InputSchema;
}

export class ClaudeVisionProvider implements VisionProvider {
    readonly backend = 'claude' as const;
    private readonly model: string;

    constructor(model?: string) {
        this.model = model ?? DEFAULT_VISION_MODEL;
    }

    /** True when an Anthropic API key is configured. */
    async available(): Promise<boolean> {
        return Boolean(env.ANTHROPIC_API_KEY);
    }

    private client(): Anthropic {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('ClaudeVisionProvider requires ANTHROPIC_API_KEY to be set.');
        }
        return new Anthropic({
            apiKey,
            ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
        });
    }

    async identify(image: VisionImage): Promise<PestIdentification> {
        const client = this.client();
        const tool: Anthropic.Messages.Tool = {
            name: 'report_identification',
            description: 'Report the structured pest/disease identification for the photo.',
            input_schema: toInputSchema(),
        };

        const response = await client.messages.create({
            model: this.model,
            max_tokens: 512,
            system: SYSTEM_PROMPT,
            tools: [tool],
            tool_choice: { type: 'tool', name: tool.name },
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: toSupportedMedia(image.mimeType),
                                data: image.bytes.toString('base64'),
                            },
                        },
                        {
                            type: 'text',
                            text: 'Examine this field photo and report any pest, disease, or deficiency via the tool.',
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

        const parsed = ClaudePestSchema.safeParse(toolInput);
        if (!parsed.success) {
            throw new Error(
                `Claude vision returned no valid tool output (stop_reason: ${response.stop_reason}).`,
            );
        }

        const result: ClaudePestResult = parsed.data;
        logger.info('claude vision identify', {
            component: 'vision',
            backend: 'claude',
            identifiedPest: result.identifiedPest,
            confidence: result.confidence,
        });
        return {
            identifiedPest: result.identifiedPest,
            confidence: result.confidence,
            recommendation: result.recommendation,
            modelVersion: this.model,
            backend: 'claude',
        };
    }
}

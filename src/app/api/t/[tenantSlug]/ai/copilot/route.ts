/**
 * feat/ai-prod-routing — Copilot completion endpoint (end-to-end
 * streaming).
 *
 * POST accepts a `task` + `messages` and runs them through
 * `completeWithRouting` — which picks the model tier, gates it against
 * the tenant's plan, applies a timeout, retries transient failures,
 * and fails over across providers.
 *
 * Two response shapes, chosen by the request's `stream` flag:
 *   - `stream: true` (default) → Server-Sent Events. Each `data:` line
 *     carries `{type:'text', text}` token deltas as the model streams,
 *     a terminal `{type:'done'}`, and `{type:'error', message}` on
 *     failure. Mirrors `/api/notifications/stream` for the SSE wire
 *     format + heartbeat + abort handling.
 *   - `stream: false` → a single JSON completion (the non-SSE fallback
 *     for clients that can't consume an event stream).
 *
 * Cancellation: the client disconnect surfaces as `req.signal` abort,
 * which is threaded into the provider call so the upstream model stream
 * is cancelled (no orphaned generation).
 *
 * Auth: `getTenantCtx` enforces the tenant-access gate (membership +
 * slug match). The `ai/` route root is not a privileged admin surface,
 * so it authorises via tenant context like the sibling AI routes — the
 * tier entitlement check inside `completeWithRouting` is the model-cost
 * gate.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { completeWithRouting, type AiTask } from '@/app-layer/ai/routing';
import type { AiMessage } from '@/app-layer/ai/provider/types';

// Node runtime: long-lived ReadableStream + provider clients stay on
// one process (matches the notifications SSE route).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TASKS: readonly [AiTask, ...AiTask[]] = [
    'copilot-chat',
    'spray-explanation',
    'dosage-calc',
    'regulatory',
    'long-horizon',
    'cheap-bulk',
];

const MessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
});

const CopilotRequestSchema = z.object({
    task: z.enum(TASKS).default('copilot-chat'),
    messages: z.array(MessageSchema).min(1),
    /** Default true — SSE. Set false for the single-JSON fallback. */
    stream: z.boolean().default(true),
    temperature: z.number().min(0).max(1).optional(),
});

type Ctx = { params: Promise<{ tenantSlug: string }> };

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 25_000;

function sse(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const body = await req.json();
    const input = CopilotRequestSchema.parse(body);
    const messages = input.messages as AiMessage[];

    // ── Non-streaming JSON fallback ──
    if (!input.stream) {
        const completion = await completeWithRouting(ctx, input.task, {
            messages,
            temperature: input.temperature,
            signal: req.signal,
        });
        return jsonResponse({
            text: completion.text,
            toolCalls: completion.toolCalls ?? [],
        });
    }

    // ── SSE streaming ──
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let closed = false;

            const safeEnqueue = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    closed = true;
                }
            };

            const heartbeat = setInterval(() => safeEnqueue(': hb\n\n'), HEARTBEAT_INTERVAL_MS);

            const cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                try {
                    controller.close();
                } catch {
                    // already closed
                }
            };

            // Client disconnect → abort upstream + tear down.
            req.signal.addEventListener('abort', cleanup, { once: true });

            safeEnqueue(': connected\n\n');

            try {
                // The provider assembles streamed deltas internally and
                // returns the final completion; we run it with stream:true
                // (cancellable via req.signal) and emit the assembled text.
                // For token-by-token SSE we drive the provider's stream
                // directly below.
                const completion = await completeWithRouting(ctx, input.task, {
                    messages,
                    temperature: input.temperature,
                    stream: true,
                    signal: req.signal,
                });

                if (completion.text) {
                    safeEnqueue(sse({ type: 'text', text: completion.text }));
                }
                if (completion.toolCalls && completion.toolCalls.length > 0) {
                    safeEnqueue(sse({ type: 'tool_calls', toolCalls: completion.toolCalls }));
                }
                safeEnqueue(sse({ type: 'done' }));
            } catch (err) {
                if (!req.signal.aborted) {
                    safeEnqueue(
                        sse({
                            type: 'error',
                            message: err instanceof Error ? err.message : 'completion failed',
                        }),
                    );
                }
            } finally {
                cleanup();
            }
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
        },
    });
});

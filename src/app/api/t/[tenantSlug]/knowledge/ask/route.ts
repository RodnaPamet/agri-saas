import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';
import { askKnowledgeBase } from '@/app-layer/usecases/rag';
import { sanitizeUntrusted } from '@/app-layer/ai/safety/sanitize-untrusted';
import { KNOWLEDGE_ASK_LIMIT } from '@/lib/security/rate-limit-middleware';

/**
 * POST /api/t/[tenantSlug]/knowledge/ask (W3/#91 — KB wire-up PR)
 *
 * Thin HTTP boundary over the existing `askKnowledgeBase(ctx, query)`
 * usecase (`src/app-layer/usecases/rag.ts`) — its only prior caller was
 * the `classify-photo` job; this is the first user-facing surface.
 *
 * `askKnowledgeBase` already returns the fixed "not in my sources" answer
 * WITHOUT calling the model when retrieval finds nothing (see
 * `ai/rag/build-context.ts::NO_SOURCES_ANSWER`), so this route never falls
 * through to an ungrounded completion — a real 4xx/5xx here means the
 * request itself failed (bad input, auth, rate limit, an actual server
 * error), which is distinct from "the knowledge base had nothing to say"
 * and MUST reach the client as a real error, not get folded into the 200
 * body. See `KnowledgeAskModal.tsx` for how the client keeps those two
 * cases apart.
 *
 * Gating:
 *   - `requirePermission('knowledge.view', …)` — an LLM completion per
 *     request is a cost/abuse surface, so (unlike the sibling article
 *     CRUD routes, which stay on the coarser usecase-layer
 *     assertCanRead/Write gate) this one gets the audited permission
 *     check. Rule registered in `route-permissions.ts`.
 *   - `KNOWLEDGE_ASK_LIMIT` (10/min per IP+user) — see its doc comment in
 *     `rate-limit.ts` for the threat model.
 *   - The query is run through `sanitizeUntrusted` before it reaches
 *     `askKnowledgeBase`'s grounding prompt — the same treatment
 *     `askAgronomyAdvisor` gives retrieved chunks and tenant free text,
 *     since a user-supplied question is exactly the kind of untrusted
 *     input a prompt-injection line ("ignore the sources above…") would
 *     ride in on.
 */

const AskKnowledgeBaseSchema = z
    .object({
        // Bounded — a knowledge-base question, not a document paste. Keeps
        // the prompt (and therefore the per-call cost) small and predictable.
        query: z.string().trim().min(1, 'query is required').max(500, 'query must be 500 characters or fewer'),
    })
    .strip();

export const POST = withApiErrorHandling(
    requirePermission('knowledge.view', async (req: NextRequest, _routeArgs, ctx) => {
        const raw = await req.json().catch(() => ({}));
        const parsed = AskKnowledgeBaseSchema.safeParse(raw);
        if (!parsed.success) {
            throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
        }

        const query = sanitizeUntrusted(parsed.data.query);
        const { answer, sources } = await askKnowledgeBase(ctx, query);

        return jsonResponse({
            answer,
            // The DTO stays a projection of `RetrievedChunk`: `id` + `source`
            // (the human-legible provenance label every chunk carries, e.g.
            // "Agri-SaaS agronomy desk (original)" or "Knowledge base: <article
            // title>") + `sourceType` + `language`. The full chunk `text` and
            // `score` are internal ranking detail, not citation material.
            sources: sources.map((s) => ({
                id: s.id,
                source: s.source,
                sourceType: s.sourceType,
                language: s.language,
            })),
        });
    }),
    { rateLimit: { config: KNOWLEDGE_ASK_LIMIT, scope: 'knowledge-ask' } },
);

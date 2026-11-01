/**
 * «Асистент» phase 2 — it PROPOSES, a person confirms — #2578.
 *
 * ## The owner's constraint, and what enforces it
 *
 * "Asked to DO something it PREPARES it; a person confirms with one tap. The
 * assistant never executes." So this module writes nothing, and that is held
 * by `tests/guards/assistant-proposes-but-never-writes.test.ts` rather than by
 * this sentence: it fails if anything here imports a create/update usecase, a
 * repository, or the Prisma client.
 *
 * What it produces is a DRAFT — an entity create body with no id — which the
 * client uses to prefill the real form. The person submits it through the
 * route that already exists, so every policy, audit write and validation on
 * that path applies unchanged. That is the owner's ruling, confirmed in
 * session: a prefilled existing form, and no queue table.
 *
 * ## Validated against the PRODUCTION schema, not a copy
 *
 * The draft is checked against `CreateLogEntrySchema` — the same schema
 * `POST /api/t/{slug}/journal` validates with. So a draft that would be
 * refused by the real route cannot be offered. A copy of that schema here
 * would be a second answer to one question, which is how two answers diverge.
 *
 * ## No IDs in a draft, and that is the provenance problem again
 *
 * `CreateLogEntrySchema` accepts `locationIds`, `equipmentIds` and
 * `operationParcelId`. A model filling those would be fabricating record
 * references — exactly what `links.ts` avoids by building links from tool
 * results rather than trusting the model for them.
 *
 * There is no equivalent escape here, because a draft's field VALUES are
 * inherently generative: no server-side derivation can turn "I sprayed the
 * north block yesterday" into a parcel id. So ids are simply excluded from
 * what the model may propose. The person picks the block in the form, where
 * they can see it. When a location tool exists, an id that came from ITS
 * result could be admitted on the same provenance argument links use — and
 * that is a change with its own review, not an omission to quietly fill.
 */
import { z } from 'zod';

import { CreateLogEntrySchema } from '@/lib/schemas';

/** The kinds of thing the assistant may propose. A closed set. */
export const PROPOSAL_KINDS = ['journal-entry'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export interface AssistantProposal {
    readonly kind: ProposalKind;
    /** An entity create body. No id — nothing has been written. */
    readonly draft: Record<string, unknown>;
}

/**
 * What the model may fill in for a Дневник entry.
 *
 * A deliberate SUBSET of `CreateLogEntrySchema`: the fields a conversation can
 * legitimately determine. `.strict()`, so a model reaching for `locationIds`
 * is refused rather than silently stripped — a silent strip would hand
 * somebody a form missing the link they asked for, with nothing saying so.
 */
export const ProposeJournalEntryArgs = z
    .object({
        type: z.string().min(1).max(64),
        title: z.string().min(1).max(500),
        notes: z.string().max(4000).optional(),
        status: z.enum(['PLANNED', 'DONE']).optional(),
        occurredAt: z.string().max(40).optional(),
    })
    .strict();

export interface ProposalOutcome {
    readonly ok: boolean;
    /** Present only when the draft validated against the production schema. */
    readonly proposal: AssistantProposal | null;
    /** For the MODEL to read — why its draft was refused, so it can retry. */
    readonly message: string;
}

/**
 * Validate a proposed Дневник entry. Writes nothing.
 *
 * Returns `ok: false` with a reason rather than throwing, for `runTool`'s
 * reason: the model can act on a refusal and cannot act on a dead stream.
 */
export function proposeJournalEntry(args: unknown): ProposalOutcome {
    const narrow = ProposeJournalEntryArgs.safeParse(args);
    if (!narrow.success) {
        return {
            ok: false,
            proposal: null,
            message: `Draft rejected: ${narrow.error.issues[0]?.message ?? 'invalid'}`,
        };
    }
    // Against the PRODUCTION schema. `type` is a string above rather than the
    // enum, so that an unknown value is refused HERE, by the same check the
    // real route applies, instead of by a copy of its value list that could
    // drift from the schema.
    const real = CreateLogEntrySchema.safeParse(narrow.data);
    if (!real.success) {
        return {
            ok: false,
            proposal: null,
            message: `Draft would be refused by the journal API: ${
                real.error.issues[0]?.message ?? 'invalid'
            }`,
        };
    }
    return {
        ok: true,
        proposal: { kind: 'journal-entry', draft: narrow.data as Record<string, unknown> },
        message: 'Draft prepared. The person confirms it; nothing has been saved.',
    };
}

/**
 * Errors that NAME THEMSELVES — a stable code plus the scalars a client
 * interpolates into its own translated sentence (#1447).
 *
 * ## Why this exists separately from `AppError`
 *
 * `AppError` already carries `code` + `params`, and `toApiErrorResponse`
 * already puts both on the wire — for a REQUEST. A background job has no
 * response to put them on: BullMQ persists `err.message` and nothing else,
 * so the only thing that reached a farmer polling an import was English
 * free text in `failedReason`. The job layer therefore needs to recognise
 * "this refusal named itself" on a thrown value, not on a response.
 *
 * ## Why a brand and not `typeof err.code === 'string'`
 *
 * Because that test is already true of errors we did not write. Node puts
 * `code: 'ENOENT'` on an fs failure and `'ECONNREFUSED'` on a socket one;
 * Prisma puts `code: 'P2002'` on a unique-constraint violation. Every one
 * of those matches `/^[A-Z][A-Z0-9_]{2,}$/`, so duck-typing would have
 * shipped a storage errno to a phone as if it were a documented refusal
 * code — undocumented by definition, and a small infrastructure leak.
 * The brand says "a person chose this code and wrote it in the spec".
 *
 * ## Why a field and not `instanceof`
 *
 * A plain boolean field survives a second copy of this module in a bundle;
 * `instanceof` does not. The worker, the Next server and the test runner
 * each build their own graph, and an `instanceof` that silently answers
 * `false` in one of them would degrade to the English-only path with
 * nothing failing — the exact failure this change exists to remove.
 */
import type { ErrorParams } from './types';

/**
 * The contract a thrower opts into. `code` is REQUIRED: an error carrying
 * the brand without a code would be worse than an unbranded one, because
 * the consumer would stop looking at the message.
 */
export interface CodedFailure {
    readonly isCodedFailure: true;
    readonly code: string;
    readonly params?: ErrorParams;
}

/** True when `e` named itself with a client-facing code. */
export function isCodedFailure(e: unknown): e is Error & CodedFailure {
    if (typeof e !== 'object' || e === null) return false;
    const candidate = e as { isCodedFailure?: unknown; code?: unknown };
    return candidate.isCodedFailure === true && typeof candidate.code === 'string';
}

/**
 * Base for a refusal whose cause is a stable code.
 *
 * Subclass it when the refusal needs more (a status, say); throw it
 * directly when the code and message are the whole story.
 */
export class CodedFailureError extends Error implements CodedFailure {
    readonly isCodedFailure = true as const;

    constructor(
        message: string,
        readonly code: string,
        readonly params?: ErrorParams,
    ) {
        super(message);
        this.name = 'CodedFailureError';
    }
}

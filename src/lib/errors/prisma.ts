import { Prisma } from '@prisma/client';

/**
 * Prisma's unique-constraint violation (P2002).
 *
 * This is the backstop for the offline idempotency race: two replays of the
 * same queued item reach the unique `(tenantId, clientMutationId)` index
 * concurrently, and the loser must re-read the winner's row rather than
 * surface an error for work that DID happen.
 *
 * Shared because the predicate was written out three times independently
 * (journal, field-operation, automation dispatch) and a fourth copy is how a
 * detail like the error code drifts between call sites that must agree.
 */
export function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

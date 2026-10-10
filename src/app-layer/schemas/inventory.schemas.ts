/**
 * Inventory lots — the write schemas the routes and the spec share.
 *
 * Lifted VERBATIM out of six route files, for the reason `catalog.schemas.ts`
 * and `planning.schemas.ts` were: the spec must describe the same body the
 * handler validates, and a paths module cannot import a route file without
 * pulling the handler's import graph into the generator.
 *
 * ── one rule here is load-bearing and easy to lose ──
 *
 * `AdjustSchema.delta` REFUSES ZERO. An adjustment of nothing is not a
 * correction, it is a ledger entry that says a human touched the stock and
 * changed nothing — and the ledger is hash-chained and append-only, so it
 * cannot be removed afterwards. The refinement is the guard; keep it.
 */
import { z } from 'zod';

import { requestTimestamp } from '@/lib/schemas/timestamp';

export const LotQuerySchema = z
    .object({
        itemId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
    })
    .strip();

export const CreateLotSchema = z
    .object({
        itemId: z.string().min(1),
        lotCode: z.string().min(1).max(120),
        locationId: z.string().nullable().optional(),
        /**
         * Both validated rather than bare `z.string()` (#1558). They reached
         * `inventory.ts:208-209` as
         * `input.expiresAt ? new Date(input.expiresAt) : null` with no
         * `isNaN` check on the path, so `expiresAt: "abcd"` became an
         * `Invalid Date`, Prisma refused it, and the route answered **500**
         * where the contract says 400.
         *
         * `requestTimestamp()` and not `instantTimestamp()`: an expiry or
         * receipt is as plausibly a day as an instant, and the web client
         * sends `expiresAt` as a full instant while sending `receivedAt` not
         * at all — so accepting both shapes costs nothing and refusing a day
         * would be a contract decision nobody has asked for. The only inputs
         * newly rejected are the ones that used to 500.
         */
        expiresAt: requestTimestamp().nullable().optional(),
        receivedAt: requestTimestamp().nullable().optional(),
        unitCostAmount: z.number().nonnegative().nullable().optional(),
        unitCostCurrency: z.string().max(8).nullable().optional(),
        initialQuantity: z.number().nonnegative().nullable().optional(),
    })
    .strip();

export const UpdateLotSchema = z
    .object({
        locationId: z.string().min(1).nullable(),
    })
    .strip();

export const ReceiveSchema = z.object({ quantity: z.number().positive() }).strip();

export const AdjustSchema = z
    .object({ delta: z.number().refine((n) => n !== 0, 'delta must be non-zero'), reason: z.string().min(1).max(500) })
    .strip();

export const LedgerQuerySchema = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
    })
    .strip();
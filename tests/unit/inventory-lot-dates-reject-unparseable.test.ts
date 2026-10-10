/**
 * Lot dates refuse what cannot be parsed, instead of 500ing (#1558).
 *
 * ## The failure
 *
 * `CreateLotSchema.expiresAt` / `.receivedAt` were bare `z.string()`, and
 * `inventory.ts:208-209` does
 *
 *     expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
 *
 * with no `isNaN` check anywhere on that path. So `expiresAt: "abcd"` cleared
 * the boundary, became an `Invalid Date`, and Prisma refused it — a **500** on
 * a request the published contract answers 400.
 *
 * This is the class-2 case of #1558's three. It is louder than the lease
 * fallbacks (#1563) — a 500 is a bug report, where a silent substitution is a
 * wrong number in the books — but it is on a live tenant route.
 *
 * ## Which door, and why that mattered
 *
 * There are two write sites taking an `expiresAt` in this module, and only one
 * needed fixing:
 *
 *   `createLot`         ← POST /inventory/lots, CreateLotSchema   UNGUARDED
 *   `recordHarvestLot`  ← journal.ts:325, HarvestLotPayloadSchema already
 *                         guarded by `instantTimestamp()` since #1559
 *
 * Enumerating callers rather than patching both is the #1557 lesson: the
 * protection lives at the DOOR, so the question is which doors exist.
 * `yield-record.ts` discusses `recordHarvestLot` in three comments and calls it
 * zero times, which is the kind of thing a grep for the name alone gets wrong.
 */
import { z } from 'zod';

import { CreateLotSchema } from '@/app-layer/schemas/inventory.schemas';

const lot = (over: Record<string, unknown> = {}) => ({
    itemId: 'item-1',
    lotCode: 'LOT-1',
    ...over,
});

describe('CreateLot dates reject unparseable input (#1558)', () => {
    it('the valid payload still parses — the positive control', () => {
        // Without this, every rejection below could be a schema broken for an
        // unrelated reason and would read as validation.
        expect(CreateLotSchema.safeParse(lot()).success).toBe(true);
    });

    describe('both shapes accepted — these are not instant-only fields', () => {
        // The web client sends `expiresAt` as a full instant
        // (InventoryClient.tsx:451) and sends `receivedAt` nowhere. An expiry
        // is as plausibly a day as an instant, so `requestTimestamp()` is the
        // fit and `instantTimestamp()` would be a contract decision nobody
        // asked for. These assertions are what stop that swap.
        it.each([
            ['a UTC instant', '2026-10-08T00:00:00.000Z'],
            ['a bare day', '2026-10-08'],
            ['an explicit offset', '2026-10-08T03:00:00+03:00'],
        ])('%s', (_label, value) => {
            expect(CreateLotSchema.safeParse(lot({ expiresAt: value })).success).toBe(true);
            expect(CreateLotSchema.safeParse(lot({ receivedAt: value })).success).toBe(true);
        });
    });

    describe('null and absent still work — they are the normal case', () => {
        it('omitted', () => {
            expect(CreateLotSchema.safeParse(lot()).success).toBe(true);
        });
        it('explicit null, which is what the client sends with no date picked', () => {
            expect(CreateLotSchema.safeParse(lot({ expiresAt: null, receivedAt: null })).success).toBe(
                true,
            );
        });
    });

    describe('unparseable is REFUSED — the 500 becomes a 400', () => {
        it.each(['abcd', 'not-a-date', '2026-13-45', 'tomorrow', '   '])('%p', (bad) => {
            expect(CreateLotSchema.safeParse(lot({ expiresAt: bad })).success).toBe(false);
            expect(CreateLotSchema.safeParse(lot({ receivedAt: bad })).success).toBe(false);
        });

        it('those really were Invalid Dates, so the old path really did 500', () => {
            // The premise, asserted rather than described.
            for (const bad of ['abcd', '2026-13-45', 'tomorrow']) {
                expect(new Date(bad).getTime()).toBeNaN();
            }
        });

        it('the shape it REPLACED would have accepted them — the control', () => {
            // Pins what actually changed. Reconstructs the old declaration
            // rather than poking at the live schema's internals, so the
            // comparison is between two things this test can both evaluate.
            //
            // The first version of this assertion was worthless — it checked
            // that a local was defined and that `null === null`. It passed, it
            // read like a control, and it could not have failed. Rewritten
            // because a control that cannot express failure is worse than none:
            // it reports confidence it has not earned.
            const before = z.object({
                itemId: z.string().min(1),
                lotCode: z.string().min(1).max(120),
                expiresAt: z.string().nullable().optional(),
            });

            for (const bad of ['abcd', 'not-a-date', '2026-13-45']) {
                expect(before.safeParse(lot({ expiresAt: bad })).success).toBe(true);
                expect(CreateLotSchema.safeParse(lot({ expiresAt: bad })).success).toBe(false);
            }
        });
    });

    describe('does not widen on another axis', () => {
        it.each([0, 1760000000000, true, {}, []])('rejects the non-string %p', (bad) => {
            expect(CreateLotSchema.safeParse(lot({ expiresAt: bad })).success).toBe(false);
        });
    });
});

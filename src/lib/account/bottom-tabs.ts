/**
 * The caller's own bottom-row tab arrangement.
 *
 * Self-service and account-level, mirroring `updateOwnUiLanguage`: it acts on
 * the authenticated user id only, so one user can never rearrange another's
 * bar.
 *
 * ── Shape, not vocabulary ──
 *
 * The stored value is an ORDERED array of tenant-relative href suffixes —
 * `/dashboard`, `/farm-tasks`, `/grain/costs` — the same vocabulary
 * `BottomTabBar` already matches on. It is validated for SHAPE ONLY and never
 * against a list of known tabs.
 *
 * That is deliberate. A server-side allowlist would mean every new client tab
 * waits on a server deploy before anyone could put it in their bar, and the
 * web and native release cycles are not coupled. It also makes an id from a
 * newer app version degrade to "not shown" on older clients rather than
 * rejecting the whole save.
 *
 * ── A preference, not a grant ──
 *
 * Consumers MUST resolve the stored list against the surfaces the member may
 * actually reach, on every render. A role can change after the write, so a
 * list validated only when stored would go on offering a MECHANISATOR a tab
 * that answers `operator_scope`. `BottomTabBar` already works this way — it
 * resolves suffixes against `useNavSections()` at render time — and this
 * column does not change that contract.
 *
 * ── null is not [] ──
 *
 * `null` means "never chosen": use the default order. `[]` means
 * "deliberately cleared". They want opposite behaviour and the column is
 * nullable so they stay distinguishable.
 */
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';

/**
 * A generous cap. The bar shows five today; the point is to bound the payload,
 * not to encode a design decision the client owns.
 */
export const MAX_BOTTOM_TABS = 12;

/** Longest suffix that could plausibly be a route — `/grain/contracts` is 16. */
const MAX_SUFFIX_LENGTH = 64;

export const BottomTabOrderSchema = z
    .array(z.string().trim().min(1).max(MAX_SUFFIX_LENGTH))
    .max(MAX_BOTTOM_TABS)
    .nullable()
    .refine(
        (v) => v === null || new Set(v).size === v.length,
        { message: 'Tab ids must be unique.' },
    );

export type BottomTabOrder = z.infer<typeof BottomTabOrderSchema>;

/**
 * Read a stored value back into a usable list.
 *
 * Anything that is not an array of strings reads as `null` — "never chosen" —
 * rather than throwing. The column is `Json`, so a hand-edited row or a value
 * written by an older shape must degrade to the default bar instead of
 * breaking every render for that user.
 */
export function parseBottomTabOrder(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    if (!raw.every((v) => typeof v === 'string')) return null;
    return raw as string[];
}

/** Persist the caller's own arrangement. `null` restores the default order. */
export async function updateOwnBottomTabOrder(
    userId: string,
    order: BottomTabOrder,
): Promise<{ bottomTabOrder: string[] | null }> {
    const updated = await prisma.user.update({
        where: { id: userId },
        data: { bottomTabOrder: order === null ? Prisma.DbNull : order },
        select: { bottomTabOrder: true },
    });
    return { bottomTabOrder: parseBottomTabOrder(updated.bottomTabOrder) };
}

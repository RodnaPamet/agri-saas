/**
 * «Мероприятие» — the Bulgarian activity names «ДНЕВНИК НА СТОПАНСТВОТО» prints
 * (#2316).
 *
 * The campaign journal's column 5 is one composed string per row,
 * `<name> – <area> ха` («Пръскане – 17,05 ха»), where the area is the sum over
 * the parcels one activity actually covered. This module owns the NAME half
 * only: a map readable as data, so the caller composes the cell and keeps its
 * own area arithmetic.
 *
 * ## Why hardcoded Bulgarian rather than i18n
 *
 * `journalEnums.operationType.*` already carries these labels in both locales,
 * and this deliberately does NOT read them.
 *
 * A regulated document is Bulgarian whatever the reader's UI locale. Printing
 * the ДНЕВНИК for a user whose cookie says `en` must still produce a Bulgarian
 * form — `DEFAULT_LOCALE` is `'en'` and applies to every unauthenticated
 * request, so routing this through i18n would make the document's language a
 * property of who asked for it. `farm-record-diary.ts` hardcodes its own
 * headings for the same reason, and its wording is fixed by заповед
 * РД 11-3194/31.12.2021 — copy that must not move when UI copy does.
 *
 * So the duplication is intentional and one-directional: a UI label may be
 * reworded freely; this must not follow it. What IS guarded is totality —
 * `Record<FieldOperationType, string>` makes a new enum value a TYPE error
 * here rather than an empty cell in a printed record.
 *
 * ## One wording trap
 *
 * `CULTIVATE` is «Обработка на почвата», never «Обработка» alone. In the БАБХ
 * register «обработка» already means a CHEMICAL treatment — the form's own
 * title is «РАСТИТЕЛНОЗАЩИТНИ МЕРОПРИЯТИЯ», and its table is «химични
 * обработки». A row reading «Обработка – 17,05 ха» in a document that also
 * lists sprayings would be read as a spraying by the person it is written for.
 */

import type { FieldOperationType } from '@prisma/client';

/**
 * Total over `FieldOperationType`, enforced by the type rather than a test:
 * adding an enum value without a label fails `tsc`, which is earlier and
 * louder than a guard, and the failure names this file.
 */
export const ACTIVITY_LABELS_BG: Record<FieldOperationType, string> = {
    SPRAY: 'Пръскане',
    FERTILIZE: 'Торене',
    SEED: 'Сеитба',
    PRUNE: 'Резитба',
    CULTIVATE: 'Обработка на почвата',
    HARVEST: 'Прибиране на реколтата',
    OTHER: 'Друго',
};

/**
 * The kinds that carry no product or dose — the ones #2316 relaxed
 * `OperationParcel`'s NOT NULLs for.
 *
 * `OTHER` is deliberately absent. It predates #2316 and existing rows carry a
 * product under it, so calling it product-less would retro-label real data;
 * what a new `OTHER` line carries stays the writer's choice, which the CHECK
 * already constrains to all-or-nothing.
 */
export const BARE_ACTIVITY_KINDS = ['PRUNE', 'CULTIVATE', 'HARVEST'] as const;

export type BareActivityKind = (typeof BARE_ACTIVITY_KINDS)[number];

export function isBareActivityKind(kind: string): kind is BareActivityKind {
    return (BARE_ACTIVITY_KINDS as readonly string[]).includes(kind);
}

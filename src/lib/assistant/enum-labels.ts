import {
    CostCategory,
    LogEntryStatus,
    LogEntryType,
    ParcelOperationStatus,
    WorkItemStatus,
} from '@prisma/client';

import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';

/**
 * Enum value → the word a farmer uses for it.
 *
 * The assistant printed raw codes beside the Bulgarian — «Дейност (ACTIVITY)»,
 * «Внасяне на препарат/тор (INPUT_APPLICATION)», «Всички записи са със статус
 * DONE» — because the tool output contained the enum and the model reasonably
 * echoed it. Owner-visible, 2026-11-01.
 *
 * Nothing here is new copy. Every label below already existed and is already on
 * screen in the web app; the tool emitted the code instead. This module is the
 * resolution that was missing, not a translation.
 *
 * ## It returns the LABEL ONLY, never `{ label, code }`
 *
 * A code the model cannot see is a code it cannot echo. That is the same
 * argument that keeps the ПРЗ safety wording out of the model's context
 * (`promotion-disclosure.ts`): an instruction not to print something is a
 * request, and absence is a guarantee.
 *
 * If a CLIENT needs the code for a deep link, it belongs on the SSE frame
 * beside the answer — a path the model never touches — not in the tool result.
 *
 * ## The locale is the CALLER'S, and `getTranslations()` is the trap
 *
 * `translateFor(locale, key)` with an EXPLICIT locale from
 * `resolveRecipientLocale`. The instinct is `getTranslations()`, which reads the
 * request cookie — right here by accident, and wrong the moment anything calls
 * a tool outside a user request (a job, a replay, a scheduled summary). Same
 * shape as the outbound-email rule, where the sender's cookie is not the
 * recipient's language.
 *
 * The fallback is `bg`, NOT `DEFAULT_LOCALE` — that constant is `en` and is
 * documented for UNAUTHENTICATED surfaces. An assistant caller is a known user
 * whose `uiLanguage` column defaults to `bg`, so falling back to English would
 * hand a Bulgarian farmer an English word because a lookup failed.
 */

/**
 * Every enum the assistant's tools can emit, with the catalogue namespace that
 * already names it.
 *
 * The VALUES come from `@prisma/client` at runtime rather than being listed, so
 * the guard beside this file derives its population from the schema: adding a
 * `LogEntryType` member fails CI until it has a label, instead of leaking a
 * code into an answer months later.
 */
export const ENUM_LABEL_NAMESPACES = {
    logType: { values: LogEntryType, ns: 'journalEnums.logType' },
    logStatus: { values: LogEntryStatus, ns: 'journalEnums.status' },
    operationParcelStatus: { values: ParcelOperationStatus, ns: 'ag.status.operationParcel' },
    costCategory: { values: CostCategory, ns: 'grainEnums.costCategory' },
    taskStatus: { values: WorkItemStatus, ns: 'taskEnums.status' },
} as const;

export type EnumKind = keyof typeof ENUM_LABEL_NAMESPACES;

/**
 * The farmer's word for one enum value.
 *
 * Falls back to the RAW VALUE when a label is missing, deliberately: a tool
 * that threw on an unlabelled enum would turn a missing translation into a
 * failed answer, and the guard already makes a missing label a CI failure. The
 * fallback is the degraded case, not the plan.
 */
export async function enumLabel(
    kind: EnumKind,
    value: string | null | undefined,
    locale: Locale | string,
): Promise<string | null> {
    if (value == null) return null;
    const entry = ENUM_LABEL_NAMESPACES[kind];
    const key = `${entry.ns}.${value}`;
    // ASYNC — `translateFor` loads the catalogue bundle. Worth flagging to a
    // caller: it looks like a pure lookup and is not, so a serialiser must
    // await it rather than dropping a Promise into a tool result, where it
    // would stringify as `[object Promise]` and reach the model.
    const label = await translateFor(locale as Locale, key);
    // It answers with the KEY when it cannot resolve. Printing
    // «journalEnums.logType.ACTIVITY» at a farmer is worse than printing
    // «ACTIVITY», so an unresolved key degrades to the raw value.
    if (!label || label === key) return value;
    return label;
}

/** The locale an assistant answer should be written in, for a given user. */
export function assistantLocale(uiLanguage: string | null | undefined): string {
    return resolveRecipientLocale(uiLanguage);
}

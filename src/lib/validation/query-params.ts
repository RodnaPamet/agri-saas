/**
 * Query-parameter parsing helpers for route handlers.
 *
 * The enterprise filter system (Epic 53) serialises a MULTI-select facet
 * as one comma-joined param — `filterStateToUrlParams` does
 * `values.join(',')`, so two selected statuses arrive as
 * `?status=DRAFT,ACTIVE`. A route that reads such a param with a bare
 * `searchParams.get('status')` gets the literal string `"DRAFT,ACTIVE"`.
 *
 * Handing that string to Prisma as an enum equality filter throws a
 * `PrismaClientValidationError` — a 500 that surfaces in the UI as an
 * empty table ("No results match your filters"), which reads as *zero
 * matches* rather than *the request failed*. Parse multi-value params
 * through `parseCsvEnumParam` instead: it validates every member and
 * fails as a clean 400, so an unknown value can never reach the query
 * layer.
 */

import type { z } from 'zod';
import { badRequest } from '@/lib/errors/types';

/**
 * Parse a comma-separated multi-select query param into a validated,
 * de-duplicated array of enum members.
 *
 * @param raw    The raw param value (`searchParams.get(key)`).
 * @param schema A zod schema for ONE member — typically
 *               `z.nativeEnum(SomePrismaEnum)`.
 * @param label  Human-readable param name for the 400 message.
 *
 * @returns `undefined` when the param is absent or empty (so callers can
 *          spread it into a Prisma `where` and omit the filter entirely),
 *          otherwise the parsed members in first-seen order.
 *
 * @throws `badRequest` (400) if ANY member fails validation. Rejecting
 *         the whole request beats silently dropping the bad member:
 *         dropping it would quietly widen the result set past what the
 *         operator asked for, and a filter that lies is worse than one
 *         that errors.
 */
export function parseCsvEnumParam<T extends string>(
    raw: string | null | undefined,
    schema: z.ZodType<T>,
    label: string,
): T[] | undefined {
    if (raw == null) return undefined;

    const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (parts.length === 0) return undefined;

    const out: T[] = [];
    for (const part of parts) {
        const parsed = schema.safeParse(part);
        if (!parsed.success) {
            throw badRequest(`Invalid ${label} filter value: "${part}"`);
        }
        if (!out.includes(parsed.data)) out.push(parsed.data);
    }
    return out;
}

/**
 * The non-enum sibling of `parseCsvEnumParam`, for multi-select facets whose
 * values are opaque IDs (a season, a field, a planting) rather than members
 * of a known set.
 *
 * Same defect, quieter symptom. An enum param handed a comma-joined string
 * throws a `PrismaClientValidationError` — a 500 the operator at least sees
 * as broken. An ID param is a plain `String` column, so Prisma accepts
 * `seasonId = "a,b"` happily and matches NOTHING: the table renders "No
 * records match your filters", which reads as *this farm has no harvest for
 * those two seasons* rather than *your filter never ran*. A wrong answer
 * that looks like an answer is the worse of the two.
 *
 * IDs cannot be validated against a value set the way enum members can, so
 * the checks here are structural: non-empty, bounded length, bounded count.
 * That is enough to keep a malformed param out of the query layer without
 * pretending to know which IDs exist — the tenant-scoped `where` already
 * decides that, and an ID belonging to another tenant simply matches no row.
 *
 * @returns `undefined` when absent/empty so callers can spread it into a
 *          Prisma `where` and omit the filter entirely.
 * @throws  `badRequest` (400) on a member that cannot be an ID, or on more
 *          members than a real multi-select produces.
 */
export function parseCsvIdParam(
    raw: string | null | undefined,
    label: string,
    opts: { maxValues?: number; maxLength?: number } = {},
): string[] | undefined {
    if (raw == null) return undefined;

    const maxValues = opts.maxValues ?? 100;
    const maxLength = opts.maxLength ?? 200;

    const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (parts.length === 0) return undefined;

    if (parts.length > maxValues) {
        throw badRequest(`Too many ${label} filter values (max ${maxValues})`);
    }

    const out: string[] = [];
    for (const part of parts) {
        if (part.length > maxLength) {
            throw badRequest(`Invalid ${label} filter value: too long`);
        }
        if (!out.includes(part)) out.push(part);
    }
    return out;
}

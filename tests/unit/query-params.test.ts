/**
 * Unit tests for `src/lib/validation/query-params.ts`.
 *
 * `parseCsvEnumParam` is the seam that stopped a multi-select facet from
 * 500ing. The Epic-53 filter toolbar comma-joins a `multiple: true`
 * facet, so `?status=DRAFT,ACTIVE` arrives as one string; handing that
 * to Prisma as enum equality threw a PrismaClientValidationError, which
 * the list page rendered as "no results" — a confident claim of zero
 * matches in response to a crash.
 *
 * The contract under test:
 *   - a comma list parses into validated members,
 *   - an absent / blank param yields `undefined` (filter omitted, not
 *     `{ in: [] }`, which would match nothing),
 *   - ANY invalid member is a clean 400 (never a pass-through to Prisma).
 */

import { z } from 'zod';
import { parseCsvEnumParam } from '@/lib/validation/query-params';
import { ValidationError } from '@/lib/errors/types';

// Stand-in for a Prisma enum — same shape `z.nativeEnum(...)` produces.
const Status = z.enum(['DRAFT', 'ACTIVE', 'DELIVERED', 'SETTLED', 'CANCELLED']);

describe('parseCsvEnumParam', () => {
    it('parses a single value', () => {
        expect(parseCsvEnumParam('ACTIVE', Status, 'status')).toEqual(['ACTIVE']);
    });

    it('parses a comma-separated list — the regression case', () => {
        expect(parseCsvEnumParam('DRAFT,ACTIVE', Status, 'status')).toEqual([
            'DRAFT',
            'ACTIVE',
        ]);
    });

    it('tolerates whitespace around members', () => {
        expect(parseCsvEnumParam(' DRAFT , ACTIVE ', Status, 'status')).toEqual([
            'DRAFT',
            'ACTIVE',
        ]);
    });

    it('drops empty members from sloppy serialisation', () => {
        expect(parseCsvEnumParam('DRAFT,,ACTIVE,', Status, 'status')).toEqual([
            'DRAFT',
            'ACTIVE',
        ]);
    });

    it('de-duplicates repeated members', () => {
        expect(parseCsvEnumParam('ACTIVE,ACTIVE,DRAFT', Status, 'status')).toEqual([
            'ACTIVE',
            'DRAFT',
        ]);
    });

    it('preserves first-seen order', () => {
        expect(parseCsvEnumParam('SETTLED,DRAFT', Status, 'status')).toEqual([
            'SETTLED',
            'DRAFT',
        ]);
    });

    describe('absent / empty → undefined (omit the filter)', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
            ['empty string', ''],
            ['only separators', ',,,'],
            ['only whitespace', '   '],
        ])('%s', (_label, raw) => {
            // `undefined` lets the caller spread the filter away entirely.
            // Returning `[]` would become `{ in: [] }` — zero rows, i.e. a
            // cleared facet silently emptying the table.
            expect(parseCsvEnumParam(raw as any, Status, 'status')).toBeUndefined();
        });
    });

    describe('invalid members are a clean 400', () => {
        it('rejects a wholly unknown value', () => {
            expect(() => parseCsvEnumParam('BOGUS', Status, 'status')).toThrow(
                ValidationError,
            );
        });

        it('rejects the whole request when ONE member is bad', () => {
            // Not "drop the bad one and carry on": silently widening the
            // result set past what the operator selected is a filter that
            // lies. Erroring is the honest failure.
            expect(() =>
                parseCsvEnumParam('ACTIVE,BOGUS', Status, 'status'),
            ).toThrow(ValidationError);
        });

        it('is case-sensitive (lowercase is not a member)', () => {
            expect(() => parseCsvEnumParam('active', Status, 'status')).toThrow(
                ValidationError,
            );
        });

        it('carries a 400 status and names the param + offending value', () => {
            try {
                parseCsvEnumParam('ACTIVE,NOPE', Status, 'status');
                throw new Error('expected a throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ValidationError);
                const e = err as ValidationError;
                expect(e.status).toBe(400);
                expect(e.code).toBe('BAD_REQUEST');
                expect(e.expose).toBe(true);
                expect(e.message).toMatch(/status/);
                expect(e.message).toMatch(/NOPE/);
                // The message must not leak the whole allowed-value list
                // back at an unauthenticated prober beyond what it sent.
                expect(e.message).not.toMatch(/DELIVERED/);
            }
        });

        it('rejects SQL-ish / injection-shaped junk rather than passing it down', () => {
            for (const junk of ["ACTIVE') OR 1=1--", '<script>', 'DRAFT;DROP']) {
                expect(() => parseCsvEnumParam(junk, Status, 'status')).toThrow(
                    ValidationError,
                );
            }
        });
    });

    it('works with a two-member enum (the type facet)', () => {
        const Type = z.enum(['SALE', 'PURCHASE']);
        expect(parseCsvEnumParam('SALE,PURCHASE', Type, 'type')).toEqual([
            'SALE',
            'PURCHASE',
        ]);
        expect(() => parseCsvEnumParam('LEASE', Type, 'type')).toThrow(ValidationError);
    });
});

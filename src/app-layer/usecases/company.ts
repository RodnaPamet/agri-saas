/**
 * Supplier catalogue (#12) — the companies behind the global promotions feed.
 *
 * GLOBAL, like `Promotion` / `AgriEvent` / `Unit`: one advertiser is one row
 * for every tenant. Curated by platform support only — a tenant-facing write
 * would let one farm rename a supplier in every other farm's feed.
 *
 * These take `(db, ctx)` and run inside the caller's tenant transaction even
 * though the table itself has no tenant scope. That is the whole point of
 * curating from the platform tenant rather than a key-gated API: `logEvent`
 * needs a `tenantId` AND a real `userId`, and here both exist — so "who
 * published this, and when" is answerable from the hash-chained audit trail
 * instead of only from structured logs (the compromise `agri-events.ts` had to
 * settle for).
 *
 * **Two privacy classes.** `name` / `eik` / `websiteUrl` / `logoUrl` are public
 * (the name renders cross-tenant). `contactName` / `contactEmail` /
 * `contactPhone` / `notes` are internal personal data, encrypted at rest by the
 * Epic B middleware under the GLOBAL KEK (see `GLOBAL_KEK_MODELS`). Encryption
 * protects them at rest; `sanitizeCompanyInput` below protects every downstream
 * renderer that decrypts and displays them.
 *
 * @module app-layer/usecases/company
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { badRequest, codedConflict, notFound } from '@/lib/errors/types';
import { Prisma } from '@prisma/client';
import { companyNameKey } from './promotions';

export interface CompanyInput {
    name: string;
    eik?: string | null;
    websiteUrl?: string | null;
    logoUrl?: string | null;
    contactName?: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    notes?: string | null;
}

/**
 * Preserve the undefined / null / string three-state contract: `undefined`
 * means "leave alone" on a partial update, `null` means "clear it".
 */
function sanitizeOptional(v: string | null | undefined): string | null | undefined {
    if (v === undefined || v === null) return v;
    return sanitizePlainText(v);
}

/**
 * The SINGLE sanitisation seam both create and update route through — the
 * `parcel-lease.ts::mapLeaseData` pattern. Keeping it in one place is what
 * stops the two paths drifting apart, which is how the journal audit hole
 * happened.
 */
function sanitizeCompanyInput<T extends Partial<CompanyInput>>(input: T): T {
    return {
        ...input,
        ...(input.name !== undefined ? { name: sanitizePlainText(input.name) } : {}),
        ...(input.eik !== undefined ? { eik: sanitizeOptional(input.eik) } : {}),
        ...(input.contactName !== undefined
            ? { contactName: sanitizeOptional(input.contactName) }
            : {}),
        ...(input.contactEmail !== undefined
            ? { contactEmail: sanitizeOptional(input.contactEmail) }
            : {}),
        ...(input.contactPhone !== undefined
            ? { contactPhone: sanitizeOptional(input.contactPhone) }
            : {}),
        ...(input.notes !== undefined ? { notes: sanitizeOptional(input.notes) } : {}),
    };
}

export async function createCompany(db: PrismaTx, ctx: RequestContext, input: CompanyInput) {
    const clean = sanitizeCompanyInput(input);
    const name = clean.name?.trim() ?? '';
    if (!name) throw badRequest('Company name is required');

    const nameKey = companyNameKey(name);

    try {
        const company = await db.company.create({ data: { ...clean, name, nameKey } });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Company',
            entityId: company.id,
            details: `Created supplier: ${company.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Company',
                operation: 'created',
                after: { name: company.name },
                summary: `Created supplier: ${company.name}`,
            },
        });
        return company;
    } catch (err) {
        // The `nameKey` unique index is the real dedup guarantee — turn the
        // raw violation into a message support can act on, since the whole
        // point of the key is that "Syngenta" and "syngenta " are one supplier.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            // The name is NOT interpolated into the message. The operator
            // has just typed it, so nothing is lost by not echoing it, and a
            // user-supplied value inside server copy is what
            // `farm-creation.ts` warns against — it also keeps `message` a
            // static English fallback rather than a half-localised one.
            throw codedConflict(
                'COMPANY_NAME_TAKEN',
                'A company with that name already exists.',
            );
        }
        throw err;
    }
}

export async function updateCompany(
    db: PrismaTx,
    ctx: RequestContext,
    id: string,
    input: Partial<CompanyInput>,
) {
    const existing = await db.company.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound('Company not found');

    const clean = sanitizeCompanyInput(input);

    // Drop explicitly-undefined keys. Prisma ignores them anyway, but leaving
    // them in means the `fields:` log below reports a PII column as changed
    // when the caller only meant "leave it alone" — misleading provenance on
    // exactly the fields where provenance matters most.
    const data: Record<string, unknown> = Object.fromEntries(
        Object.entries(clean).filter(([, v]) => v !== undefined),
    );

    // Renaming has to move the dedup key with it, or the two fall out of sync
    // and a later rename can collide invisibly.
    if (clean.name !== undefined) {
        const name = clean.name.trim();
        if (!name) throw badRequest('Company name is required');
        data.name = name;
        data.nameKey = companyNameKey(name);
    }

    try {
        const company = await db.company.update({ where: { id }, data });
        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'Company',
            entityId: company.id,
            details: `Updated supplier: ${company.name}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'Company',
                operation: 'updated',
                // Field NAMES only — the values are encrypted PII and must not
                // be copied into the audit chain in the clear.
                fields: Object.keys(data),
                summary: `Updated supplier: ${company.name}`,
            },
        });
        return company;
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            // Same code as create: both are the `nameKey` unique index, and
            // the remedy is identical — pick a different name, not a re-read.
            throw codedConflict(
                'COMPANY_NAME_TAKEN',
                'Another company already uses that name.',
            );
        }
        throw err;
    }
}

/**
 * Find an existing supplier by normalised name, or create it. The intake path:
 * support types a company name on a new promotion and should not have to know
 * whether that supplier is already on file.
 */
export async function findOrCreateCompany(db: PrismaTx, ctx: RequestContext, name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest('Company name is required');

    const existing = await db.company.findUnique({
        where: { nameKey: companyNameKey(trimmed) },
    });
    if (existing) return existing;

    return createCompany(db, ctx, { name: trimmed });
}

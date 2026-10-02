/**
 * Every encryption-manifest entry names something that exists — and the TWO
 * manifests do not use the same naming convention, which is the trap.
 *
 * ── the two conventions ──
 *
 *   · `ENCRYPTED_FIELDS` (`encrypted-fields.ts`) holds **Prisma field** names.
 *     `PromotionLead.requestMessage` is `@map("message")`, and the field was
 *     named uniquely ON PURPOSE: the Epic B middleware's fan-out encrypt path
 *     matches a FLAT set of field names across the whole manifest and cannot
 *     tell which model a key belongs to, so an entry called `message` silently
 *     encrypted `Notification.message`, `ExchangeInquiry.message` and
 *     `InsuranceLead.message` as well. (Caught once already: a
 *     `Notification.message` came back as `v1:…`.)
 *   · `PII_FIELD_MAP` (`pii-middleware.ts`) holds **physical column** names.
 *     `emailEncrypted` IS the `@map` target of the Prisma field `email`.
 *
 * ── what goes wrong ──
 *
 * Any code that puts a manifest name into raw SQL has to resolve it first.
 * `global-key-rotation.ts` does, through the DMMF. `key-rotation.ts` does NOT —
 * it interpolates `ENCRYPTED_FIELDS` names straight into
 * `SELECT "${field}" FROM "${model}"`. Measured 2026-10-02: **zero** `@map`'d
 * encrypted fields sit on a tenant-scoped model, so that job has never hit it —
 * it skips `PromotionLead` for having no `tenantId`. The hazard is latent, not
 * absent: `@map` one encrypted field on a tenant-scoped model and the next
 * rotation throws 42703 MID-SWEEP, after rows have already been rewritten.
 *
 * So this guard holds two things:
 *
 *   1. every manifest entry resolves to a real Prisma field or column;
 *   2. no `ENCRYPTED_FIELDS` entry is `@map`'d on a TENANT-SCOPED model —
 *      the precondition the per-tenant job silently depends on. Adding one is
 *      allowed, but it costs fixing that job in the same diff.
 */
import { Prisma } from '@prisma/client';
import { ENCRYPTED_FIELDS } from '../../src/lib/security/encrypted-fields';
import { PII_MANAGED_MODELS, _getPiiFieldMap } from '../../src/lib/security/pii-middleware';

type Entry = { model: string; manifestName: string; manifest: 'encrypted-fields' | 'pii' };

function allEntries(): Entry[] {
    const out: Entry[] = [];
    for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
        for (const manifestName of fields) out.push({ model, manifestName, manifest: 'encrypted-fields' });
    }
    for (const model of PII_MANAGED_MODELS) {
        for (const spec of _getPiiFieldMap(model) ?? []) {
            out.push({ model, manifestName: spec.encrypted, manifest: 'pii' });
        }
    }
    return out;
}

const MODELS = Prisma.dmmf.datamodel.models;
const ENTRIES = allEntries();

function fieldFor(e: Entry): { dbName: string | null; name: string } | null {
    const m = MODELS.find((x) => x.name === e.model);
    if (!m) return null;
    const byName = m.fields.find((f) => f.name === e.manifestName);
    if (byName) return { dbName: byName.dbName ?? null, name: byName.name };
    const byColumn = m.fields.find((f) => f.dbName === e.manifestName);
    if (byColumn) return { dbName: byColumn.dbName ?? null, name: byColumn.name };
    return null;
}

describe('both encryption manifests resolve against the datamodel', () => {
    it('the DMMF and both manifests are non-trivially populated', () => {
        // A zero anywhere here makes every assertion below vacuous. The DMMF
        // in particular can come back empty if the client was not generated.
        expect(MODELS.length).toBeGreaterThan(50);
        expect(Object.keys(ENCRYPTED_FIELDS).length).toBeGreaterThan(5);
        expect(PII_MANAGED_MODELS.length).toBeGreaterThan(2);
        expect(ENTRIES.length).toBeGreaterThan(15);
    });

    it('every entry names a model in the datamodel', () => {
        const unknown = [...new Set(ENTRIES.map((e) => e.model))].filter(
            (m) => !MODELS.some((x) => x.name === m),
        );
        expect(unknown).toEqual([]);
    });

    it('every entry resolves to a real field or column', () => {
        const unresolved = ENTRIES.filter((e) => fieldFor(e) === null).map(
            (e) => `${e.model}.${e.manifestName} (${e.manifest})`,
        );
        if (unresolved.length > 0) {
            throw new Error(
                `${unresolved.length} manifest entr(y/ies) name nothing in the datamodel:\n  ` +
                    unresolved.join('\n  ') +
                    `\n\nA stale manifest entry means the encryption middleware is trying to ` +
                    `protect a column that does not exist, and the rotation sweeps cover less ` +
                    `than they claim.`,
            );
        }
    });

    it('no ENCRYPTED_FIELDS entry is @map\'d on a TENANT-SCOPED model', () => {
        // The precondition `src/app-layer/jobs/key-rotation.ts` depends on
        // without saying so: it interpolates manifest names straight into raw
        // SQL and would throw 42703 mid-sweep on a @map'd one. It only survives
        // because the single @map'd entry today sits on a model with no
        // `tenantId`, which it skips for a different reason entirely.
        const hazards: string[] = [];
        for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
            const m = MODELS.find((x) => x.name === model);
            if (!m) continue;
            if (!m.fields.some((f) => f.name === 'tenantId')) continue;
            for (const fieldName of fields) {
                const f = m.fields.find((x) => x.name === fieldName);
                if (f?.dbName) hazards.push(`${model}.${fieldName} -> column "${f.dbName}"`);
            }
        }
        if (hazards.length > 0) {
            throw new Error(
                `${hazards.length} ENCRYPTED_FIELDS entr(y/ies) are @map'd on a tenant-scoped ` +
                    `model:\n  ` +
                    hazards.join('\n  ') +
                    `\n\nsrc/app-layer/jobs/key-rotation.ts puts the MANIFEST name into raw SQL, ` +
                    `so the next per-tenant rotation throws 42703 after it has already rewritten ` +
                    `rows. Resolve names through the DMMF there (as ` +
                    `app-layer/usecases/global-key-rotation.ts does) in the same diff.`,
            );
        }
    });

    it('the @map case the sweep has to handle still EXISTS — a positive control', () => {
        // Without this the previous assertion could pass because nothing is
        // @map'd at all, and the resolution logic would be untested in practice
        // while reading as verified.
        const mapped = ENTRIES.filter((e) => {
            const f = fieldFor(e);
            return f?.dbName !== null && f?.dbName !== undefined && f.name === e.manifestName;
        });
        expect(mapped.length).toBeGreaterThan(0);
        // And the known one, by name, so a rename is visible rather than silent.
        expect(mapped.some((e) => e.model === 'PromotionLead' && e.manifestName === 'requestMessage')).toBe(true);
    });

    it('the PII manifest\'s entries are PHYSICAL names — the other convention', () => {
        // Asserted so the asymmetry is pinned rather than remembered: a change
        // that made PII_FIELD_MAP hold Prisma field names would still resolve
        // (the resolver accepts both) but would silently swap which column a
        // reader believes is being swept.
        const user = _getPiiFieldMap('User') ?? [];
        const email = user.find((s) => s.plain === 'email');
        expect(email?.encrypted).toBe('emailEncrypted');
        const f = MODELS.find((m) => m.name === 'User')?.fields.find((x) => x.name === 'email');
        expect(f?.dbName).toBe('emailEncrypted');
    });
});

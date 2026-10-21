/**
 * `/admin/ppp-register` — load the БАБХ register of approved ПРЗ (#2077).
 *
 * Described rather than baselined, unlike the twelve non-tenant `/api/admin/*`
 * platform-key paths. Those are baselined because their consumer is an
 * operator holding `PLATFORM_ADMIN_API_KEY` rather than a client reading the
 * spec; this one is session-gated under `/api/t/{tenantSlug}/admin/**`, in the
 * same family as `admin/market-prices`, which is described in
 * `trends.paths.ts`.
 *
 * It earns the description for a second reason. Every refusal below is a 400
 * whose MESSAGE is the operator's entire debugging aid — a parser that cannot
 * bind a column reports the headers it found and every spelling it accepts —
 * and a surface like that is far more useful documented than discovered.
 *
 * @module lib/openapi/paths/ppp-register.paths
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const PppRegisterUpload = z
    .object({
        file: z.string().openapi({
            format: 'binary',
            description:
                'The register as published: `.xlsx`, or delimited text (`.csv`, semicolon, or ' +
                'tab). The parser is chosen from the FILENAME, not the declared content type — ' +
                '`curl -F` sends `application/octet-stream` by default and a browser has three ' +
                'different strings for an `.xlsx`, so here the extension is the more reliable ' +
                'signal. 32 MB ceiling, checked on the declared size before the body is ' +
                'buffered.',
        }),
        sheet: z.string().optional().openapi({
            description:
                'Worksheet name, for an `.xlsx` with more than one. Omitted takes the first ' +
                'sheet in workbook order — fine for a single-sheet export, and worth naming ' +
                'otherwise, since "the first one" is not always the one a person means.',
        }),
    })
    .openapi('PppRegisterUpload', {
        description: 'multipart/form-data body for a ПРЗ register import.',
    });

const PppRegisterImportResult = z
    .object({
        importId: z.string(),
        entryCount: z.number().int().openapi({
            description: 'Rows stored. This import is now the live register.',
        }),
        previousEntryCount: z.number().int().nullable().openapi({
            description:
                'Rows in the import this one replaces, or null if it is the first. Returned ' +
                'BESIDE the new count deliberately: an operator who uploads a truncated export ' +
                'sees `entryCount: 40, previousEntryCount: 4100` and knows at once. Without the ' +
                'second number, 40 looks like a success.',
        }),
        skippedRows: z.number().int().openapi({
            description:
                'Rows dropped for having no crop or no product name. A handful is normal — ' +
                'sub-headings and trailing junk. A count near the file length means the ' +
                'binding found the wrong columns, and the register should be re-uploaded ' +
                'rather than trusted.',
        }),
        unparsedDoses: z.number().int().openapi({
            description:
                'Rows whose dose cell held text but no leading number (`по указание на ' +
                'производителя`). The row is KEPT with a null dose — its crop, product, pests ' +
                'and quarantine period are still true — and counted, because this is the ' +
                'number that says the dose column needs a human.',
        }),
        withdrawnCount: z.number().int().openapi({
            description:
                'Entries marked as no longer approved. Kept as rows rather than dropped at ' +
                'import, so a read can state the withdrawal instead of the product simply ' +
                'being absent.',
        }),
        headers: z.array(z.string()).openapi({
            description: 'The headers the parser bound, in file order. A shape change is visible here.',
        }),
    })
    .openapi('PppRegisterImportResult', { description: 'What one register import stored.' });

const PppRegisterState = z
    .object({
        live: z
            .object({
                importId: z.string(),
                importedAt: z.string().openapi({ format: 'date-time' }),
                sourceName: z.string().openapi({ description: 'The uploaded filename.' }),
                entryCount: z.number().int().openapi({
                    description: 'What the import recorded at the time it was stored.',
                }),
                storedEntries: z.number().int().openapi({
                    description:
                        'Rows COUNTED in the table now. Reported separately from `entryCount` on ' +
                        'purpose: the two agreeing is the evidence that the snapshot is whole, ' +
                        'and returning only the stored figure would make that check circular.',
                }),
                withdrawnCount: z.number().int(),
            })
            .nullable()
            .openapi({
                description:
                    'Null when no import has ever completed — the register is not loaded, and ' +
                    'every lookup will miss.',
            }),
        incompleteImports: z.number().int().openapi({
            description:
                'Imports with no `completedAt`. Non-zero means an upload died part-way. Those ' +
                'are invisible to any read by construction, so this is a diagnostic rather ' +
                'than a warning about correctness.',
        }),
    })
    .openapi('PppRegisterState', { description: 'Which register import is live, and whether it is whole.' });

export function registerPppRegisterPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/ppp-register',
        operationId: 'importPppRegister',
        summary: 'Replace the ПРЗ register from an uploaded file',
        description:
            'Loads the БАБХ register of approved plant-protection products. Owner ruling ' +
            '2026-10-20: an upload, not a scheduled fetch. We own neither the register’s ' +
            'format nor its URL, so a parser pointed at them can break overnight — and the ' +
            'failure is not an exception, it is WRONG DOSES rendered identically to right ' +
            'ones. A manual upload makes a refresh a deliberate act with a known date, which ' +
            'turns staleness from silent into visible.' +
            '\n\n**NOTHING READS THIS REGISTER.** The crop × product suggestion it was built ' +
            'for was retired by the owner on 2026-10-21, who chose to keep the loader and drop ' +
            'the suggestions (#2077, closed as not planned). This operation and its GET are the ' +
            'only consumers: one writes an import, the other tells the operator what is live. ' +
            'Still documented because the upload still works and an operator may still load the ' +
            'register.' +
            '\n\n**An import REPLACES; it never merges.** A property of the stored data, kept ' +
            'for whatever may one day read it: the latest completed import IS the register, and ' +
            'older ones are provenance only. Merging would let a row withdrawn in the newest ' +
            'file still match from an older one, which is the worst thing these tables can ' +
            'produce.' +
            '\n\n**Columns bind by HEADER TEXT, never by position**, through an alias table, and ' +
            'the header is searched for in the first ten rows so a title or an issuing-order ' +
            'reference above it is fine. A bg-BG Excel writes SEMICOLON-delimited CSV, so the ' +
            'delimiter is sniffed across those leading rows rather than taken from the first ' +
            'line. The decimal separator may be a comma (`0,15`), and the unit may live in the ' +
            'header (`Доза (мл/дка)`) with bare numbers in the cells.' +
            '\n\n**Doses are read from the START of the cell.** A single value stores as both ' +
            'bounds; `150-200` as a range; `до 200` as a maximum with NO minimum, because ' +
            'storing 200 as both would assert a floor the register does not give. A cell like ' +
            '`0,1 л/100 л вода` yields 0.1 with unit `л/100 л вода` — reading every number in ' +
            'it would take 100 as the range top, a thousandfold error that renders like a ' +
            'correct one.' +
            '\n\n**The 400s, and all of them refuse the WHOLE upload** rather than dropping ' +
            'rows. A national register is used as a unit, and a version with an arbitrary ' +
            'subset silently missing is worse than no new version — a miss reads as "no ' +
            'product is approved for this crop".' +
            '\n\n- **Unbindable columns** — the message names the headers found and every ' +
            'accepted spelling of each missing field. This is the one to expect when a new ' +
            'year’s file changes shape; it usually means an alias needs adding.' +
            '\n- **No rows** — the columns bound but produced nothing. Refused rather than ' +
            'stored, since an empty register is a statement about Bulgarian law that a blank ' +
            'spreadsheet is not entitled to make.' +
            '\n- **A cell over 300 characters, or over 60 pests in one row** — the realistic ' +
            'parser failure is binding a product or pest column to a notes or ' +
            'conditions-of-use column, where every row looks fine individually and the tell is ' +
            'their length.' +
            '\n- **Scanner refusals** — the bytes are scanned before the parser is pointed at ' +
            'them. Nothing is stored or served, but "never stored" is not "never parsed": they ' +
            'go through a ZIP reader and an XML parser in-process.' +
            '\n\nGated on `admin.manage` **inside** `PLATFORM_TENANT_SLUG`, and the gate is ' +
            'asserted before the body is even read, so a caller from another tenant pays for ' +
            'neither a scan nor a parse. Both halves are load-bearing: `admin.manage` resolves ' +
            'from Role, so the OWNER of every farm holds it, and alone it would hand any farm ' +
            'the national register. The gate FAILS CLOSED — an unset slug means 404 for ' +
            'everyone, the owner included.',
        tags: ['Admin'],
        params: TenantParams,
        body: PppRegisterUpload,
        bodyContentType: 'multipart/form-data',
        success: {
            status: 201,
            description: 'The register was replaced. Read both counts, not just the new one.',
            schema: PppRegisterImportResult,
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/ppp-register',
        operationId: 'readPppRegisterState',
        summary: 'Which register import is live, and whether it is whole',
        description:
            'Exists so an upload is verifiable without database access: it answers "what is ' +
            'live right now", which the POST response cannot once the operator has closed the ' +
            'terminal.' +
            '\n\n`storedEntries` is COUNTED from the table while `entryCount` is what the ' +
            'import recorded. The two agreeing is the evidence that the snapshot is whole; ' +
            'reporting only the stored figure would make the check circular.' +
            '\n\n`live: null` means no import has ever completed, so every register lookup will ' +
            'miss. That is the state a fresh deployment is in, and it is not an error.' +
            '\n\nSame gate as the upload, failing closed the same way.',
        tags: ['Admin'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'The live import, or null, plus a count of imports that never completed.',
            schema: PppRegisterState,
        },
    });
}

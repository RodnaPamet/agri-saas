/**
 * Cadastre COMPANY-ownership extraction — КАИС OpenData „собственост ПИ".
 *
 * The land-parcel ownership register ships as a single `.xlsx` inside the
 * settlement's „собственост ПИ.zip". КАИС masks personal data AT SOURCE:
 *   • a PHYSICAL person's «име на лицето» is asterisk-redacted ("****** ******")
 *     and their «идентификационен номер на субекта» is a 32-hex ENCRYPTED ЕГН —
 *     unreadable, un-identifying, and NOT ours to persist;
 *   • a LEGAL entity (Община / ЕООД / ООД / АД / държава / кооперация …) keeps a
 *     READABLE name and a numeric ЕИК.
 *
 * This module extracts ONLY legal-entity owners. Every masked / physical-person
 * row is dropped HERE and never returned — personal data does not leave the
 * parser. (Companion to `lib/cadastre/privacy.ts`, which strips owner columns
 * from the GEOMETRY shapefile; this is the ownership register's
 * legal-entity-only reader. A CC-licensed OpenData portal is not a GDPR waiver,
 * so the guard is code, not policy — see `tests/unit/cadastre-ownership.test.ts`.)
 *
 * Pure + dependency-light: the `.xlsx` is a zip of XML, parsed with the `jszip`
 * already used by the shapefile path — no new spreadsheet dependency.
 */
import JSZip from 'jszip';

/** A single legal-entity ownership record, safe to persist (no personal data). */
export interface CompanyOwner {
    /** Cadastral identifier of the owned parcel (join key to `Parcel.cadastralId`). */
    cadastralId: string;
    /** ЕИК / БУЛСТАТ of the legal entity (numeric, leading zeros preserved). */
    eik: string;
    /** Readable legal-entity name (e.g. „Община Банско", „Агро ЕООД"). */
    name: string;
    /** «вид на правото» — the ownership right type (собственост, …), or null. */
    rightType: string | null;
    /** «вид на лицето» — the subject kind (Община, ЕООД, държава, …), or null. */
    subjectKind: string | null;
}

/** Header labels in the собственост-ПИ register (lowercased for matching). */
const COL = {
    cadastralId: 'кадастрален идентификатор',
    subjectId: 'идентификационен номер на субекта',
    subjectKind: 'вид на лицето',
    name: 'име на лицето',
    rightType: 'вид на правото',
} as const;

/** A parsed sheet: header labels + string rows (cells indexed by column). */
export interface OwnershipSheet {
    headers: string[];
    rows: string[][];
}

/** Convert an XLSX column reference letter run ("A", "B", …, "AA") to 0-based index. */
function colToIndex(ref: string): number {
    const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

function decodeXml(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
}

/**
 * Parse the собственост-ПИ workbook (the OUTER „собственост ПИ.zip" buffer)
 * into a header row + string rows. Handles the register's cell encodings
 * (`t="str"` cached-string, `t="inlineStr"`, `t="s"` shared-string, bare
 * numeric) and honours per-cell column references so skipped/empty cells don't
 * shift columns. Returns empty when no worksheet is present.
 */
export async function parseOwnershipWorkbook(zipBuffer: Buffer | Uint8Array): Promise<OwnershipSheet> {
    const outer = await JSZip.loadAsync(zipBuffer);
    const xlsxName = Object.keys(outer.files).find((n) => /\.xlsx$/i.test(n));
    if (!xlsxName) return { headers: [], rows: [] };
    const xlsxBuf = await outer.files[xlsxName].async('uint8array');
    const wb = await JSZip.loadAsync(xlsxBuf);

    // Shared strings (optional — this register uses inline `t="str"`, but be robust).
    const shared: string[] = [];
    const ssFile = wb.files['xl/sharedStrings.xml'];
    if (ssFile) {
        const ssXml = await ssFile.async('string');
        for (const si of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
            const text = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
            shared.push(text);
        }
    }

    const sheetName = Object.keys(wb.files).find((n) => /xl\/worksheets\/sheet1\.xml$/i.test(n))
        ?? Object.keys(wb.files).find((n) => /xl\/worksheets\/.*\.xml$/i.test(n));
    if (!sheetName) return { headers: [], rows: [] };
    const sheetXml = await wb.files[sheetName].async('string');

    const cellText = (cell: string): string => {
        const t = /\bt="([^"]+)"/.exec(cell)?.[1];
        if (t === 'inlineStr') {
            const is = /<is>([\s\S]*?)<\/is>/.exec(cell);
            if (is) return [...is[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
            return '';
        }
        const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell);
        if (!v) return '';
        if (t === 's') return shared[Number(v[1])] ?? '';
        return decodeXml(v[1]);
    };

    const parsedRows: string[][] = [];
    for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const row: string[] = [];
        for (const cellMatch of rowMatch[1].matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
            const cell = cellMatch[0];
            const ref = /\br="([A-Z]+\d+)"/.exec(cell)?.[1];
            const idx = ref ? colToIndex(ref) : row.length;
            row[idx] = cellText(cell);
        }
        for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
        parsedRows.push(row);
    }

    if (parsedRows.length === 0) return { headers: [], rows: [] };
    const headers = parsedRows[0].map((h) => (h ?? '').trim().toLowerCase());
    return { headers, rows: parsedRows.slice(1) };
}

/** True when a name is a real, readable legal-entity name (has letters, no `*` mask). */
function isReadableName(name: string): boolean {
    const n = (name ?? '').trim();
    if (!n) return false;
    if (n.includes('*')) return false; // asterisk-redacted physical person
    return /[А-Яа-яA-Za-z]/.test(n); // must carry at least one letter
}

/** True when a subject id is a numeric ЕИК/БУЛСТАТ (9–13 digits), NOT a hex-encrypted ЕГН. */
function isEik(id: string): boolean {
    return /^\d{9,13}$/.test((id ?? '').trim());
}

/**
 * Extract LEGAL-ENTITY owners from a parsed ownership sheet. A row survives ONLY
 * when its «име на лицето» is a readable non-masked name AND its
 * «идентификационен номер на субекта» is a numeric ЕИК — i.e. a company /
 * institution. Every physical-person row (asterisk-masked name, hex-encrypted
 * ЕГН) is dropped and never returned. De-duplicates on (cadastralId, eik,
 * rightType).
 */
export function extractCompanyOwners(sheet: OwnershipSheet): CompanyOwner[] {
    const idx = (label: string) => sheet.headers.indexOf(label);
    const cCad = idx(COL.cadastralId);
    const cId = idx(COL.subjectId);
    const cName = idx(COL.name);
    const cKind = idx(COL.subjectKind);
    const cRight = idx(COL.rightType);
    if (cCad < 0 || cId < 0 || cName < 0) return []; // register shape not recognised

    const seen = new Set<string>();
    const out: CompanyOwner[] = [];
    for (const row of sheet.rows) {
        const cadastralId = (row[cCad] ?? '').trim();
        const eik = (row[cId] ?? '').trim();
        const name = (row[cName] ?? '').trim();
        // The privacy gate: legal entity ⇔ readable name + numeric ЕИК. Both required.
        if (!cadastralId || !isReadableName(name) || !isEik(eik)) continue;
        const rightType = cRight >= 0 ? (row[cRight] ?? '').trim() || null : null;
        const subjectKind = cKind >= 0 ? (row[cKind] ?? '').trim() || null : null;
        // NUL-separated so two different splits of the same characters cannot
        // produce one key. Written as the ESCAPE, not a raw byte: a raw NUL
        // makes this file binary to `grep`, which exempts it from
        // `scripts/detect-secrets.sh` and from every `grep -r` over `src/`
        // (#2446). Identical at runtime.
        const key = `${cadastralId}\u0000${eik}\u0000${rightType ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ cadastralId, eik, name, rightType, subjectKind });
    }
    return out;
}

/** Convenience: parse a „собственост ПИ.zip" buffer straight to legal-entity owners. */
export async function extractCompanyOwnersFromZip(zipBuffer: Buffer | Uint8Array): Promise<CompanyOwner[]> {
    return extractCompanyOwners(await parseOwnershipWorkbook(zipBuffer));
}

/**
 * Migration-safety ratchet for the ag ledger + data-integrity schema.
 *
 * The stock ledger (StockTransaction / InventoryLot / LotLink) and the
 * parcel acreage figure carry financial + regulatory weight. Their
 * append-only / integrity guarantees are enforced in the DB (immutability
 * triggers, a hash chain, a partial idempotency index, a non-NULL areaHa
 * CHECK). A migration is forward-only here — there are no down files — so
 * the only "reversibility" that matters is: a future migration must not
 * silently DROP one of those guarantees (irreversible data loss / integrity
 * regression). This guardrail scans every `migration.sql` and fails CI on:
 *
 *   1. a destructive DROP of a ledger TABLE,
 *   2. a DROP of an integrity COLUMN (hash chain, balances, idempotency),
 *   3. a DROP of a protected trigger / constraint / index that the same
 *      migration does NOT immediately re-create, and
 *   4. the establishing CREATE for each guarantee going missing entirely.
 *
 * Pure static scan of `prisma/migrations`. A real removal trips it; the
 * mutation-regression proof confirms the detectors aren't vacuous.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

const LEDGER_TABLES = ['StockTransaction', 'InventoryLot', 'LotLink'] as const;

/** (table → integrity columns whose loss would break the ledger). */
const INTEGRITY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    StockTransaction: ['entryHash', 'previousHash', 'quantityDelta', 'idempotencyKey'],
    InventoryLot: ['quantityOnHand'],
    LotLink: ['parentLotId', 'childLotId'],
};

/**
 * DB objects that MUST exist (some migration creates them) and must never
 * be dropped without a same-file recreate. Each carries the regex that
 * matches its CREATE.
 */
const PROTECTED_OBJECTS: ReadonlyArray<{ name: string; create: RegExp; kind: string }> = [
    { name: 'stock_transaction_immutable', create: /CREATE\s+TRIGGER\s+stock_transaction_immutable\b/i, kind: 'trigger' },
    { name: 'lot_link_immutable', create: /CREATE\s+TRIGGER\s+lot_link_immutable\b/i, kind: 'trigger' },
    { name: 'parcel_area_ha_present', create: /ADD\s+CONSTRAINT\s+"?parcel_area_ha_present"?/i, kind: 'constraint' },
    { name: 'StockTransaction_tenantId_idempotencyKey_key', create: /CREATE\s+UNIQUE\s+INDEX\s+"?StockTransaction_tenantId_idempotencyKey_key"?/i, kind: 'index' },
];

function migrationFiles(): { rel: string; sql: string }[] {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        throw new Error(`scan root does not exist: ${MIGRATIONS_DIR} — a renamed root would scan zero files and pass (#875)`);
    }
    const out: { rel: string; sql: string }[] = [];
    for (const dir of fs.readdirSync(MIGRATIONS_DIR)) {
        const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
        if (fs.existsSync(file)) {
            out.push({ rel: `${dir}/migration.sql`, sql: fs.readFileSync(file, 'utf8') });
        }
    }
    return out;
}

/** Strip line + block comments so a commented-out DROP doesn't false-positive. */
function stripSqlComments(sql: string): string {
    return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const FILES = migrationFiles().map((f) => ({ ...f, code: stripSqlComments(f.sql) }));

describe('ag ledger — migration safety', () => {
    it('finds the migration corpus (not vacuous)', () => {
        expect(FILES.length).toBeGreaterThan(5);
    });

    it('no migration DROPs a ledger table', () => {
        const offenders: string[] = [];
        for (const f of FILES) {
            for (const table of LEDGER_TABLES) {
                const re = new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?"?${table}"?`, 'i');
                if (re.test(f.code)) offenders.push(`${f.rel}: DROP TABLE ${table}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no migration DROPs a ledger integrity column', () => {
        const offenders: string[] = [];
        for (const f of FILES) {
            for (const [table, cols] of Object.entries(INTEGRITY_COLUMNS)) {
                // ALTER TABLE "StockTransaction" ... DROP COLUMN "entryHash"
                if (!new RegExp(`ALTER\\s+TABLE\\s+"?${table}"?`, 'i').test(f.code)) continue;
                for (const colName of cols) {
                    const re = new RegExp(`DROP\\s+COLUMN\\s+(IF\\s+EXISTS\\s+)?"?${colName}"?`, 'i');
                    if (re.test(f.code)) offenders.push(`${f.rel}: ${table}.DROP COLUMN ${colName}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no migration DROPs a protected trigger/constraint/index without re-creating it', () => {
        const offenders: string[] = [];
        for (const f of FILES) {
            for (const obj of PROTECTED_OBJECTS) {
                const dropRe = new RegExp(`DROP\\s+(TRIGGER|INDEX)\\s+(IF\\s+EXISTS\\s+)?"?${obj.name}"?`, 'i');
                const dropConstraintRe = new RegExp(`DROP\\s+CONSTRAINT\\s+(IF\\s+EXISTS\\s+)?"?${obj.name}"?`, 'i');
                const drops = dropRe.test(f.code) || dropConstraintRe.test(f.code);
                if (drops && !obj.create.test(f.code)) {
                    offenders.push(`${f.rel}: DROP ${obj.kind} ${obj.name} without a same-file recreate`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('every protected guarantee is established by some migration', () => {
        const allCode = FILES.map((f) => f.code).join('\n');
        const missing = PROTECTED_OBJECTS.filter((obj) => !obj.create.test(allCode)).map(
            (obj) => `${obj.kind} ${obj.name}`,
        );
        expect(missing).toEqual([]);
    });

    // ─── Mutation-regression proofs (detectors are real) ───
    it('detects a DROP TABLE on a ledger table (regression proof)', () => {
        const broken = 'DROP TABLE IF EXISTS "StockTransaction";';
        let tripped = false;
        for (const table of LEDGER_TABLES) {
            if (new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?"?${table}"?`, 'i').test(broken)) tripped = true;
        }
        expect(tripped).toBe(true);
    });

    it('detects a dropped integrity column (regression proof)', () => {
        const broken = 'ALTER TABLE "StockTransaction" DROP COLUMN "entryHash";';
        const re = /DROP\s+COLUMN\s+(IF\s+EXISTS\s+)?"?entryHash"?/i;
        expect(re.test(broken)).toBe(true);
    });

    it('comment-stripping prevents a commented DROP false-positive', () => {
        const commented = stripSqlComments('-- DROP TABLE "StockTransaction";\nSELECT 1;');
        expect(/DROP\s+TABLE/i.test(commented)).toBe(false);
    });
});

/**
 * Guardrail: the append-only inventory tables have exactly one writer.
 *
 * StockTransaction is the hash-chained stock ledger; LotLink is the
 * append-only lot-genealogy graph. Both are DB-immutable (a trigger
 * blocks UPDATE/DELETE) and BOTH must be written ONLY through the
 * sanctioned writer `src/lib/inventory/stock-ledger.ts`
 * (`appendStockTransaction` / `appendLotLink`). For the ledger this keeps
 * the per-tenant hash chain and the denormalised
 * `InventoryLot.quantityOnHand` cache consistent within one
 * advisory-locked step; a direct `db.stockTransaction.create(...)` would
 * write an unchained row (breaking `verifyStockChain`) and skip the cache
 * refresh. For genealogy it keeps every provenance edge funnelled through
 * one idempotent, self-edge-rejecting writer.
 *
 * This ratchet scans the source tree for direct StockTransaction / LotLink
 * write calls and fails on any found outside the one sanctioned writer. It
 * is the structural twin of the DB immutability triggers — together they
 * make "append-only, single-writer" a property the codebase cannot
 * regress out of silently.
 *
 * Mirrors the spirit of the AuditLog append-only enforcement.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = [path.join(REPO_ROOT, 'src')];

/** The ONLY file allowed to write StockTransaction / LotLink rows. */
const SANCTIONED_WRITER = path.join(REPO_ROOT, 'src/lib/inventory/stock-ledger.ts');

/** Prisma write verbs on the append-only inventory models. */
const WRITE_RE =
    /\.(stockTransaction|lotLink)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            out.push(...walk(full));
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('stock ledger — single writer', () => {
    const files = SCAN_DIRS.flatMap(walk);

    it('detector finds a non-trivial number of source files (sanity)', () => {
        expect(files.length).toBeGreaterThan(100);
    });

    it('only src/lib/inventory/stock-ledger.ts writes StockTransaction / LotLink rows directly', () => {
        const violations: string[] = [];
        for (const file of files) {
            if (file === SANCTIONED_WRITER) continue;
            const src = fs.readFileSync(file, 'utf8');
            const matches = [...src.matchAll(WRITE_RE)];
            if (matches.length > 0) {
                const rel = path.relative(REPO_ROOT, file);
                const detail = [...new Set(matches.map((m) => `${m[1]}.${m[2]}`))].join(', ');
                violations.push(`${rel} — direct ${detail}`);
            }
        }
        if (violations.length > 0) {
            throw new Error(
                'Direct StockTransaction/LotLink write(s) detected outside the sanctioned writer:\n  ' +
                    violations.join('\n  ') +
                    '\n\nAppend via `appendStockTransaction(db, ctx, ...)` or ' +
                    '`appendLotLink(db, ctx, ...)` from `@/lib/inventory/stock-ledger` ' +
                    'instead — the ledger writer extends the hash chain and refreshes the ' +
                    'lot on-hand cache atomically; the genealogy writer is idempotent and ' +
                    'self-edge-rejecting.',
            );
        }
        expect(violations).toEqual([]);
    });

    it('the sanctioned writer actually exists + writes the ledger (anti-staleness)', () => {
        expect(fs.existsSync(SANCTIONED_WRITER)).toBe(true);
        const src = fs.readFileSync(SANCTIONED_WRITER, 'utf8');
        expect(WRITE_RE.test(src)).toBe(true);
    });
});

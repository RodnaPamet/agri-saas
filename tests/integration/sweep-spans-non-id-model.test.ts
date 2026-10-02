/**
 * The key-rotation sweeps reach a model whose primary key is NOT `id`.
 *
 * ## Why this test is the only thing that proves it
 *
 * `global-key-rotation.ts` addressed every swept row by a literal `id`, in four
 * places, and `assertSweepableColumns` carried a check asserting `id` exists —
 * which is proof the author knew the column was load-bearing. #1254 replaced
 * all four with a declared row-key registry.
 *
 * That registry's `FeatureFlag` entry is INERT on its own branch: `FeatureFlag`
 * is in neither manifest there, so `sweepableColumns()` never yields it and the
 * entry is declared but never read. It becomes live only with the manifest
 * declaration in this change (#1222) — so after #1254 this file is the only
 * thing standing between "the registry entry exists" and "the registry entry
 * is reached".
 *
 * That distinction has already cost once in this area: `repairMisplacedV2`
 * shipped with tests and no caller, defined and proven and impossible to
 * invoke.
 *
 * ## Shape
 *
 * Behaviour, never the registry by name. A test asserting
 * `SWEEP_ROW_KEY.FeatureFlag === 'key'` would pass against a registry nothing
 * consults, which is the exact failure being guarded. So this asserts the
 * sweep SPANS the model and COMPLETES on it, which is only possible if the key
 * resolved — and it keeps a `FeatureFlag.description` PRESENT assertion, since
 * a sweep that silently narrowed back to `id`-keyed models would otherwise
 * pass by doing less.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    countMisplacedV2,
    repairMisplacedV2,
    sweepableColumns,
} from '@/app-layer/usecases/global-key-rotation';

import { DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const SCHEMA_DIR = path.resolve(__dirname, '../../prisma/schema');

describeFn('the rotation sweeps span a non-`id` model (#1222 / #1254)', () => {
    it('control: FeatureFlag.description is in the derived column set at all', () => {
        // If the manifest declaration is ever dropped, every assertion below
        // would pass by vacuity — the sweep would simply not reach the model.
        const cols = sweepableColumns().map((c) => `${c.model}.${c.column}`);
        expect(cols.length).toBeGreaterThan(10);
        expect(cols).toContain('FeatureFlag.description');
    });

    it('the repair sweep ADDRESSES it and completes — the row key resolved', async () => {
        // The end-to-end proof. Before #1254 this threw
        // `42703: column "id" does not exist`, because FeatureFlag keys on
        // `key`. Completing at all is the assertion; `found` being a number
        // means the SELECT that finds rows ran.
        const results = await repairMisplacedV2();
        const swept = results.map((r) => `${r.model}.${r.column}`);

        expect(swept).toContain('FeatureFlag.description');
        const ff = results.find((r) => r.model === 'FeatureFlag');
        expect(typeof ff?.found).toBe('number');
        expect(ff?.errors).toBe(0);
    });

    it('CONTROL: an `id`-keyed model is swept in the same pass', async () => {
        // Without this, "FeatureFlag is swept" is consistent with a registry
        // that broke the default and now sweeps ONLY the declared exceptions.
        const swept = (await repairMisplacedV2()).map((r) => r.model);
        expect(swept).toContain('ExchangeMessage');
        expect(new Set(swept).size).toBeGreaterThan(1);
    });

    it('counting is unaffected and stays convergent', async () => {
        // `countMisplacedV2` reaches the same column set. A non-zero count here
        // on a fresh database would mean the repair is not converging.
        const before = await countMisplacedV2();
        await repairMisplacedV2();
        const after = await countMisplacedV2();
        expect(after).toBeLessThanOrEqual(before);
    });

    it('FeatureFlag still has NO `id` column — the premise this file rests on', () => {
        // Guards against a future "fix" that adds a surrogate `id` to
        // FeatureFlag so the sweep works without a registry. The schema is
        // explicit that `key` IS the identity and that two rows for one switch
        // is the bug it prevents, so a surrogate would reintroduce exactly
        // that — and would also make every assertion above pass for the wrong
        // reason, since the sweep would then find the `id` it used to demand.
        const src = fs
            .readdirSync(SCHEMA_DIR)
            .filter((f) => f.endsWith('.prisma'))
            .map((f) => fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8'))
            .join('\n');
        const body = /^model\s+FeatureFlag\s*\{([\s\S]*?)^\}/m.exec(src)?.[1];
        expect(body).toBeDefined();
        expect(/^\s+id\s+\S/m.test(body as string)).toBe(false);
        expect(/^\s+key\s+String\s+@id/m.test(body as string)).toBe(true);
    });
});

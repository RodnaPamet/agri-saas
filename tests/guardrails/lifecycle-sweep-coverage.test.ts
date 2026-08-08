/**
 * Guardrail: every model with a lifecycle-expiry shape has a sweep job.
 *
 * A model whose status enum contains `EXPIRED` and which carries an
 * `expiresAt` column is making a promise: rows flip to EXPIRED once the
 * deadline passes. That promise is only kept if a scheduled job actually
 * performs the transition — otherwise rows sit ACTIVE-but-past-expiry forever,
 * which is a correctness AND a security bug (e.g. an "expired" access grant
 * that never actually expires).
 *
 * This ratchet reads the LIVE Prisma schema, finds every such model, and
 * asserts it maps to a registered job in `src/app-layer/jobs/schedules.ts`.
 * A new expiry-shaped model can't ship without wiring its sweep (or an
 * explicit, reasoned exception).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** model → the schedules.ts job name that performs its EXPIRED transition. */
const MODEL_SWEEP_JOBS: Record<string, string> = {
    ExchangeListing: 'exchange-expiry-sweep',
};

/**
 * Models that have the expiry shape but legitimately need NO sweep job, each
 * with a written reason. Empty today — every expiry-shaped model is swept.
 */
const NO_SWEEP_EXCEPTIONS: Record<string, string> = {
    // ModelName: 'reason a background sweep is unnecessary',
};

function readSchema(): string {
    const dir = path.join(ROOT, 'prisma/schema');
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.prisma'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
}

function blocks(schema: string, kind: 'enum' | 'model'): Array<{ name: string; body: string }> {
    const re = new RegExp(`${kind}\\s+(\\w+)\\s*\\{([^}]*)\\}`, 'g');
    const out: Array<{ name: string; body: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(schema)) !== null) out.push({ name: m[1], body: m[2] });
    return out;
}

/** Models whose status enum contains EXPIRED AND which have an expiresAt column. */
function expiryShapedModels(schema: string): string[] {
    const expiredEnums = new Set(
        blocks(schema, 'enum')
            .filter((e) => /^\s*EXPIRED\s*$/m.test(e.body))
            .map((e) => e.name),
    );
    const out: string[] = [];
    for (const model of blocks(schema, 'model')) {
        const hasExpiresAt = /\bexpiresAt\s+DateTime/.test(model.body);
        if (!hasExpiresAt) continue;
        // A scalar field typed as one of the EXPIRED-bearing enums.
        const hasExpiredStatus = [...expiredEnums].some((en) =>
            new RegExp(`\\n\\s*\\w+\\s+${en}\\b`).test(model.body),
        );
        if (hasExpiredStatus) out.push(model.name);
    }
    return out.sort();
}

function registeredJobNames(): Set<string> {
    const src = fs.readFileSync(path.join(ROOT, 'src/app-layer/jobs/schedules.ts'), 'utf8');
    const names = new Set<string>();
    const re = /name:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
    return names;
}

describe('lifecycle-sweep-coverage', () => {
    const schema = readSchema();
    const models = expiryShapedModels(schema);
    const jobs = registeredJobNames();

    it('finds the known expiry-shaped models (parser sanity)', () => {
        expect(models).toEqual(expect.arrayContaining(['ExchangeListing']));
    });

    it.each(expiryShapedModels(readSchema()))(
        '%s (EXPIRED + expiresAt) has a registered sweep job',
        (model) => {
            if (model in NO_SWEEP_EXCEPTIONS) return; // reasoned opt-out
            const jobName = MODEL_SWEEP_JOBS[model];
            expect(jobName).toBeDefined();
            expect(jobs.has(jobName)).toBe(true);
        },
    );

    it('every MODEL_SWEEP_JOBS entry still corresponds to an expiry-shaped model (no stale map)', () => {
        const live = new Set(models);
        const stale = Object.keys(MODEL_SWEEP_JOBS).filter((m) => !live.has(m));
        expect(stale).toEqual([]);
    });

    it('detector self-test: a synthetic EXPIRED+expiresAt model with no job is caught', () => {
        // One-value-per-line, matching the real schema format the parser targets.
        const synthetic = [
            'enum GadgetStatus {',
            '  ACTIVE',
            '  EXPIRED',
            '}',
            'model Gadget {',
            '  id String @id',
            '  status GadgetStatus',
            '  expiresAt DateTime',
            '}',
        ].join('\n');
        const found = expiryShapedModels(synthetic);
        expect(found).toContain('Gadget');
        // …and it is NOT in the sweep map → would fail the per-model assertion.
        expect('Gadget' in MODEL_SWEEP_JOBS).toBe(false);
    });
});

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
    return stripSchemaComments(
        fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.prisma'))
            .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
            .join('\n'),
    );
}

/**
 * Drop `///` and `//` comment lines before any block is parsed.
 *
 * ## Why this is load-bearing and not tidiness
 *
 * `blocks()` below delimits a body with `[^}]*`, which stops at the FIRST `}`
 * it meets. A brace inside a comment is indistinguishable from the end of the
 * block, so one `///` line mentioning `/f/{handle}` truncates the model body
 * before the parser ever reaches `expiresAt` — and the model then reads as not
 * expiry-shaped at all.
 *
 * That is not hypothetical and it is not rare. Measured across
 * `prisma/schema/` today: **24 comment lines in 11 files already contain a
 * brace** — `{ count }`, `Framework{kind:'AG_SCHEME'}`, `NOT: { a, b }`,
 * `/api/org/{slug}/tenants`. Every one of them silently shortens its model's
 * body for a parser of this shape. They happen not to hide `expiresAt` from
 * the models THIS guard cares about, which is the only reason it was green.
 *
 * P6.7 (#1816) added the first such comment to `ExchangeListing` — the one
 * model with a canary below — and the whole population collapsed to `[]`. The
 * canary is what turned a silent empty set into a loud failure; without it
 * this guard would have gone on passing over nothing, which is the shape of
 * defect this repository keeps finding.
 *
 * Comments carry no schema, so removing them cannot lose a field. Verified
 * before the change: the model count is 135 either way, and the only
 * difference in the expiry-shaped set is `ExchangeListing` returning.
 */
function stripSchemaComments(schema: string): string {
    // Line-wise, and only for lines whose first non-space is a comment marker.
    // A `//` appearing after a field (`x String // note`) is left alone: it
    // cannot introduce an unbalanced brace that a field line does not already
    // have, and blanking mid-line risks eating a default value.
    return schema
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
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

    it('is not fooled by a brace inside a comment', () => {
        // A POSITIVE CONTROL, independent of the live schema. The canary below
        // only catches this while `ExchangeListing` happens to be the model
        // carrying the brace; a comment added to any other model would empty
        // that model out of the population with nothing objecting.
        //
        // Built as a synthetic schema so it keeps its teeth no matter how the
        // real one changes.
        const synthetic = [
            'enum WidgetStatus {',
            '  ACTIVE',
            '  EXPIRED',
            '}',
            '',
            'model Widget {',
            '  id     String @id',
            '  /// Served at `/w/{handle}` — this brace is the whole test.',
            '  status WidgetStatus',
            '  expiresAt DateTime?',
            '}',
        ].join('\n');

        const stripped = stripSchemaComments(synthetic);
        expect(expiryShapedModels(stripped)).toEqual(['Widget']);

        // And the control for the control: WITHOUT the strip, the same schema
        // parses to nothing — so this test is measuring the strip and not
        // merely restating that the parser works.
        expect(expiryShapedModels(synthetic)).toEqual([]);
    });

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

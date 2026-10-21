/**
 * Every logger this product builds writes lines that leave the VM — #2101.
 *
 * ## The defect, measured twice
 *
 * `agrent`'s ops-agent keeps only container lines containing BOTH `requestId`
 * and `msg`. The reason is in that config's own docblock: container log paths
 * are keyed by container ID, which changes on every recreation, so no path
 * filter can name "the app" for longer than one deploy — and without a content
 * filter the VM would ship ~2.5M lines of pgbouncer/redis/caddy noise per
 * rotation to gain 74 useful ones.
 *
 * `requestId` was chosen because `src/lib/observability/logger.ts` injects it
 * unconditionally. But it does so in its `log()` WRAPPER, per call — not on
 * the pino instance — so a SECOND pino instance built anywhere else satisfies
 * neither term and every line it writes is dropped, silently, while printing
 * perfectly well to `docker logs`.
 *
 * Two existed. Measured over the full 14-day Cloud Logging window on
 * 2026-10-21, with a positive control:
 *
 *   job completed                 50 (query cap)   <- the shared helper
 *   processing job                 0               <- scripts/worker.ts
 *   job processed successfully     0
 *   worker shut down gracefully    0
 *   registering repeatable jobs    0               <- scripts/scheduler.ts
 *   all schedules registered       0
 *
 * #2101 named the worker. The scheduler had the same defect and was found by
 * deriving the population rather than taking the issue's word for it — which
 * is the argument for this file existing at all.
 *
 * ## The consequence is worse than missing logs
 *
 * An absent line reads as an absent event. #2091's question — does the
 * worker's graceful shutdown complete? — was not answerable from outside the
 * VM, because the only line that would say so was the one being dropped. The
 * wrong conclusion was drawn from that silence twice.
 *
 * ## Why the terms are DERIVED
 *
 * Hard-coding "requestId" and "msg" here would mirror a remote file by hand,
 * and a detector that mirrors a runtime by name goes stale without failing.
 * `deploy/ops-agent-config.yaml` is a tracked copy of the live config, and
 * this reads the filter terms out of it — so adding a third term to the filter
 * (and the mirror) re-points this guard automatically.
 *
 * What it cannot check is the mirror itself: a test cannot read a remote
 * machine. That limit, and the one-line diff that closes it, are recorded at
 * the top of the mirrored file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');
const MIRROR = path.join(ROOT, 'deploy/ops-agent-config.yaml');

/**
 * The words a line must contain to survive, read from the tracked mirror.
 *
 * Parsed with a regex rather than a YAML library: the entries are strings like
 * `jsonPayload.message !~ "requestId"`, so the structure that matters is
 * inside the string value and a parser gets no closer to it.
 */
function requiredTerms(): string[] {
    const raw = fs.readFileSync(MIRROR, 'utf8');
    const start = raw.indexOf('keep_only_json_payloads:');
    expect(start).toBeGreaterThan(-1);
    // Up to the next processor at the same indentation.
    const rest = raw.slice(start);
    const end = rest.search(/\n {4}[a-z_]+:\n/);
    const stanza = end > 0 ? rest.slice(0, end) : rest;
    return [...stanza.matchAll(/!~\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Every file that calls `pino({...})` directly. */
function pinoInstantiations(): Array<{ file: string; body: string }> {
    const out: Array<{ file: string; body: string }> = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.next') continue;
                walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
            // Blanked: a docblock that merely mentions `pino({` is prose, and
            // this guard's whole subject is which CALLS exist. The inverse
            // mistake — a comment satisfying a check — is what
            // `guards-blank-comments-before-matching` was written about.
            const src = blankNonCode(fs.readFileSync(full, 'utf8'));
            if (!/\bpino\(\{/.test(src)) continue;
            out.push({ file: path.relative(ROOT, full), body: src });
        }
    };
    walk(path.join(ROOT, 'src'));
    walk(path.join(ROOT, 'scripts'));
    return out;
}

/**
 * Instances that satisfy the filter through something other than `base`.
 *
 * One entry, and it is the reason the rule cannot simply be "every instance
 * has a base": the shared helper's `log()` wrapper adds `requestId` to every
 * call, which `tests/unit/observability-logger.test.ts` asserts directly —
 * including the no-context case, where it is the literal `'unknown'`.
 */
const WRAPPER_GUARANTEED: Record<string, string> = {
    'src/lib/observability/logger.ts':
        "The `log()` wrapper injects `requestId: ctx?.requestId ?? 'unknown'` on " +
        'every call, so the instance needs no base. Asserted by ' +
        'tests/unit/observability-logger.test.ts, which pins the no-context value.',
};

describe('every logger survives the ops-agent content filter', () => {
    const TERMS = requiredTerms();
    const INSTANCES = pinoInstantiations();

    it('derives a real filter and a real population', () => {
        // Either side emptying would make the assertion below vacuous — and an
        // empty TERMS list in particular would pass every instance for ever.
        expect(TERMS).toEqual(expect.arrayContaining(['requestId', 'msg']));
        expect(TERMS.length).toBeGreaterThanOrEqual(2);
        expect(INSTANCES.length).toBeGreaterThanOrEqual(3);
    });

    it('every pino instance either sets a satisfying base or is wrapper-guaranteed', () => {
        // `msg` is pino's own message key and is on every line it writes, so
        // the term a `base` has to supply is the other one.
        const supplied = TERMS.filter((t) => t !== 'msg');

        const failures: string[] = [];
        for (const { file, body } of INSTANCES) {
            if (file in WRAPPER_GUARANTEED) continue;
            const ctor = body.slice(body.indexOf('pino({'));
            const missing = supplied.filter((t) => !new RegExp(`base:[^}]*${t}`).test(ctor));
            if (missing.length > 0) failures.push(`${file} — base lacks: ${missing.join(', ')}`);
        }

        if (failures.length > 0) {
            throw new Error(
                `${failures.length} pino instance(s) write lines the ops-agent filter drops:\n` +
                    failures.map((f) => `  ${f}`).join('\n') +
                    `\n\nAdd the term to the instance's \`base\` — and restate \`pid\` and ` +
                    `\`hostname\` while you are there, because pino's \`base\` REPLACES its ` +
                    `defaults rather than merging (measured). Or route the file through ` +
                    `src/lib/observability/logger, where the guarantee already lives.\n\n` +
                    `A dropped line is not a missing log, it is a missing EVENT: #2091's ` +
                    `shutdown question was unanswerable for exactly this reason.`,
            );
        }
        expect(failures).toEqual([]);
    });

    it('base restates pid and hostname, because pino replaces rather than merges', () => {
        // Measured: `pino({ base: { requestId } })` emits
        // `level,msg,requestId,time` where the default emits
        // `hostname,level,msg,pid,time`. A fix that satisfied the filter and
        // dropped these would change the shape of every line the process
        // writes, which is the kind of change nobody notices until a query
        // that grouped by host returns one bucket.
        for (const { file, body } of INSTANCES) {
            if (file in WRAPPER_GUARANTEED) continue;
            const ctor = body.slice(body.indexOf('pino({'));
            const base = /base:\s*\{([^}]*)\}/.exec(ctor);
            expect(base).not.toBeNull();
            expect(base![1]).toContain('pid');
            expect(base![1]).toContain('hostname');
        }
    });

    it('every wrapper exemption names a file that exists and still has no base', () => {
        // A stale exemption silently stops exempting, or hides that the file
        // was fixed and the reason is now wrong.
        for (const [file, reason] of Object.entries(WRAPPER_GUARANTEED)) {
            const found = INSTANCES.find((i) => i.file === file);
            expect(found).toBeDefined();
            expect(reason.length).toBeGreaterThan(80);
        }
    });

    it('CONTROL: the detector would notice an instance with no base at all', () => {
        // Without this, a bug in the regex would pass every instance for ever.
        const supplied = ['requestId'];
        const naked = "const log = pino({ level: 'info' });";
        expect(supplied.some((t) => new RegExp(`base:[^}]*${t}`).test(naked))).toBe(false);
        const dressed = "const log = pino({ base: { pid: 1, hostname: 'h', requestId: 'unknown' } });";
        expect(supplied.every((t) => new RegExp(`base:[^}]*${t}`).test(dressed))).toBe(true);
    });
});

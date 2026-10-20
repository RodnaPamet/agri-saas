/**
 * The two halves of the shutdown window must agree — P7.3 (#1992).
 *
 * ## The failure this prevents
 *
 * A drain needs a window, and the window is set in two unrelated places:
 *
 *   - `stop_grace_period` on a service, which governs `docker compose stop`;
 *   - watchtower's `--stop-timeout`, which governs the containers WATCHTOWER
 *     stops when it recreates them on a new image.
 *
 * The second is the one that matters in practice — the app is recreated by
 * watchtower on `:latest` and that is the only thing that routinely interrupts
 * a live stream — and it is the one easier to forget, because it is a flag on
 * a `command:` line rather than a service key. Setting the service key alone
 * buys a drain that works when an operator stops the stack by hand and not
 * when the deploy pipeline does, which is precisely backwards and would show
 * up as "it worked when I tested it".
 *
 * #1992 asks for both at 30s. This asserts they are both present and EQUAL,
 * rather than asserting the literal 30 — a later decision to use 45s should
 * change one number in one file and still be held to agreeing with itself.
 *
 * ## Why only the vm manifest
 *
 * `deploy/docker-compose.vm.yml` is what runs: `docker compose ls` on the VM
 * reports the `agrent` project's config file as `/opt/agrent/docker-compose.vm.yml`.
 * `deploy/docker-compose.prod.yml` is, per CLAUDE.md, "the older
 * inflect-branded manifest, retained because the GAP-03 encryption-key
 * guardrail asserts its `:?`-fail-fast syntax — it still pins the PRE-move
 * `ghcr.io/inflect-compliance/inflect-compliance` path, which nothing runs".
 * Asserting over it too would be asserting over a file whose settings reach
 * no container, and the first version of this change edited exactly that file.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const VM_MANIFEST = 'deploy/docker-compose.vm.yml';

interface ComposeFile {
    services: Record<string, { command?: string | string[]; stop_grace_period?: string }>;
}

const doc = yaml.parse(
    fs.readFileSync(path.join(REPO_ROOT, VM_MANIFEST), 'utf8'),
) as ComposeFile;

/** `30s` / `45s` / `30` → seconds. */
function seconds(value: string): number | null {
    const m = /^(\d+)(s)?$/.exec(value.trim());
    return m ? Number(m[1]) : null;
}

/** The services whose process answers SIGTERM with work that takes time. */
const DRAINING_SERVICES = ['app', 'worker'] as const;

describe('the stop timeouts agree', () => {
    it('reports the population, so a renamed service cannot pass silently', () => {
        const names = Object.keys(doc.services);
        console.log(
            `[stop-timeouts] ${names.length} services in ${VM_MANIFEST}: ${names.join(', ')}`,
        );

        // Both the services asserted below and watchtower must still exist. A
        // rename would otherwise make every assertion range over nothing.
        for (const s of [...DRAINING_SERVICES, 'watchtower']) {
            expect(names).toContain(s);
        }
    });

    it('every draining service declares a stop_grace_period', () => {
        const missing = DRAINING_SERVICES.filter((s) => !doc.services[s]?.stop_grace_period);
        expect(missing).toEqual([]);
    });

    it('watchtower declares a --stop-timeout', () => {
        const cmd = doc.services.watchtower?.command;
        const flat = Array.isArray(cmd) ? cmd.join(' ') : (cmd ?? '');
        expect(flat).toMatch(/--stop-timeout\s+\S+/);
    });

    it('the two halves are the SAME duration', () => {
        const cmd = doc.services.watchtower?.command;
        const flat = Array.isArray(cmd) ? cmd.join(' ') : (cmd ?? '');
        const watchtower = seconds(/--stop-timeout\s+(\S+)/.exec(flat)?.[1] ?? '');

        expect(watchtower).not.toBeNull();

        for (const s of DRAINING_SERVICES) {
            const grace = seconds(doc.services[s].stop_grace_period!);
            expect(grace).not.toBeNull();
            expect(grace).toBe(watchtower);
        }
    });

    it('the window is long enough for the observability budgets to fit', () => {
        // `shutdown-budget.ts` races three stages at 3s + 2s + 2s and its
        // docblock reasons against a 30s grace period it did not have until
        // this change. The two numbers are allowed to differ; what is not
        // allowed is a grace period SHORTER than the work it bounds, which
        // would make the budgets unreachable by arithmetic rather than by a
        // race.
        // Comments blanked before the numbers are extracted (#1774). That
        // file's docblock discusses a 30s grace period and a 20s ceiling in
        // prose, so a raw grep for `SHUTDOWN_*_MS = N` would be summing
        // sentences — and the meta-guard that enforces this caught exactly
        // that in the first version of this file.
        const budget = blankNonCode(
            fs.readFileSync(
                path.join(REPO_ROOT, 'src/lib/observability/shutdown-budget.ts'),
                'utf8',
            ),
        );
        const stages = [...budget.matchAll(/SHUTDOWN_\w+_MS\s*=\s*([\d_]+)/g)]
            .map((m) => Number(m[1].replace(/_/g, '')))
            .filter((n) => n < 20_000); // the per-stage budgets, not the ceiling

        expect(stages.length).toBeGreaterThanOrEqual(3);
        const total = stages.reduce((a, b) => a + b, 0);

        const grace = seconds(doc.services.app.stop_grace_period!)! * 1000;
        expect(grace).toBeGreaterThanOrEqual(total);
    });
});

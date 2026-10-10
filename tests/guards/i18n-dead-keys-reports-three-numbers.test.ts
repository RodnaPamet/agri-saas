/**
 * Guard: the dead-key detector partitions the catalogue, and is ADVISORY
 * (#1534).
 *
 * ## What this grades, and why it is not a cap
 *
 * `scripts/i18n-dead-keys.mjs` reports keys no call site can reach. It must
 * never become a ratchet, and that is a fact about the codebase rather than a
 * preference: at least one real key is reachable only through a runtime value
 *
 *     // SmartDefaultsBanner.tsx:44,70
 *     const t = useTranslations('locations.smart');
 *     …  .map((r) => t(`sprayReason.${r.code}`, r.params))
 *
 * so a gate failing on unreferenced keys would demand deleting keys the app
 * renders. This suite therefore pins the detector's HONESTY — that it
 * partitions the catalogue three ways and says how much it could not decide —
 * not a number of dead keys.
 *
 * ## The control that matters
 *
 * `kpiOverdue` exists under TWO namespaces. `farmTasks.kpiOverdue` is rendered
 * (`FarmTasksClient.tsx:129` binds `farmTasks`, `:452` calls `t('kpiOverdue')`)
 * and `tasks.dashboard.kpiOverdue` is not reachable from anywhere — nothing
 * binds `tasks` or `tasks.dashboard`.
 *
 * The same leaf, opposite verdicts. That is the single assertion that proves
 * the detector resolves by NAMESPACE and not by leaf name, which is the failure
 * #1534 measured in its own first pass: counting a key as referenced when any
 * suffix of its path appears quoted makes `title` live because some file says
 * `'title'`. A detector with that bug passes every other assertion here.
 *
 * ## Why the three numbers are asserted as a partition
 *
 * `referenced + undecidable + unreferenced === total` is the property that
 * stops the counts drifting into nonsense independently — a resolver that
 * silently dropped a namespace would shrink one bucket without growing
 * another. The script enforces it too and exits 2 if it fails; this asserts it
 * from outside, because a script that both computes and validates its own
 * invariant has nobody checking the checker.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

interface Report {
    total: number;
    referenced: number;
    undecidable: number;
    unreferenced: number;
    filesScanned: number;
    literalCalls: number;
    dynamicCalls: number;
    wholeNamespaceDynamic: number;
    undecidablePrefixes: string[];
    unreferencedKeys: string[];
}

const SCRIPT = join(process.cwd(), 'scripts/i18n-dead-keys.mjs');

let report: Report;
beforeAll(() => {
    const out = execFileSync('node', [SCRIPT, '--json'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    report = JSON.parse(out) as Report;
});

describe('the i18n dead-key detector (#1534)', () => {
    it('scanned a real population — the denominator', () => {
        // Without this, every assertion below is satisfied by scanning nothing:
        // an empty source tree yields an empty referenced set and a "dead"
        // count equal to the whole catalogue, which would look like a dramatic
        // finding rather than a broken walker.
        expect(report.filesScanned).toBeGreaterThan(1500);
        expect(report.total).toBeGreaterThan(5000);
        expect(report.literalCalls).toBeGreaterThan(3000);
    });

    it('partitions the catalogue — the three numbers sum to the total', () => {
        expect(report.referenced + report.undecidable + report.unreferenced).toBe(report.total);
    });

    it('resolution actually works — most keys are REFERENCED', () => {
        // The collapse this catches: a resolver that fails to bind namespaces
        // reports nearly everything dead, and the partition identity above
        // still holds. A low `referenced` is the tell.
        expect(report.referenced).toBeGreaterThan(3000);
    });

    it('the same leaf under two namespaces gets OPPOSITE verdicts', () => {
        // The discriminator. A suffix-matching detector — #1534's own first
        // method — calls both live, because the string 'kpiOverdue' appears in
        // the tree. Resolution by namespace is what separates them.
        expect(report.unreferencedKeys).not.toContain('farmTasks.kpiOverdue');
        expect(report.unreferencedKeys).toContain('tasks.dashboard.kpiOverdue');
    });

    it('a prefix-composed key resolves through its binding', () => {
        // `useTranslations('agStatus')` + `t('spray.parcelsDone')`.
        // SprayJobCompletionCard.tsx. Reading the call site without resolving
        // the namespace would mark this dead.
        expect(report.unreferencedKeys).not.toContain('agStatus.spray.parcelsDone');
    });

    it('a template-built key is UNDECIDABLE, not dead', () => {
        // The reason this can never be a gate. The static head of the template
        // is the prefix, so only `sprayReason.*` is undecidable rather than all
        // of `locations.smart` — otherwise one dynamic call site would bury a
        // whole namespace and the advisory list would be useless.
        expect(report.undecidablePrefixes).toContain('locations.smart.sprayReason');
        expect(report.unreferencedKeys.some((k) => k.startsWith('locations.smart.sprayReason.'))).toBe(
            false,
        );
    });

    describe('the server-side email mechanism is resolved too', () => {
        // `notificationEmail` came back 99 of 106 unreferenced, which is the
        // same shape as the `tasks` number — too high to believe without
        // checking. It was the detector, not the catalogue: email templates do
        // not use `useTranslations` at all. They call
        // `translateFor(locale, key)` (`lib/i18n/server-messages.ts:69`),
        // which takes the FULL key path and binds no namespace, and 19 of
        // those call sites build the key from a template.
        //
        // So 127 keys were reported dead while being rendered in production
        // email. These two assertions are what stops that recurring — the
        // first names the mechanism, the second names the consequence.
        it('a translateFor template head is registered as an undecidable prefix', () => {
            const emailPrefixes = report.undecidablePrefixes.filter((p) =>
                p.startsWith('notificationEmail.'),
            );
            expect(emailPrefixes.length).toBeGreaterThanOrEqual(10);
            expect(emailPrefixes).toContain('notificationEmail.taskAssigned');
        });

        it('and NO notificationEmail key is left in the dead set', () => {
            // Every key in that namespace is reached either by a full-literal
            // `translateFor` (the backstop) or by a template (the prefixes
            // above). A non-zero count here means a third email mechanism has
            // appeared, which is worth knowing about rather than reviewing 99
            // false candidates.
            const dead = report.unreferencedKeys.filter((k) =>
                k.startsWith('notificationEmail.'),
            );
            expect(dead).toEqual([]);
        });
    });

    it('says how much it could not decide, and distinguishes the two reasons', () => {
        // A bare "N dead keys" repeats the mistake #1534 is about — a correct
        // number answering a question nobody asked. `undecidable` must be
        // visible, and a call passing a bare identifier (no static head at all)
        // is a weaker position than a template with one, so the counts are kept
        // apart rather than summed.
        expect(report.undecidable).toBeGreaterThan(0);
        expect(report.dynamicCalls).toBeGreaterThan(0);
        expect(report.wholeNamespaceDynamic).toBeGreaterThan(0);
        expect(report.wholeNamespaceDynamic).toBeLessThan(report.dynamicCalls);
    });

    it('is ADVISORY — it exits 0 even with unreferenced keys present', () => {
        // Asserted by the fact that the run in beforeAll did not throw:
        // execFileSync throws on a non-zero exit. Restated explicitly so the
        // intent survives a refactor that stops using execFileSync.
        expect(report.unreferenced).toBeGreaterThan(0);
        expect(() =>
            execFileSync('node', [SCRIPT], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
        ).not.toThrow();
    });
});

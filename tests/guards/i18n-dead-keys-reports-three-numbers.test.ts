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
 * A leaf that exists under TWO namespaces, one referenced and one not, is the
 * single assertion that proves the detector resolves by NAMESPACE rather than
 * by leaf name. It is COMPUTED at runtime, not named.
 *
 * It used to name `kpiOverdue`: `farmTasks.kpiOverdue` was rendered
 * (`FarmTasksClient.tsx:129` binds `farmTasks`, `:452` calls `t('kpiOverdue')`)
 * while `tasks.dashboard.kpiOverdue` was reachable from nowhere. That pair is
 * gone — those 101 `tasks.*` keys were verified unreachable and DELETED, which
 * is the cleanup this detector exists to enable. Naming a specific key made the
 * guard break on its own success, so the pair is now searched for instead.
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
import { readFileSync } from 'node:fs';
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

/** Every key in the shipped catalogue, flattened — the population the computed
 *  discriminator below searches for a same-leaf pair. */
function flattenCatalogue(): string[] {
    const raw = JSON.parse(
        readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'),
    ) as Record<string, unknown>;
    const out: string[] = [];
    const walk = (node: Record<string, unknown>, prefix: string): void => {
        for (const [k, v] of Object.entries(node)) {
            const path = prefix ? `${prefix}.${k}` : k;
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
                walk(v as Record<string, unknown>, path);
            } else {
                out.push(path);
            }
        }
    };
    walk(raw, '');
    return out;
}

const catalogueKeys = flattenCatalogue();

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
        // The discriminator: a suffix-matching detector — #1534's own first
        // method — calls both halves live, because the leaf string appears in
        // the tree. Resolution by NAMESPACE is what separates them.
        //
        // COMPUTED, not named. This used to assert the specific pair
        // `farmTasks.kpiOverdue` (live) against `tasks.dashboard.kpiOverdue`
        // (dead), which coupled the guard to one catalogue key: deleting a
        // verified-dead key broke the test that proves the detector works, so
        // the cleanup this detector exists to enable was blocked by its own
        // control. Finding a qualifying pair at runtime survives any deletion.
        //
        // If no such pair exists the test FAILS rather than passing vacuously,
        // which is the honest outcome — with no leaf under both a referenced
        // and an unreferenced parent, this property is untestable and nobody
        // should be told otherwise.
        const dead = new Set(report.unreferencedKeys);
        const undecidable = (k: string): boolean =>
            report.undecidablePrefixes.some((p) => k === p || k.startsWith(`${p}.`));

        const byLeaf = new Map<string, string[]>();
        for (const key of catalogueKeys) {
            const leaf = key.slice(key.lastIndexOf('.') + 1);
            if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
            byLeaf.get(leaf)!.push(key);
        }

        const pairs: Array<{ leaf: string; live: string; dead: string }> = [];
        for (const [leaf, keys] of byLeaf) {
            if (keys.length < 2) continue;
            const live = keys.find((k) => !dead.has(k) && !undecidable(k));
            const gone = keys.find((k) => dead.has(k));
            if (live && gone) pairs.push({ leaf, live, dead: gone });
        }

        // At least one, and the verdicts really are opposite for it.
        expect(pairs.length).toBeGreaterThan(0);
        const [sample] = pairs;
        expect(dead.has(sample.live)).toBe(false);
        expect(dead.has(sample.dead)).toBe(true);
        expect(sample.live).not.toBe(sample.dead);
        expect(sample.live.endsWith(`.${sample.leaf}`)).toBe(true);
        expect(sample.dead.endsWith(`.${sample.leaf}`)).toBe(true);
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

    describe('a member-expression key is resolved too', () => {
        // `backNav` came back 37 of 38 unreferenced — the third
        // too-high-to-believe ratio in this namespace list, and the second
        // caused by the detector rather than the catalogue.
        //
        //     // BackAffordance.tsx:123
        //     t.has(destination.label) ? t(destination.label) : destination.label
        //
        // The bare-identifier matcher's character class excluded `.`, so it
        // stopped at the dot, required `,` or `)`, and matched nothing. Nine
        // such call sites exist and each silently cost its namespace.
        //
        // The idiom matters: `t.has(k) ? t(k) : k` is the CORRECT way to call
        // a possibly-missing key, so the most carefully written call sites
        // were the ones most likely to be misreported.
        it('the namespace of a member-expression call is undecidable', () => {
            expect(report.undecidablePrefixes).toContain('backNav');
        });

        it('and NO backNav key is left in the dead set', () => {
            const dead = report.unreferencedKeys.filter((k) => k.startsWith('backNav.'));
            expect(dead).toEqual([]);
        });

        it('the whole-namespace count rose to match — 19 sites were invisible', () => {
            // The number that proves the matcher widened rather than the
            // catalogue shrinking. Before the fix this was 19; the nine
            // member-expression sites (some firing more than once) take it to
            // 38. A regression here means the dot left the character class.
            expect(report.wholeNamespaceDynamic).toBeGreaterThanOrEqual(30);
        });
    });

    describe('a translator name rebound in one file resolves to BOTH namespaces', () => {
        // `FarmTaskDetailClient.tsx` binds `t` twice, in two component scopes:
        //
        //     :105   const t = useTranslations('tasks.detail');
        //     :1060  const t = useTranslations('tasks.detail.links');
        //
        // A `Map<name, string>` keeps only the last, so all 87 `t(...)` calls
        // in that file resolved against `tasks.detail.links` and every real
        // `tasks.detail.*` key read as dead — 76 of them, the largest single
        // distortion this detector had.
        //
        // Resolving against every namespace the name is bound to over-marks
        // `referenced`, which is the SAFE direction for a dead-key report: it
        // under-reports dead keys rather than proposing a live one for
        // deletion. Exactly 1 file of 315 rebinds a name, so the over-marking
        // is bounded.
        it('tasks.detail is almost entirely referenced, not dead', () => {
            const dead = report.unreferencedKeys.filter((k) => k.startsWith('tasks.detail.'));
            // 76 before the multimap, 8 after. A regression to the single-value
            // Map takes this straight back over 70.
            expect(dead.length).toBeLessThan(20);
        });

        it('and the detector has NOT just become permissive — the control', () => {
            // The assertion above passes either because resolution improved or
            // because the detector started calling everything live. This
            // separates them.
            //
            // It used to name `tasks.list` / `tasks.sheet` / `tasks.dashboard`
            // as namespaces that must stay dead. Those 101 keys were then
            // VERIFIED unreachable and deleted (#1534), so naming them would
            // have made this guard fail on the cleanup it enabled. Stated as a
            // property instead: the dead set is non-empty, and the detector
            // still resolves the large majority of the catalogue — a
            // permissive detector shows up as the first number collapsing.
            expect(report.unreferenced).toBeGreaterThan(0);
            expect(report.referenced).toBeGreaterThan(3000);
            expect(report.referenced + report.undecidable + report.unreferenced).toBe(
                report.total,
            );
        });
    });

    describe('a translator passed as an ARGUMENT is resolved too', () => {
        // `weeds` came back 15 of 15 — the fourth too-high-to-believe ratio,
        // and the limitation this script's own docblock already named:
        //
        //     // weed-options.ts:85
        //     export function weedLabel(t: WeedTranslator, value: string) {
        //         return t.has(value) ? t(value) : value;
        //     }
        //
        // Called as `weedLabel(tWeeds, x)`, so the translator crosses a
        // function boundary and no `<var>(...)` pattern sees it.
        //
        // The helper set is DERIVED from the `: SomethingTranslator` parameter
        // convention, not hand-listed. That distinction is the safety: a list
        // keyed on "a translator passed as an argument" would have matched
        // `clearTimeout(t)`, `String(t)` and `Date(t)`, where `t` is a timer
        // handle — and marking a namespace undecidable on the strength of a
        // `clearTimeout` call shrinks the dead set for a bogus reason, exactly
        // as matching `translate(` would have via CSS transforms.
        it('the helper set is derived and non-empty — the denominator', () => {
            // If the convention is renamed, this suite must fail rather than
            // silently resolve nothing: an empty taker set makes the whole
            // mechanism a no-op while every other assertion still passes.
            expect(report.wholeNamespaceDynamic).toBeGreaterThanOrEqual(40);
        });

        it('weeds is undecidable, not dead', () => {
            expect(report.undecidablePrefixes).toContain('weeds');
            expect(report.unreferencedKeys.filter((k) => k.startsWith('weeds.'))).toEqual([]);
        });

        it('crops too — the same helper shape', () => {
            expect(report.unreferencedKeys.filter((k) => k.startsWith('crops.'))).toEqual([]);
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

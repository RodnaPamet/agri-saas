/**
 * Every deployed container caps its own logs (#1507).
 *
 * ## The incident
 *
 * Docker's default `json-file` driver NEVER rotates. On 2026-10-07 the shared
 * VM's 79 GB disk reached 100%: playerz-db PANICked on a checkpoint and
 * agrent's Redis failed its background saves (MISCONF) until space was freed.
 * Images and build cache were the main cause; container logs are the other
 * unbounded thing on the same disk, and nothing bounded them.
 *
 * ## Why a guard and not just the fix
 *
 * The fix is one `logging: *logging` line per service, and the failure mode is
 * a service added WITHOUT it. That is invisible: the stack comes up, the new
 * container logs happily, and the disk fills months later during an unrelated
 * incident — which is exactly how this was found, from the other product's
 * side (RodnaPamet/projectZ#440).
 *
 * So the population is derived from the file rather than listed here. A
 * curated list of services is a list somebody forgets, which is the #805
 * lesson this repo applies to its other derived guards.
 *
 * ## Which files, and why not all four
 *
 * `prod` and `staging` only — the two that run on a shared VM with a finite
 * disk. `docker-compose.yml` (dev) and `docker-compose.test.yml` run on a
 * developer's machine and in CI, where containers are short-lived and the
 * disk is not shared with another product. Stated with a number beside it
 * below rather than left as an unexamined boundary: a scope without one is a
 * blind spot.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** The compose files describing containers on the shared VM. */
const DEPLOYED = ['docker-compose.prod.yml', 'docker-compose.staging.yml'];

/** Left uncapped on purpose — see the docblock. */
const NOT_DEPLOYED = ['docker-compose.yml', 'docker-compose.test.yml'];

interface ComposeFile {
    services?: Record<string, { logging?: { driver?: string; options?: Record<string, unknown> } } | null>;
}

const load = (rel: string): ComposeFile =>
    yaml.load(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as ComposeFile;

describe('container logs are capped (#1507)', () => {
    it('prints the denominator, including what it does NOT cover', () => {
        const counts = DEPLOYED.map((f) => Object.keys(load(f).services ?? {}).length);
        const outside = NOT_DEPLOYED.map((f) => Object.keys(load(f).services ?? {}).length);
        console.log(
            `[container-logs-are-capped] ${DEPLOYED.length} deployed file(s), ` +
                `${counts.reduce((a, b) => a + b, 0)} service(s) covered. ` +
                `OUT OF SCOPE: ${NOT_DEPLOYED.length} local file(s), ` +
                `${outside.reduce((a, b) => a + b, 0)} service(s) — dev and CI, ` +
                `short-lived containers on an unshared disk.`,
        );
        // A file that lost its `services:` key, or a renamed one, would make
        // every assertion below run over an empty set.
        for (const n of counts) expect(n).toBeGreaterThanOrEqual(5);
    });

    it.each(DEPLOYED)('%s caps every service', (rel) => {
        const services = load(rel).services ?? {};
        const uncapped: string[] = [];
        for (const [name, def] of Object.entries(services)) {
            const logging = def?.logging;
            const size = logging?.options?.['max-size'];
            const files = logging?.options?.['max-file'];
            if (logging?.driver !== 'json-file' || !size || !files) uncapped.push(name);
        }
        if (uncapped.length > 0) {
            throw new Error(
                `${uncapped.length} service(s) in ${rel} have unbounded container logs ` +
                    `(#1507):\n\n` +
                    uncapped.map((u) => `  ${u}`).join('\n') +
                    `\n\nAdd \`logging: *logging\` to each — the anchor is defined at ` +
                    `the top of the file. json-file never rotates, and this VM's disk ` +
                    `is shared with another product; it reached 100% once already.`,
            );
        }
        expect(uncapped).toEqual([]);
    });

    it.each(DEPLOYED)('%s bounds the total, not just each file count', (rel) => {
        // A cap of `max-size: 10g` would satisfy the assertion above and bound
        // nothing useful. The numbers are asserted, so raising them is a
        // deliberate edit rather than a silent one.
        const services = Object.entries(load(rel).services ?? {});
        for (const [name, def] of services) {
            expect(def?.logging?.options?.['max-size']).toBe('10m');
            expect(String(def?.logging?.options?.['max-file'])).toBe('3');
        }
        // 10m x 3 per container, so the whole stack is bounded.
        const perContainerMb = 10 * 3;
        console.log(
            `[container-logs-are-capped] ${rel}: ${services.length} x ${perContainerMb} MB ` +
                `= ${services.length * perContainerMb} MB ceiling.`,
        );
        expect(services.length * perContainerMb).toBeLessThan(500);
    });

    it('the detector can see an uncapped service — positive control', () => {
        // `a-probe-with-no-discriminating-power`: the assertions above pass
        // identically when the parse silently returns nothing and when every
        // service is genuinely capped.
        const sample = yaml.load(`
services:
  capped:
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
  uncapped:
    image: nginx
`) as ComposeFile;
        const uncapped = Object.entries(sample.services ?? {})
            .filter(([, d]) => d?.logging?.driver !== 'json-file' || !d?.logging?.options?.['max-size'])
            .map(([n]) => n);
        expect(uncapped).toEqual(['uncapped']);
    });

    it('the anchor is actually an anchor — one place to change the numbers', () => {
        // Asserted on the source text, because the parsed form cannot tell an
        // alias from six copies of the same literal. Six copies would pass
        // every test above and make the next change a six-line edit somebody
        // does five times.
        for (const rel of DEPLOYED) {
            const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            expect(src).toMatch(/^x-logging:\s*&logging\s*$/m);
            const aliases = [...src.matchAll(/^\s+logging:\s*\*logging\s*$/gm)];
            expect(aliases.length).toBe(Object.keys(load(rel).services ?? {}).length);
        }
    });
});

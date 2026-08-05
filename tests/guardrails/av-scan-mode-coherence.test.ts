/**
 * The AV configuration must describe a scanner that exists.
 *
 * Before this ratchet the repo told four different stories about the same
 * setting: `src/env.ts` defaulted to `strict`, the prod and staging compose
 * files said `strict` (and each does run a ClamAV service, so those were
 * fine), the LIVE agrent stack said `disabled` with no scanner, the prod
 * example env said `permissive` with no scanner, and `docs/cloud-storage.md`
 * documented the default as `permissive`. Nothing was in a position to
 * notice, because the setting only becomes visible when an upload is blocked.
 *
 * That mattered more than a docs nit. `markStored` hardcoded `scanStatus:
 * PENDING`, nothing in the codebase ever advanced it, and the download gate
 * 403s a PENDING file — so a deployment that took the `strict` default without
 * a scanner blocked every evidence download, permanently and silently. It was
 * a dead-man switch, and production escaped it only by turning scanning off.
 *
 * `scanUploadedBuffer` now returns a TERMINAL status, which removes the
 * detonator. This test removes the ambiguity that armed it: a compose file may
 * only name a SCANNING mode if it also gives the app a scanner to reach.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

/** Compose files that configure the app, and whether each is a live stack. */
const COMPOSE_FILES = [
    'docker-compose.prod.yml',
    'docker-compose.staging.yml',
    'deploy/docker-compose.vm.yml',
    'deploy/docker-compose.prod.yml',
];

/** A mode that claims files are examined. `disabled` claims nothing. */
const SCANNING_MODES = ['strict', 'permissive'];

function read(rel: string): string | null {
    const p = join(ROOT, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

describe('AV_SCAN_MODE coherence', () => {
    it.each(COMPOSE_FILES)('%s only claims a scanning mode when it wires a scanner', (rel) => {
        const content = read(rel);
        if (content === null) return; // file retired — nothing to assert

        const modes = [...content.matchAll(/^\s*AV_SCAN_MODE:\s*(\S+)/gm)].map((m) => m[1]);
        if (modes.length === 0) return;

        const claimsScanning = modes.some((m) => SCANNING_MODES.includes(m));
        if (!claimsScanning) return;

        // A scanning mode is a promise. The host has to be able to keep it.
        expect(content).toMatch(/^\s*CLAMAV_HOST:\s*\S+/m);
    });

    it('the prod example env agrees with the live stack it documents', () => {
        // deploy/.env.prod.example describes the agrent VM, whose compose file
        // is deploy/docker-compose.vm.yml. Two files, one host, one answer.
        const example = read('deploy/.env.prod.example');
        const vm = read('deploy/docker-compose.vm.yml');
        if (example === null || vm === null) return;

        const exampleMode = example.match(/^AV_SCAN_MODE=(\S+)/m)?.[1];
        const vmModes = [...vm.matchAll(/^\s*AV_SCAN_MODE:\s*(\S+)/gm)].map((m) => m[1]);
        if (!exampleMode || vmModes.length === 0) return;

        for (const vmMode of vmModes) {
            expect(exampleMode).toBe(vmMode);
        }
    });

    it('every service in one compose file agrees with its siblings', () => {
        // app and worker both write FileRecords. A stack where the web tier
        // scans and the worker does not produces evidence whose scanStatus
        // depends on which process happened to handle the upload.
        for (const rel of COMPOSE_FILES) {
            const content = read(rel);
            if (content === null) continue;
            const modes = [...content.matchAll(/^\s*AV_SCAN_MODE:\s*(\S+)/gm)].map((m) => m[1]);
            expect(new Set(modes).size).toBeLessThanOrEqual(1);
        }
    });

    it('the documented default matches the schema default', () => {
        const envTs = readFileSync(join(ROOT, 'src/env.ts'), 'utf8');
        const schemaDefault = envTs.match(
            /AV_SCAN_MODE:\s*z\.enum\(\[[^\]]*\]\)\.default\("(\w+)"\)/,
        )?.[1];
        expect(schemaDefault).toBeTruthy();

        for (const doc of ['docs/cloud-storage.md', 'docs/infrastructure-runtime.md']) {
            const content = read(doc);
            if (content === null) continue;
            const row = content.split('\n').find((l) => l.includes('`AV_SCAN_MODE`'));
            if (!row) continue;
            // The row states a default in backticks; it must be the real one.
            expect(row).toContain(`\`${schemaDefault}\``);
        }
    });

    it('this test actually inspected something (self-check)', () => {
        const found = COMPOSE_FILES.filter((f) => read(f)?.includes('AV_SCAN_MODE'));
        expect(found.length).toBeGreaterThan(0);
    });
});

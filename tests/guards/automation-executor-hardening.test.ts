/**
 * PR-D — executor hardening ratchet. Keeps the safety guards present so a
 * refactor can't silently drop them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EXEC = read('src/app-layer/automation/action-executor.ts');

describe('executor hardening', () => {
    it('UPDATE_STATUS enforces a transition allowlist', () => {
        expect(EXEC).toMatch(/STATUS_ALLOWLIST/);
        expect(EXEC).toMatch(/Illegal .* status/);
    });

    it('WEBHOOK runs the SSRF guard + DNS re-check before fetch', () => {
        // The DNS half moved OUT of this file in #696. It used to be six inline
        // lines here — `lookup(...)` then `isPrivateAddress(address)` — which is
        // what this guard pinned. That made it the only copy, so the Web Push
        // guard would have inherited only the weaker structural half. It now
        // lives in `assertPublicAddress`, which additionally passes
        // `{ all: true }` (a multi-A host cannot pass on its first record) and
        // bounds the lookup.
        expect(EXEC).toMatch(/checkWebhookUrl/);
        expect(EXEC).toMatch(/assertPublicAddress\(/);
        expect(EXEC).not.toMatch(/isPrivateAddress\(address\)/); // not re-inlined
        // both halves precede the fetch call
        expect(EXEC.indexOf('checkWebhookUrl')).toBeLessThan(EXEC.indexOf('fetch('));
        expect(EXEC.indexOf('assertPublicAddress(')).toBeLessThan(EXEC.indexOf('fetch('));
    });

    it('CREATE_TASK dedupes before creating', () => {
        expect(EXEC).toMatch(/dedupeKey/);
        expect(EXEC).toMatch(/task\.findFirst/);
    });

    it('NOTIFY_USER respects the tenant notification kill-switch', () => {
        expect(EXEC).toMatch(/isNotificationsEnabled/);
    });
});

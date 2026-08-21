/**
 * PR-D — webhook SSRF guard.
 */
import {
    isPrivateAddress,
    checkWebhookUrl,
    checkPushEndpoint,
} from '@/app-layer/automation/webhook-safety';

describe('isPrivateAddress', () => {
    it.each(['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '::1', '0.0.0.0'])(
        'flags %s as private',
        (ip) => expect(isPrivateAddress(ip)).toBe(true),
    );
    it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1'])('allows public %s', (ip) =>
        expect(isPrivateAddress(ip)).toBe(false),
    );
});

describe('checkWebhookUrl', () => {
    it('rejects non-https', () => {
        expect(checkWebhookUrl('http://example.com').ok).toBe(false);
    });
    it('rejects localhost + private literals + metadata', () => {
        expect(checkWebhookUrl('https://localhost/h').ok).toBe(false);
        expect(checkWebhookUrl('https://169.254.169.254/').ok).toBe(false);
        expect(checkWebhookUrl('https://10.0.0.1/h').ok).toBe(false);
        expect(checkWebhookUrl('https://foo.internal/h').ok).toBe(false);
    });
    it('accepts a well-formed public https URL', () => {
        const v = checkWebhookUrl('https://hooks.example.com/path');
        expect(v.ok).toBe(true);
        expect(v.host).toBe('hooks.example.com');
    });
    it('rejects a malformed URL', () => {
        expect(checkWebhookUrl('not a url').ok).toBe(false);
    });
});

// ─── #696 — host classification, and the two evasions ────────────────

/**
 * Three defects, all measured against the pre-fix code before being fixed.
 *
 * The headline one is not an SSRF: it is a FALSE POSITIVE that would have
 * silently broken the feature this guard was about to be reused for. The
 * link-local / ULA test read `h.startsWith('fc') || h.startsWith('fd')` — no
 * colon, no is-it-an-IP check — so every hostname beginning with those two
 * letters was classified as a private ADDRESS. `fcm.googleapis.com` is every
 * Chrome/Chromium/Android Web Push endpoint. Reusing the guard verbatim would
 * have blocked that entire browser share while Firefox and Safari worked, and
 * it was already refusing any automation webhook on an `fc`/`fd` host with a
 * reason naming a cause that is not true.
 *
 * The other two are structural evasions. Both were caught by the DNS re-check
 * on the webhook path, so neither was an open SSRF — they matter because a
 * synchronous consumer (a zod refinement at write time) has no second layer
 * beneath it.
 */
describe('a hostname is not an IPv6 address', () => {
    it.each([
        'fcm.googleapis.com',
        'fdn.example.com',
        'fc-tractors.bg',
        'fe80.example.com',
        'updates.push.services.mozilla.com',
        'web.push.apple.com',
    ])('%s is not a private address', (host) => {
        expect(isPrivateAddress(host)).toBe(false);
    });

    it('and the real v6 private forms are still blocked', () => {
        // Resolving power: a fix that simply stopped matching v6 would satisfy
        // every assertion above.
        for (const ip of ['fe80::1', 'fc00::1', 'fd00::1', '::1', '::']) {
            expect(isPrivateAddress(ip)).toBe(true);
        }
    });

    it('accepts a public v6 literal', () => {
        expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
    });
});

describe('v4-mapped IPv6 — both spellings', () => {
    it('blocks the dotted form', () => {
        expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    });

    it('blocks the HEX form, which is what URL normalisation produces', () => {
        // The evasion: `new URL('https://[::ffff:169.254.169.254]/').hostname`
        // is `[::ffff:a9fe:a9fe]`, so the dotted branch never saw it.
        expect(new URL('https://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
        expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true);
        expect(checkWebhookUrl('https://[::ffff:169.254.169.254]/').ok).toBe(false);
        expect(checkWebhookUrl('https://[::ffff:a9fe:a9fe]/').ok).toBe(false);
    });

    it('does not block a mapped PUBLIC v4', () => {
        expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    });
});

describe('host normalisation', () => {
    it('a trailing dot no longer defeats the name blocks', () => {
        // A legal FQDN root. It resolves identically, and it made both
        // `endsWith('.internal')` and the Set lookup miss.
        expect(checkWebhookUrl('https://metadata.google.internal./').ok).toBe(false);
        expect(checkWebhookUrl('https://foo.internal./').ok).toBe(false);
        expect(checkWebhookUrl('https://bar.local./').ok).toBe(false);
        expect(checkWebhookUrl('https://localhost./').ok).toBe(false);
    });

    it('casing does not either', () => {
        expect(checkWebhookUrl('https://METADATA.GOOGLE.INTERNAL/').ok).toBe(false);
    });

    it('the reported host is the normalised one, so the caller resolves what we checked', () => {
        const v = checkWebhookUrl('https://Example.COM./h');
        expect(v.ok).toBe(true);
        expect(v.host).toBe('example.com');
    });

    it('a hostless URL is refused rather than silently reinterpreted', () => {
        // `new URL('https:///x')` parses with hostname `x` — a real trap the
        // scheme pin in @/lib/schemas/url documents but cannot close.
        expect(checkWebhookUrl('https://').ok).toBe(false);
    });
});

describe('checkPushEndpoint — the push-specific rule', () => {
    it.each([
        'https://fcm.googleapis.com/fcm/send/abc123',
        'https://updates.push.services.mozilla.com/wpush/v2/abc',
        'https://web.push.apple.com/xyz',
        'https://abc.notify.windows.com/xyz',
    ])('allows the real push service %s', (url) => {
        expect(checkPushEndpoint(url).ok).toBe(true);
    });

    it('rejects a single-label host', () => {
        // Inside the compose network `redis`, `db`, `pgbouncer` and `caddy` all
        // resolve to 172.18.0.x, and a single-label name is neither an IP
        // literal nor a blocked name nor a `.internal` suffix — so
        // `checkWebhookUrl` alone allows it.
        expect(checkWebhookUrl('https://redis/').ok).toBe(true);
        expect(checkPushEndpoint('https://redis/').ok).toBe(false);
        expect(checkPushEndpoint('https://redis/').reason).toMatch(/single-label/);
    });

    it('rejects the hostless form, which parses to a single-label host', () => {
        expect(checkPushEndpoint('https:///wpush/v2/abc').ok).toBe(false);
    });

    it('still allows a bare public IP — that is the DNS layer’s call, not this one', () => {
        expect(checkPushEndpoint('https://93.184.216.34/x').ok).toBe(true);
    });
});

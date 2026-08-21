/**
 * The one spelling of "this field holds an `https:` URL".
 *
 * ## What the loose form actually accepts
 *
 * `z.string().url()` — what every payload URL field in this repo used to be —
 * accepts **any parseable URL**. Measured against the installed zod (4.4.3),
 * every one of these parses clean:
 *
 * ```
 * http://example.com/x        ftp://example.com/x       file:///etc/passwd
 * javascript:alert(1)         data:text/html,<script>   mailto:a@b.c
 * urn:example:idp             urn:uuid:6e8bc430-9c3a
 * ```
 *
 * ## Why this is a narrowing, not a vulnerability fix
 *
 * Two backstops already stop the alarming half of that list from reaching an
 * operator, and neither is a reason to leave the contract open:
 *
 *   - **React 19 rewrites `javascript:` hrefs** to
 *     `javascript:throw new Error('React has blocked a javascript: URL…')`.
 *   - **The CSP carries no `unsafe-inline` in `script-src`**
 *     (`src/lib/security/csp.ts`), so a `javascript:` URI is blocked there too.
 *
 * What survives both is the plain downgrade — `http://` renders as an ordinary
 * link out of an authenticated HTTPS app, on a phone where nobody inspects a
 * scheme — plus the deeper problem that a field whose contract is "anything
 * URL-shaped" is far wider than the one thing it is for. Narrowing the
 * contract is the point; the XSS class was already covered.
 *
 * ## The residue this does NOT close
 *
 * `z.url({ protocol: /^https$/ })` pins the SCHEME and nothing else. Measured:
 * it still accepts `https:///path` (no host component) — and node's `fetch`
 * then treats `path` as the **hostname** (`getaddrinfo EAI_AGAIN path`). It
 * also accepts `https://192.168.1.1/x`, so **this helper is not an SSRF
 * guard**. Server-side fetch targets need a host policy on top; the one this
 * repo has is `checkWebhookUrl` in `@/app-layer/automation/webhook-safety`.
 *
 * @module lib/schemas/url
 */
import { z } from 'zod';

/**
 * A URL field pinned to `https:`, capped at 2000 characters.
 *
 * The message is spelled out because zod's default is actively misleading
 * here: `http://idp.example.com` fails with `invalid_format: Invalid URL`,
 * which is wrong — it IS a valid URL, it is the wrong scheme. Moving the
 * refusal to config time (the point of #667) is worth little if the operator
 * cannot tell what was refused. English inline, matching the existing zod
 * messages in this repo (`'Name is required'`, `'Select at least one
 * recipient'`).
 *
 * The cap is uniform on purpose — it was previously present on some fields and
 * absent on others with no reason for the difference, and 2000 is well above
 * any legitimate value (the longest real one is a Web Push endpoint, ~200).
 *
 * Scheme matching is case-insensitive in effect: `URL.protocol` normalises, so
 * `HTTPS://example.com` passes. Measured, not assumed.
 */
export const httpsUrl = () =>
    z.url({ protocol: /^https$/, error: 'Must be an https:// URL' }).max(2000);

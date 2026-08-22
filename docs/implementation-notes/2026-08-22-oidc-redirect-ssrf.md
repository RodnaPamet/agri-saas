# 2026-08-22 — the SSRF policy has to survive a redirect (#708)

**Commit:** `see git log` fix(security): re-check the SSRF policy at every redirect hop

## Design

`fetchPublicUrl` in `src/lib/security/safe-fetch.ts` takes the redirect loop
back from `fetch` (`redirect: 'manual'`) and re-applies both layers of the host
policy — `checkWebhookUrl` then `assertPublicAddress` — before **every** hop.

Wired into the OIDC client's two outbound fetches, with deliberately different
budgets:

| call site | budget | why |
|---|---|---|
| `discoverOidc` | `maxRedirects: 3` | real issuers redirect; each hop is re-checked |
| `exchangeCodeForTokens` | **`maxRedirects: 0`** | the body carries `client_secret` |

## Why #707's fix did not transfer

#707 closed the Web Push SSRF with a single pre-flight host check, and that was
sufficient *there* for a library-specific reason: `web-push` uses raw
`https.request` and treats any non-2xx as an error
(`web-push-lib.js:377`) — there is no `Location` handling to abuse.

`fetch` is different, and I measured it rather than reasoning about it. Against a
local server returning `302 Location: http://127.0.0.1:9/blocked`:

```
redirect:follow   -> THREW TypeError: fetch failed     ← it FOLLOWED; port 9 refused
redirect:manual   -> status 302 location=http://127.0.0.1:9/blocked
```

The default followed into loopback and failed only because nothing was
listening. So a pre-flight check validates the URL the *caller* chose while the
*responder* chooses where the request lands.

## Decisions

- **`maxRedirects: 0` on the token exchange is the sharper half.** That POST
  carries `client_secret`. Following a redirect re-sends the body — credential
  included — to whatever host the `Location` names, which converts a redirect
  into a credential-exfiltration primitive; a `303` would additionally rewrite
  the method. A token endpoint has no legitimate reason to redirect.

- **`token_endpoint` comes out of the fetched document**, so a hostile or
  compromised IdP chooses it. It gets the same policy as the discovery URL
  rather than being trusted for having arrived over one.

- **Tests drive a real `http.Server`.** The behaviour under test is `undici`'s
  redirect handling. A mocked fetch would assert my understanding of undici back
  to me — "a mocked dependency cannot report that the dependency changed". The
  first test in the suite reproduces the premise itself: a default fetch lands
  on the second server, proven by that server's hit log.

- **Not closed: DNS rebinding.** Each hop resolves, is checked, then is
  re-resolved by the client. The per-hop timeout bounds the window; pinning the
  resolved address needs a custom agent.

## Three tests I had to add because mutations walked through the first draft

Worth recording, because in each case the assertion *looked* like it covered the
thing it did not.

1. **The per-hop test passed vacuously.** Both servers were on `127.0.0.1` and I
   blocked that host — so the refusal happened at hop 0 and the redirect was
   never exercised. Fixed by giving the origin a different *name* for the same
   machine (`localhost`), and by asserting the origin **was** hit while the
   target was not.

2. **The relative-`Location` test could not see the bug.** It used a single-hop
   chain, where resolving against the original URL and against the current hop
   give the same answer. Resolving against `rawUrl` passed. Fixed with a
   two-host chain where the second hop issues a relative `Location`.

3. **Nothing tested the token exchange's budget at all.** Flipping
   `maxRedirects: 0` → `3` left every suite green.
   `tests/unit/security/oidc-fetch-policy.test.ts` now asserts the attacker
   server is never hit *and* that the secret really did reach the first one —
   so it cannot pass because the exchange never ran.

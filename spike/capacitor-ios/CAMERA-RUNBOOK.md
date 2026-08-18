# P4 — native camera vs the web path

**Run only after P3.** If the offline stack does not survive the WKWebView, a
nicer camera does not rescue the spike.

Two of P4's questions were answered at the desk and are recorded as F9–F11 in the
spike document. Read those first — one of them (F10) changes what "native camera"
is worth.

---

## What is already settled without a device

- **It CAN join the existing outbox.** `enqueuePhoto(store, { url, blob,
  fileName, fileType, label })` takes a `Blob`, and a Capacitor `webPath` is
  `fetch()`-able into one. See `native-capture-bridge.ts` — the identical call.
  **There is no second queue**, so no reconciliation problem.
- **It inherits the scanner** if it posts to the same URL. The journal photo
  endpoint routes through `uploadLogEntryPhoto`, which calls
  `scanUploadedBuffer` and passes the result to `FileRepository.markStored`. A
  native path reusing that URL cannot bypass it. **Do not invent an endpoint** —
  that is the exact class `upload-route-scan-reachability` exists to catch.
- **The web path already opens the camera** (`capture={"environment"}`), so this
  is not a capability gain. Measure taps and bytes, or report no gain.

---

## Integration point (one call, applied during the device session)

`native-capture-bridge.ts` is deliberately not wired into `src/`. To wire it for
the session, add a second button beside the existing `<input type="file">` in
the journal photo attach UI and call `captureNativeAndQueue({ url, label })`.

**Leave the web input reachable.** The comparison is side-by-side; replacing the
web path destroys the measurement.

---

## The comparison table — fill with REAL NUMBERS

Same phone, same lighting, same subject, same tenant, three runs each, median.

| | web `<input capture>` | native `Camera.getPhoto` |
|---|---|---|
| taps from screen → queued | | |
| ms from tap → outbox entry exists | | |
| bytes stored in the outbox `Blob` | | |
| bytes received server-side | | |
| longest edge (px) of what arrives | | |
| subjectively usable at 100%? | | |
| works with Airplane Mode on | | |
| lands in the SAME outbox store | | |

Measure "ms to queued" in the Web Inspector, not by feel:

```js
performance.mark('tap');
// …capture…
performance.mark('queued'); performance.measure('capture', 'tap', 'queued');
console.log(performance.getEntriesByName('capture')[0].duration);
```

**If the native path is not smaller AND not fewer taps, say so.** Its remaining
value is then purely Guideline 4.2 mitigation, and it should be described that
way in the verdict rather than as a feature.

---

## Offline behaviour — the question worth more than the feature

- [ ] Airplane Mode on. Capture natively.
- [ ] Confirm the entry appears in the **same** outbox store the web path uses
      (same IndexedDB database and object store — not a Capacitor `Filesystem`
      copy, not a second store).
- [ ] Restore network. Confirm it syncs, and that exactly **one** record lands.
- [ ] **YES / NO — native capture joined the existing outbox:** ______

A NO here is a bigger finding than the camera itself and belongs in the verdict.

---

## Permission UX (P4.4)

iOS asks once, and a refusal is sticky — a first-run experience the PWA never had.

- [ ] Fresh install. Tap native capture. Screenshot the prompt **in Bulgarian**.
- [ ] Verbatim text shown: ______________________
- [ ] Refuse it. What does the app do — a useful message, or a dead button?
      ______________________
- [ ] Can the operator recover without deleting the app? (Settings → Agrent →
      Camera.) Is that path signposted anywhere in-app? ______

`ios-strings/{en,bg}.lproj/InfoPlist.strings` in this directory contain the copy,
using the app's own terminology from `messages/bg.json` (`снимки`, `полски
операции`). **Copy both into `ios/App/App/` and add them to the Xcode target**,
or iOS shows the English default and the Bulgarian operator gets an English
system prompt — which is itself a finding worth recording if it happens.

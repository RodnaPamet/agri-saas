/**
 * The assistant's SSE event union — #2578.
 *
 * ## Seven events, and each exists because some real state is otherwise
 * indistinguishable from a stalled connection
 *
 * That is the reason to port the set whole rather than trim it:
 *
 *   `thinking`     — the request was accepted and work has started.
 *   `tool_call`    — names the tool BEFORE its result arrives, which is what
 *                    justifies the wait to the person watching. A bare spinner
 *                    does not.
 *   `tool_result`  — whether it worked, and whether it was truncated.
 *   `answer`       — the answer. One event, not a token stream; see below.
 *   `refusal`      — no answer, WITH its cause. An empty stream that just ends
 *                    is indistinguishable from a crash, so the person retries,
 *                    which spends again and teaches them it is unreliable.
 *   `halt`         — the answer above is real but INCOMPLETE, which is the
 *                    whole point of having bounds.
 *   `done`         — separates "finished" from "connection open, nothing yet".
 *
 * **`error` is deliberately NOT a member.** Every terminal state a person
 * should see is `refusal`, `halt` or `done`. An `error` event would be a
 * fourth way to end carrying no actionable reason, and the case it would
 * serve — the provider being unreachable — is already a halt whose notice says
 * the records were not read and nothing was created.
 *
 * ## `answer` is ONE event, not a token stream, and that is forced twice over
 *
 * 1. **The egress scan cannot un-send bytes.** `scanEgress` runs on the
 *    composed answer; a secret already streamed to a client is out, whatever
 *    the verdict says afterwards. An incremental scan does not rescue it
 *    either — a credential can straddle any chunk boundary, and the earlier
 *    chunk has already gone.
 * 2. **`completeWithRouting` returns a `Promise<AiCompletion>`**, not a
 *    stream. So the answer is buffered by the helper this must go through
 *    regardless.
 *
 * Both point the same way, which is why the typing effect is not worth
 * re-litigating. What the stream still buys is everything around the answer:
 * `thinking` and `tool_call` make the wait legible, and a refusal or halt
 * arrives as an event with a reason rather than as a dead socket.
 *
 * ## `code` + `message`, uniformly
 *
 * The ported union gave `refusal` a `reason` and `halt` an `outcome` plus a
 * `notice` — the same two facts under four names. Both now carry `code` (for
 * BRANCHING) and `message` (the sentence, already in the reader's language per
 * #1677's ruling). A client that renders `error.message` renders these with no
 * new path, and the discriminators survive: `type` separates the kinds, `code`
 * names the cause.
 */
import type { HaltCode, RefusalCode } from '../safety/refusal-codes';

export type AssistantStreamEvent =
    | { readonly type: 'thinking' }
    | { readonly type: 'tool_call'; readonly name: string }
    | {
          readonly type: 'tool_result';
          readonly name: string;
          readonly ok: boolean;
          readonly truncated: boolean;
      }
    | {
          readonly type: 'answer';
          readonly text: string;
          /**
           * Server-BUILT, never model-emitted — see `links.ts`. Concrete and
           * tenant-relative. Absent rather than empty when there are none,
           * so a client need not distinguish the two.
           */
          readonly links?: readonly { readonly route: string; readonly label: string }[];
          /**
           * A PREPARED draft for the person to confirm — phase 2. No id,
           * nothing written. The client prefills the real form with it and the
           * person submits that form, so every policy and audit write on the
           * normal create path applies unchanged.
           */
          readonly proposal?: { readonly kind: string; readonly draft: Record<string, unknown> };
      }
    | { readonly type: 'refusal'; readonly code: RefusalCode; readonly message: string }
    | { readonly type: 'halt'; readonly code: HaltCode; readonly message: string }
    | { readonly type: 'done'; readonly truncatedAny: boolean };

/**
 * `data: <json>\n\n`, with no `event:` field.
 *
 * The client switches on the payload's own `type`, so adding an event later
 * does not require it to subscribe to a named channel it does not yet know
 * about. Same wire format as `notifications/stream`, which both products
 * already share.
 */
export function sseFormat(event: AssistantStreamEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}

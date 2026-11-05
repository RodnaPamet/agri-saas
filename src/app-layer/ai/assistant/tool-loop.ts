/**
 * The bounded tool loop — #2578.
 *
 * ## Both budgets bound the TOOL phase, never the answer
 *
 * This is the design decision the rest follows from. A `halt` means "the
 * answer above is real and INCOMPLETE", so a halt with nothing above it is the
 * `ASSISTANT_PROVIDER_UNAVAILABLE` problem again — telling someone their
 * non-existent answer is partial.
 *
 * So when a budget runs out, the loop stops calling TOOLS and makes one final
 * model call with no tools, letting the model answer from what it already
 * gathered. There is then always an answer for the halt to be incomplete
 * about, and the copy is accurate without a second exception.
 *
 * ## One halt per turn, by precedence
 *
 * TIME > TOOL_CALLS > TRUNCATED > PARTIAL. Two halts would ask a person to
 * reconcile two reasons for one stop. Truncation is additionally always
 * reported on `done.truncatedAny`, so it is never silent even when a
 * higher-precedence halt wins — and `done.partialAny` is there for the same
 * reason since #2639.
 *
 * PARTIAL is last because TRUNCATED is the narrower statement about THIS turn:
 * the model did not see all of what was gathered, where partial data would be
 * partial however much of it was read.
 *
 * ## A failed tool is reported to the MODEL, not to the stream as an ending
 *
 * A hallucinated name, malformed arguments or a policy refusal come back as
 * `ok: false` and go into the conversation. The model can then say it cannot
 * see that data — which is a better answer than a dead socket, and is why
 * `runTool` never throws.
 */
import { endingEvent } from './endings';
import { mergeLinks, type AssistantLink } from './links';
import type { AssistantProposal } from './propose';
import { runTool, toolDefs } from './tools';
import { sseFormat, type AssistantStreamEvent } from './stream-events';
import type { HaltCode } from '../safety/refusal-codes';
import type { AiCompletion, AiMessage } from '../provider/types';
import type { RequestContext } from '@/app-layer/types';
import { logger } from '@/lib/observability';

/** At most four tool calls for one question. */
export const MAX_TOOL_CALLS = 4;
/** Wall-clock bound on the TOOL phase. */
export const TOOL_PHASE_BUDGET_MS = 25_000;

export interface ToolLoopResult {
    /** The model's final text, for the caller to put through the choke point. */
    readonly text: string;
    /**
     * Links built by the SERVER from the rows the tools returned — see
     * `links.ts` for why the model does not author these.
     */
    readonly links: readonly AssistantLink[];
    /**
     * The LAST prepared draft of the turn, if any. Last rather than all: a
     * person confirms one form, and offering two would ask them to choose
     * between drafts the assistant could not decide between itself.
     */
    readonly proposal: AssistantProposal | null;
    readonly truncatedAny: boolean;
    /** Any tool reported its own result INCOMPLETE — #2639. */
    readonly partialAny: boolean;
    /** The halt to report after the answer, if the tool phase was cut short. */
    readonly halt: HaltCode | null;
    readonly toolCallsMade: number;
    /**
     * Where the time went (#2670). Returned as well as logged, so a test can
     * assert the stages add up without reading a log line — and so a future
     * caller can report it rather than re-deriving it.
     */
    readonly timing: {
        readonly totalMs: number;
        /** Summed across every provider call in the turn, including the final one. */
        readonly providerMs: number;
        readonly providerCalls: number;
        /**
         * Of `providerMs`, the part spent PICKING tools (#2670 item 2) — the
         * figure that should fall when that round moves to a cheaper model.
         * `providerMs - toolSelectMs` is the answer call.
         */
        readonly toolSelectMs: number;
        /** Wall-clock of the tool rounds, which is now the SLOWEST tool per round. */
        readonly toolPhaseMs: number;
    };
}

export interface ToolLoopDeps {
    readonly ctx: RequestContext;
    readonly complete: (
        messages: AiMessage[],
        tools: ReturnType<typeof toolDefs> | undefined,
    ) => Promise<AiCompletion>;
    /**
     * The call that PICKS tools, if it should differ from the one that writes
     * the answer (#2670 item 2).
     *
     * One answered question is two provider calls with very different jobs:
     * this one emits a tool call (~160 completion tokens), `complete` does the
     * reasoning (~500). The production route points this at
     * `copilot-tool-select` — same entitlement tier, cheaper model.
     *
     * OPTIONAL, falling back to `complete`, which is the pre-#2670 behaviour.
     * That keeps the change additive for the ~20 tests that drive this loop
     * with one function, and the fallback is the slow-but-correct direction
     * rather than a silent downgrade.
     */
    readonly completeForToolSelection?: (
        messages: AiMessage[],
        tools: ReturnType<typeof toolDefs> | undefined,
    ) => Promise<AiCompletion>;
    readonly send: (chunk: string) => void;
    /** Injected so a test can drive the budget without waiting 25 seconds. */
    readonly now?: () => number;
}

export async function runToolLoop(
    deps: ToolLoopDeps,
    initial: AiMessage[],
): Promise<ToolLoopResult> {
    const now = deps.now ?? (() => Date.now());
    const started = now();
    const emit = (e: AssistantStreamEvent): void => deps.send(sseFormat(e));

    const messages: AiMessage[] = [...initial];
    let truncatedAny = false;
    let partialAny = false;
    let toolCallsMade = 0;
    const linkGroups: AssistantLink[][] = [];
    let proposal: AssistantProposal | null = null;
    let halt: HaltCode | null = null;
    let text: string | null = null;
    /*
     * Per-stage timings (#2670), because no figure existed.
     *
     * `AiUsageEvent` has no latency column and `recordAiCompletion` computes a
     * `latencyMs` it never stores, so until now any claim about where an
     * answer's 20–30s goes was a reading of the source. That matters more than
     * it sounds: the first optimisation would otherwise be credited with
     * whatever the next question happened to cost.
     *
     * Three accumulators, because they are the three things that can be
     * changed independently — the model calls that pick tools, the tool reads
     * themselves, and the final call that writes the answer.
     */
    let providerMs = 0;
    let toolPhaseMs = 0;
    let providerCalls = 0;
    /*
     * Split out of `providerMs` once the picking rounds moved to their own
     * model (#2670 item 2), because the whole point of that change is a figure
     * that moves. `providerMs` still totals every call, so the two stay
     * reconcilable: `providerMs - toolSelectMs` is the answer call.
     */
    let toolSelectMs = 0;

    for (let round = 0; round < MAX_TOOL_CALLS; round++) {
        if (now() - started > TOOL_PHASE_BUDGET_MS) {
            halt = 'ASSISTANT_TIME_BUDGET';
            break;
        }
        const callStarted = now();
        // The PICKER, not the answerer — see `completeForToolSelection`.
        const pick = deps.completeForToolSelection ?? deps.complete;
        const completion = await pick(messages, toolDefs());
        const pickMs = now() - callStarted;
        providerMs += pickMs;
        toolSelectMs += pickMs;
        providerCalls += 1;
        const calls = completion.toolCalls ?? [];
        if (calls.length === 0) {
            text = completion.text ?? '';
            break;
        }
        // The ASSISTANT turn that made these calls, pushed BEFORE their
        // results. Without it the history is `[question] [tool_result]`, and
        // Anthropic refuses a `tool_result` whose `tool_use` is absent from
        // the previous message — which is every question, for every model,
        // because the request is malformed before a model sees it.
        //
        // It must carry ALL the calls from this round, not one per result:
        // they belong to one assistant turn, and splitting them would put a
        // `tool_result` after a message holding a different call's `tool_use`.
        messages.push({
            role: 'assistant',
            content: completion.text ?? '',
            toolCalls: calls,
        } as AiMessage);
        /*
         * One round's tools run in PARALLEL, and the fold is sequential (#2670).
         *
         * These are independent READS — each goes through the usecase that
         * guards its own subject — so there is no ordering dependency between
         * them. Running them one at a time made a two-tool question pay both
         * latencies, which is the shape the owner actually asked about.
         *
         * `Promise.all` is safe here for a specific reason rather than a
         * hopeful one: `runTool` catches everything, including a usecase's
         * policy refusal, and returns `{ ok: false }` — it never throws. So no
         * rejection can discard a sibling's completed result. If that contract
         * ever changes, this needs `allSettled` and a decision about what a
         * thrown tool means for the round.
         *
         * ## What must NOT change, and how each is held
         *
         * The BUDGET still bounds the round, so the admitted set is decided
         * BEFORE anything runs rather than by breaking mid-loop. Admitting
         * fewer calls than the model asked for is the same halt it was.
         *
         * The FOLD runs in the model's original call order, not completion
         * order, so every derived value is bit-identical to the sequential
         * version: `proposal` is still last-call-wins, `linkGroups` still
         * merge in call order, and the `tool` messages are still pushed in the
         * order the assistant turn listed them. Only the WAITING is parallel.
         *
         * `tool_call` events are all emitted up front — still before any
         * result, which is what justifies the wait to the person watching, and
         * better for the phone than before: it can name every tool it is
         * reading at once rather than one at a time.
         */
        const room = Math.max(0, MAX_TOOL_CALLS - toolCallsMade);
        const admitted = calls.slice(0, room);
        const overBudget = admitted.length < calls.length;
        toolCallsMade += admitted.length;

        for (const call of admitted) {
            // Named BEFORE the result arrives. That is what justifies the wait
            // to the person watching; a bare spinner does not.
            emit({ type: 'tool_call', name: call.name });
        }

        const roundStarted = now();
        const outcomes = await Promise.all(
            admitted.map((call) => runTool(deps.ctx, call.name, call.arguments ?? '')),
        );
        toolPhaseMs += now() - roundStarted;

        for (let i = 0; i < admitted.length; i++) {
            const call = admitted[i] as (typeof admitted)[number];
            const outcome = outcomes[i] as (typeof outcomes)[number];
            if (outcome.truncated) truncatedAny = true;
            if (outcome.partial) partialAny = true;
            if (outcome.links.length > 0) linkGroups.push([...outcome.links]);
            if (outcome.proposal !== null) proposal = outcome.proposal;
            emit({
                type: 'tool_result',
                name: call.name,
                ok: outcome.ok,
                truncated: outcome.truncated,
            });
            messages.push({
                role: 'tool',
                content: outcome.content,
                toolCallId: call.id,
            } as AiMessage);
        }

        if (overBudget) {
            halt = 'ASSISTANT_TOOL_BUDGET';
            break;
        }
        if (halt !== null) break;
        if (toolCallsMade >= MAX_TOOL_CALLS) {
            halt = 'ASSISTANT_TOOL_BUDGET';
            break;
        }
    }

    if (text === null) {
        // The tool phase was cut short, or the model kept asking for tools
        // until the cap. One final call with NO tools, so the model answers
        // from what it has and the halt has an answer to be incomplete about.
        if (halt === null) halt = 'ASSISTANT_TOOL_BUDGET';
        const finalStarted = now();
        const final = await deps.complete(messages, undefined);
        providerMs += now() - finalStarted;
        providerCalls += 1;
        text = final.text ?? '';
    }

    // Precedence, so a turn carries at most one halt. Truncation is the
    // weakest and is reported on `done` regardless, so it is never silent.
    if (halt === null && truncatedAny) halt = 'ASSISTANT_TRUNCATED_RESULT';
    // LAST in precedence, after TRUNCATED — #2639.
    //
    // When a result was both truncated and partial, "the model did not see all
    // of what was gathered" is the more specific statement about this turn:
    // truncation is about THIS answer, while partial data would be partial
    // however much of it the model read. Either sentence tells the person the
    // answer is incomplete, so the order decides only which reason they get,
    // and the narrower one is more useful.
    if (halt === null && partialAny) halt = 'ASSISTANT_PARTIAL_DATA';

    const totalMs = now() - started;
    /*
     * ONE line per answered question, so a change to any stage is judgeable
     * from the production log rather than from a stopwatch on somebody's
     * phone. `otherMs` is the residual — route checks, the prompt build, the
     * egress scan, the emits — and it is reported rather than itemised so the
     * three figures above stay the ones that add up.
     */
    logger.info('assistant.stage_timing', {
        component: 'assistant',
        tenantId: deps.ctx.tenantId,
        totalMs,
        providerMs,
        providerCalls,
        toolSelectMs,
        answerMs: Math.max(0, providerMs - toolSelectMs),
        toolPhaseMs,
        otherMs: Math.max(0, totalMs - providerMs - toolPhaseMs),
        toolCallsMade,
        halt,
    });

    return {
        text,
        links: mergeLinks(linkGroups),
        proposal,
        truncatedAny,
        partialAny,
        halt,
        toolCallsMade,
        timing: { totalMs, providerMs, providerCalls, toolSelectMs, toolPhaseMs },
    };
}

/** Emit the halt, if there is one. Separate so the caller controls ordering. */
export async function emitHalt(
    send: (chunk: string) => void,
    halt: HaltCode | null,
): Promise<void> {
    if (halt === null) return;
    send(sseFormat(await endingEvent(halt)));
}

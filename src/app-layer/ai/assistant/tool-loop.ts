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
 * TIME > TOOL_CALLS > TRUNCATED. Two halts would ask a person to reconcile
 * two reasons for one stop. Truncation is additionally always reported on
 * `done.truncatedAny`, so it is never silent even when a higher-precedence
 * halt wins.
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
import { runTool, toolDefs } from './tools';
import { sseFormat, type AssistantStreamEvent } from './stream-events';
import type { HaltCode } from '../safety/refusal-codes';
import type { AiCompletion, AiMessage } from '../provider/types';
import type { RequestContext } from '@/app-layer/types';

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
    readonly truncatedAny: boolean;
    /** The halt to report after the answer, if the tool phase was cut short. */
    readonly halt: HaltCode | null;
    readonly toolCallsMade: number;
}

export interface ToolLoopDeps {
    readonly ctx: RequestContext;
    readonly complete: (
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
    let toolCallsMade = 0;
    const linkGroups: AssistantLink[][] = [];
    let halt: HaltCode | null = null;
    let text: string | null = null;

    for (let round = 0; round < MAX_TOOL_CALLS; round++) {
        if (now() - started > TOOL_PHASE_BUDGET_MS) {
            halt = 'ASSISTANT_TIME_BUDGET';
            break;
        }
        const completion = await deps.complete(messages, toolDefs());
        const calls = completion.toolCalls ?? [];
        if (calls.length === 0) {
            text = completion.text ?? '';
            break;
        }
        for (const call of calls) {
            if (toolCallsMade >= MAX_TOOL_CALLS) {
                halt = 'ASSISTANT_TOOL_BUDGET';
                break;
            }
            toolCallsMade++;
            // Named BEFORE the result arrives. That is what justifies the wait
            // to the person watching; a bare spinner does not.
            emit({ type: 'tool_call', name: call.name });
            const outcome = await runTool(deps.ctx, call.name, call.arguments ?? '');
            if (outcome.truncated) truncatedAny = true;
            if (outcome.links.length > 0) linkGroups.push([...outcome.links]);
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
        const final = await deps.complete(messages, undefined);
        text = final.text ?? '';
    }

    // Precedence, so a turn carries at most one halt. Truncation is the
    // weakest and is reported on `done` regardless, so it is never silent.
    if (halt === null && truncatedAny) halt = 'ASSISTANT_TRUNCATED_RESULT';

    return { text, links: mergeLinks(linkGroups), truncatedAny, halt, toolCallsMade };
}

/** Emit the halt, if there is one. Separate so the caller controls ordering. */
export async function emitHalt(
    send: (chunk: string) => void,
    halt: HaltCode | null,
): Promise<void> {
    if (halt === null) return;
    send(sseFormat(await endingEvent(halt)));
}

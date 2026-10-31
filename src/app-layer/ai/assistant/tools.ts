/**
 * The assistant's tools — a CLOSED set, each reading through a usecase that
 * enforces its own permission — #2578.
 *
 * ## This is where the permission question actually lives
 *
 * `api-permission-coverage` carries a carve-out for the stream route, and its
 * reason is that a single route-level permission would have to be the UNION of
 * every tool's — too WIDE, granting through one gate what four gates refuse
 * separately. That reason is only honest if the per-tool checks exist, so the
 * carve-out carries a revisit trigger saying this PR must touch it.
 *
 * Each tool's `run` calls a USECASE, never a repository. The usecase asserts
 * its own policy — `listTasks` opens with `assertCanReadTasks(ctx)` — so a
 * READER who may not see tasks gets a refusal from the same code path the
 * HTTP route would have used. `tests/guards/assistant-tools-go-through-usecases.test.ts`
 * holds that: a tool reaching a repository directly would bypass the policy
 * and is what the guard refuses.
 *
 * ## Arguments come from the MODEL, so they are validated like a request body
 *
 * Every tool declares a Zod schema and `.strict()`. A hallucinated argument is
 * a refused tool call, not a query. Two narrower decisions inside that:
 *
 * - **No free-text search parameter.** `TaskFilters.q` exists and is
 *   deliberately not exposed. It is parameterised so there is no injection,
 *   but handing a model a free-text channel into a database query buys
 *   little — "what is overdue" needs `due`, not prose — and it is the one
 *   argument whose content cannot be bounded by a charset. Same reasoning as
 *   the page context excluding the toolbar's search term.
 * - **No encrypted free-text columns in the result.** `Task.description` and
 *   `Task.resolution` are in `ENCRYPTED_FIELDS`; the extension decrypts them
 *   on read, so a projection that names them would hand the model the farm's
 *   longest and most sensitive free text to answer a list-level question. A
 *   later single-task tool can fetch one deliberately.
 */
import { z } from 'zod';

import { listTasks } from '@/app-layer/usecases/task';
import type { RequestContext } from '@/app-layer/types';
import type { AiToolDef } from '@/app-layer/ai/provider/types';

/** How much of one tool result may reach the model. */
export const TOOL_RESULT_MAX_CHARS = 4000;

export interface ToolOutcome {
    readonly ok: boolean;
    /** Serialised for the model. Already truncated if it had to be. */
    readonly content: string;
    readonly truncated: boolean;
}

interface AssistantTool {
    readonly def: AiToolDef;
    readonly args: z.ZodType<unknown>;
    readonly run: (ctx: RequestContext, args: unknown) => Promise<unknown>;
}

const ListFarmTasksArgs = z
    .object({
        status: z
            .array(z.enum(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED']))
            .max(5)
            .optional(),
        due: z.enum(['overdue', 'next7d']).optional(),
    })
    .strict();

export const ASSISTANT_TOOLS: Readonly<Record<string, AssistantTool>> = {
    list_farm_tasks: {
        def: {
            name: 'list_farm_tasks',
            description:
                "The farm's own task list. Use it to answer what is open, overdue or due soon. "
                + 'Returns at most 20 tasks, newest first, without their long descriptions.',
            parameters: {
                type: 'object',
                properties: {
                    status: {
                        type: 'array',
                        items: {
                            type: 'string',
                            enum: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'],
                        },
                        description: 'Narrow to these statuses.',
                    },
                    due: {
                        type: 'string',
                        enum: ['overdue', 'next7d'],
                        description: 'Narrow to overdue tasks, or those due within seven days.',
                    },
                },
                additionalProperties: false,
            },
        },
        args: ListFarmTasksArgs,
        run: async (ctx, args) => {
            const a = ListFarmTasksArgs.parse(args);
            // The USECASE, which opens with `assertCanReadTasks(ctx)`. A
            // repository call here would read the farm's tasks for a role the
            // policy refuses.
            const rows = await listTasks(ctx, a, { take: 20 });
            // A projection, and the omissions are the decision — see the
            // header on `description`/`resolution`.
            return (rows as Array<Record<string, unknown>>).map((r) => ({
                id: r.id,
                title: r.title,
                status: r.status,
                priority: r.priority,
                dueDate: r.dueDate,
            }));
        },
    },
};

/** The definitions handed to the model. */
export function toolDefs(): AiToolDef[] {
    return Object.values(ASSISTANT_TOOLS).map((t) => t.def);
}

/**
 * Execute one tool call.
 *
 * Never throws. A hallucinated tool name, malformed arguments or a refusal
 * from the usecase's own policy all come back as `ok: false` with a short
 * reason the model can act on — because the alternative is a thrown error
 * ending a stream that has already sent a 200, and the model cannot learn
 * from a dead socket.
 */
export async function runTool(
    ctx: RequestContext,
    name: string,
    rawArgs: string,
): Promise<ToolOutcome> {
    const tool = ASSISTANT_TOOLS[name];
    if (!tool) {
        return { ok: false, content: `No such tool: ${name}`, truncated: false };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArgs === '' ? '{}' : rawArgs);
    } catch {
        return { ok: false, content: 'Arguments were not valid JSON.', truncated: false };
    }
    const check = tool.args.safeParse(parsed);
    if (!check.success) {
        return {
            ok: false,
            content: `Arguments rejected: ${check.error.issues[0]?.message ?? 'invalid'}`,
            truncated: false,
        };
    }
    try {
        const result = await tool.run(ctx, check.data);
        const full = JSON.stringify(result);
        if (full.length <= TOOL_RESULT_MAX_CHARS) {
            return { ok: true, content: full, truncated: false };
        }
        // Truncated rather than dropped: a partial list is useful and the
        // `truncated` flag is what makes the answer's incompleteness
        // reportable as `ASSISTANT_TRUNCATED_RESULT` instead of silent.
        return {
            ok: true,
            content: full.slice(0, TOOL_RESULT_MAX_CHARS),
            truncated: true,
        };
    } catch (err) {
        // Includes the usecase's own policy refusal. Reported to the model as
        // a failed tool rather than raised, so it can say it cannot see that
        // data instead of the turn dying.
        return {
            ok: false,
            content: err instanceof Error ? err.message.slice(0, 200) : 'Tool failed.',
            truncated: false,
        };
    }
}

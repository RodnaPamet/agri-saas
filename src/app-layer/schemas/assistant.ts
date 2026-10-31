/**
 * The assistant's page context — #2578.
 *
 * ## This is a customer-controlled field, so it is an injection surface
 *
 * It arrives in the request body, which means it is written by whatever is
 * talking to the API rather than by the product. Two things contain it, and
 * neither is "tell the model to ignore instructions" — a prompt cannot be the
 * defence for what reaches the prompt:
 *
 *   1. SHAPE. Identifiers, not prose: keys and values bounded in length AND
 *      charset, collections capped in COUNT, and `.strict()` so an unknown
 *      field is a 400 rather than a free-text channel.
 *   2. The existing guard. The rendered block still goes through
 *      `sanitize-untrusted.ts` on the same path as the question. Charset
 *      limits narrow what can be SAID; they do not make "disregard the above"
 *      unsayable, because that phrase is only letters and spaces.
 *
 * ## `route` is a TEMPLATE, and membership is exact
 *
 * Not a concrete URL. The context names the SCREEN, never an instance of one,
 * so a route cannot carry a tenant slug or a record id at all and validation
 * is set membership against the generated list rather than a parse. Ids travel
 * in `selectedIds`, where they are counted and length-bounded.
 *
 * The list is GENERATED (`src/lib/assistant/generated/page-routes.ts`) because
 * `src/app` is not in the production image — see that file's header.
 */
import { z } from 'zod';

import { PAGE_ROUTE_TEMPLATE_SET } from '@/lib/assistant/generated/page-routes';

/**
 * A facet key, e.g. `status`, `cropType`, `dueBefore`.
 *
 * Identifier-shaped on purpose. The filter system's keys are code-authored —
 * they come from a page's filter definitions, never from a person typing.
 */
export const FILTER_KEY = z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_]{0,32}$/, 'filter key must be an identifier');

/**
 * A facet value.
 *
 * Commas are admitted deliberately: `filterStateToUrlParams` comma-joins a
 * `multiple: true` facet into ONE value (`status=DRAFT,ACTIVE`), so rejecting
 * them would make every multi-select facet unrepresentable. `.`, `:` and `-`
 * admit dates and ranges. No spaces, and nothing outside ASCII.
 */
export const FILTER_VALUE = z
    .string()
    .regex(/^[A-Za-z0-9_,:.-]{1,64}$/, 'filter value must be identifier-shaped, not prose');

/** A record id as this codebase mints them — cuid/uuid shaped. */
export const RECORD_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not a record id');

/**
 * Caps. Each is a real bound from the product rather than a round number:
 *
 *   - `MAX_FILTERS` — the widest filter definition list in `src/app` is well
 *     under this; a request carrying more is not a screen state.
 *   - `MAX_SELECTED_IDS` — `JOURNAL_PAGE_SIZE` is 50, so a person who selects
 *     every row of a page selects 50. Fewer would refuse a legitimate
 *     select-all; more would admit a list no screen can produce.
 */
export const MAX_FILTERS = 16;
export const MAX_SELECTED_IDS = 50;

export const PageContextSchema = z
    .object({
        route: z.string().min(1).max(200).refine((r) => PAGE_ROUTE_TEMPLATE_SET.has(r), {
            message: 'route is not a page template this app serves',
        }),
        entity: z
            .string()
            .regex(/^[a-z][a-z0-9-]{0,40}$/, 'entity must be a kebab identifier')
            .optional(),
        filters: z
            .record(FILTER_KEY, FILTER_VALUE)
            .refine((f) => Object.keys(f).length <= MAX_FILTERS, {
                message: `at most ${MAX_FILTERS} filters`,
            })
            .optional(),
        selectedIds: z.array(RECORD_ID).max(MAX_SELECTED_IDS).optional(),
    })
    .strict();

export type PageContext = z.infer<typeof PageContextSchema>;

/**
 * NOT a field here, and the omission is the decision: the free-text SEARCH
 * term.
 *
 * #2578's own body argued the shape was safe because "a filter value in this
 * product is `missing`, `open`, `high` — it has never needed a sentence". That
 * is true of the facets and false of the toolbar: passing `searchPlaceholder`
 * to `FilterToolbar` turns the filter popover's top input into a LIVE content
 * search, so a real screen state can include a sentence — in Bulgarian, with
 * whatever a person typed.
 *
 * `FILTER_VALUE` would reject it (no spaces, ASCII only), which is correct but
 * would silently drop part of the screen state rather than represent it. So it
 * is excluded by construction and NOT smuggled in as a filter. Giving the
 * assistant the search term is a separate decision with its own injection
 * review, because it is the one piece of page context that is prose by design.
 */
export const PAGE_CONTEXT_EXCLUDES_FREE_TEXT_SEARCH = true;

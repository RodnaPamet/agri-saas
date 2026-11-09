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
 * The ONE route whose selected id is rendered into the screen context rather
 * than collapsed to a count — owner ruling 2026-11-09.
 *
 * `renderPageContext` shows every other field verbatim and reduces
 * `selectedIds` to `selected: N row(s)`, which keeps tenant row identifiers
 * out of the text sent to the model provider. That default stands; this is a
 * single, deliberate exception.
 *
 * WHY HERE: on a parcel's history screen the assistant could not reach
 * `parcel_risk_trend` for the parcel on screen, because the only other source
 * of a parcel id is `analyze_block_risk`, which names ONLY parcels needing
 * attention. So a HEALTHY parcel could not be asked about at all. The owner
 * was told the id reaches the provider, and that it is a random code carrying
 * no name and no location, and chose to share it on this screen.
 *
 * WHY IT IS A SMALL DECISION: the id is not a capability. Every read behind
 * these tools filters by `tenantId` — `ParcelRepository.storedIndexReadings`
 * uses `where: { id, tenantId: ctx.tenantId, deletedAt: null }` and a miss
 * becomes a contentless `PARCEL_NOT_FOUND` — so a foreign or invented id
 * discloses nothing. If that ever stops being true, this exception has to be
 * re-argued, not merely re-scoped.
 *
 * It is matched against `PAGE_ROUTE_TEMPLATE_SET`, which is GENERATED, so a
 * route rename would silently stop matching and switch the feature off with
 * nothing failing. `tests/unit/ai/assistant-stream-route.test.ts` asserts
 * membership for that reason.
 */
export const PARCEL_DETAIL_ROUTE = '/t/[tenantSlug]/parcels/[parcelId]';

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

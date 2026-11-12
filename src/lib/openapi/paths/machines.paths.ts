/**
 * Machine tracking — the READ surface (#2948 stage 3).
 *
 * Its own module, and the reason is the same one `documents.paths.ts` gives
 * about itself: this is not an extension of the asset register. A position
 * trace is PERSONAL DATA by linkage — `MachinePosition → Asset → TaskAsset →
 * Task.assigneeUserId` names the person who was at those coordinates, minute
 * by minute — so filing it under assets would put employee location data
 * beside an equipment list, and the two being easy to confuse is the risk.
 *
 * Three operations, all OWNER + ADMIN. The MECHANISATOR reads live under
 * `/farm-tasks` and are documented with that domain, because they authorise on
 * "is this your open task" rather than on a permission flag.
 *
 * Two things in these schemas are contract rather than formatting, and both
 * have already cost a client a bug: coordinates are STRINGS, and `truncated`
 * is not `simplified`.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { codedErrorResponses, op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose machines these are.' }),
});

const MachineParams = TenantParams.extend({
    assetId: z.string().openapi({
        description:
            'The machine, as an `Asset` id. A machine that does not exist, belongs to another farm, or is not a locatable type answers the SAME 404 — distinguishing them would make this an enumerator for the asset register.',
    }),
});

const DayQuery = z.object({
    date: z.string().openapi({
        format: 'date',
        description:
            'A Europe/Sofia calendar day, `YYYY-MM-DD`. REQUIRED, and deliberately not defaulted to today: a default would make a missing or malformed parameter answer confidently about a different day than the caller meant, on an endpoint whose whole subject is which day. A date that does not exist (`2026-02-31`) is a 400 rather than rolling forward into March.',
    }),
});

const PositionSourceSchema = z
    .object({
        kind: z.enum(['TRACKER', 'TELEMATICS', 'SIMULATED']).openapi({
            description:
                'Where this machine reports through. `SIMULATED` is the demo simulator and is marked on every position, not merely on the asset — so simulated work can never be mistaken for real.',
        }),
        provider: z
            .enum(['JOHN_DEERE', 'CNH', 'CLAAS', 'AGCO'])
            .nullable()
            .openapi({
                description:
                    'The manufacturer platform, set only for TELEMATICS — a retrofit tracker has no vendor. Grouped by PLATFORM, not brand: Case IH and New Holland are both CNH, Fendt and Massey Ferguson both AGCO.',
            }),
    })
    .openapi('MachinePositionSourceView');

const PositionSchema = z
    .object({
        lat: z.string().openapi({
            description:
                'WGS84 latitude as a DECIMAL STRING, not a number — e.g. `"43.4120000"`. The column is `Decimal(10,7)` because the worked-parcel derivation compares and aggregates coordinates, and binary floating point makes two equal coordinates occasionally unequal; a `Number()` at this boundary throws that guarantee away. Trailing zeros are significant of nothing and are simply what the stored decimal renders as. Decode to a decimal or string type.',
        }),
        lon: z.string().openapi({ description: 'WGS84 longitude, as a decimal string. See `lat`.' }),
        recordedAt: z.string().datetime().openapi({
            description:
                'When the DEVICE recorded it, not when we received it — a tracker buffers while out of GSM coverage and then replays, so arrival order is not chronological order. ISO 8601 with a `Z` offset.',
        }),
        speedKph: z.number().nullable().openapi({
            description:
                'A display scalar, so a NUMBER rather than a string: nothing compares it for equality or sums it into an identity. Null when the device does not report it.',
        }),
        ignition: z.boolean().nullable().openapi({
            description:
                'Null when the install does not wire the ignition input — which is deliberately not `false`, since that would claim the engine is off.',
        }),
        moving: z.boolean().openapi({
            description:
                'SERVER-DERIVED from `speedKph` against a 1.0 km/h floor. Not `speedKph > 0`: a receiver at a standstill reports a small nonzero speed as its position wanders inside its own error circle, so a zero threshold renders every parked machine as moving. Not derived from `ignition` either — an idling tractor has the engine on and is not moving, which is the exact case a driver looking for their machine cares about. An unknown speed yields `false`, because absence of evidence is not evidence of movement.',
        }),
    })
    .openapi('MachinePositionView');

const MachineRowSchema = z
    .object({
        assetId: z.string(),
        name: z.string(),
        type: z
            .enum(['TRACTOR', 'HARVESTER', 'IMPLEMENT', 'VEHICLE', 'IRRIGATION'])
            .openapi({
                description:
                    'The locatable asset types. A narrowing of the machine register: TOOL and LIVESTOCK_EQUIPMENT are machine-shaped for a "what did you use today" picker and carry no position source.',
            }),
        positionSource: PositionSourceSchema.nullable().openapi({
            description:
                'CONFIGURATION. Null means nothing is connected — which is a DIFFERENT statement from `lastPosition: null`, meaning connected and never heard from. Those two fields carry three states between them, which is why there is no third field. When a machine has both a retrofit tracker and factory telematics, TELEMATICS wins: a singular field must pick, and picking by "whichever reported last" would make it flicker as data arrives.',
        }),
        lastPosition: PositionSchema.nullable().openapi({
            description:
                'LIVENESS. Staleness is the client’s judgement from `recordedAt` — the server does not decide how old is too old, because that depends on what the reader is doing.',
        }),
    })
    .openapi('MachineRow');

const MachineListSchema = z
    .object({ machines: z.array(MachineRowSchema) })
    .openapi('MachineList');

const TrackPointSchema = PositionSchema.omit({ moving: true }).openapi('MachineTrackPoint');

const TrackSchema = z
    .object({
        date: z.string().openapi({ format: 'date' }),
        points: z.array(TrackPointSchema).openapi({
            description:
                'Ordered by `recordedAt`, then by id so the order is TOTAL — two positions can share a device timestamp. SIMPLIFIED for display: a day at 30-second intervals is ~2,900 points and ~250 KB of JSON that no screen can resolve. There is no raw option.',
        }),
        truncated: z.boolean().openapi({
            description:
                'Rows were never READ — the per-day ceiling was exceeded. This is NOT `simplified`, and collapsing the two would let a partial day render as a complete one. A 30-second tracker writes ~2,880 points a day, so this is a malfunction bound rather than a pagination strategy.',
        }),
        retained: z.boolean().openapi({
            description:
                'False past the 30-day raw-position window, where the rows have been deleted by policy. Without this an empty `points` would mean both "the machine did not move" and "we no longer hold this day", and a farm looking at an old day would read a deliberate deletion as an idle machine. A FUTURE date reports `true`: it has nothing to retain, and saying otherwise would claim we discarded something that never existed.',
        }),
        simplified: z.boolean().openapi({
            description: 'True when the line was reduced — i.e. anything was dropped for display.',
        }),
        rawCount: z.number().int().openapi({
            description:
                'How many positions the simplifier was given, so a client can say how much was dropped rather than presenting a reduced line as the whole truth.',
        }),
        toleranceM: z.number().openapi({
            description:
                'The perpendicular tolerance actually achieved, in metres. It may EXCEED the one requested: the simplifier doubles its tolerance when a point ceiling is not met, and reports where it ended rather than where it aimed.',
        }),
    })
    .openapi('MachineTrack');

const WorkedParcelSchema = z
    .object({
        parcelId: z.string(),
        name: z.string(),
        minutesWorked: z.number().int(),
        areaHa: z.number().nullable().openapi({
            description:
                'A DERIVED area, which is why `confidence` sits beside it: presented as a measurement this is a number somebody will put in a subsidy return.',
        }),
        confidence: z.number().nullable().openapi({ description: '0..1.' }),
    })
    .openapi('WorkedParcelRow');

const WorkedSchema = z
    .object({
        date: z.string().openapi({ format: 'date' }),
        parcels: z.array(WorkedParcelSchema),
        retained: z.boolean().openapi({
            description:
                'Always true. This reads `WorkedParcel` and never raw positions, which is what lets it answer indefinitely while `/track` stops at the window — the point of aggregating rather than keeping: what the farm uses survives, the minute-by-minute movement of a person does not.',
        }),
        derivedAt: z.string().datetime().nullable().openapi({
            description:
                'When the nightly derivation last ran for this machine-day, or null for "has not run" — so «not computed yet» is distinguishable from a genuine day of no work. KNOWN LIMIT: this is read off the returned rows, and a day with no work has none, so "it ran and found nothing" currently also answers null. That is truthful today because the derivation does not exist yet; it needs a per-(machine, day) run marker, tracked on #2984, and the nightly job must land it in the same change.',
        }),
    })
    .openapi('MachineWorkedDay');


const TaskParams = TenantParams.extend({
    taskId: z.string().openapi({
        description:
            'The task. A task that does not exist, belongs to another farm, is assigned to somebody else, or is closed all answer the SAME 404 — telling them apart would disclose which task ids exist and whose they are.',
    }),
});

const TaskMachineSchema = z
    .object({
        assetId: z.string(),
        name: z.string(),
        type: z.enum(['TRACTOR', 'HARVESTER', 'IMPLEMENT', 'VEHICLE', 'IRRIGATION']),
        lastPosition: PositionSchema.nullable(),
        locatableCount: z.number().int().openapi({
            description:
                'How many locatable machines the task has, so a client can say "and one more" rather than presenting one of two as though it were the only one. A UI that shows one of N without saying so is how somebody walks to the wrong end of a field.',
        }),
    })
    .openapi('TaskMachine');

const TaskAssetSchema = z
    .object({
        assetId: z.string(),
        name: z.string(),
        type: z.enum(['TRACTOR', 'HARVESTER', 'IMPLEMENT', 'VEHICLE', 'IRRIGATION']),
        positionSource: PositionSourceSchema.nullable().openapi({
            description:
                'CONFIGURATION, and the key is ALWAYS present — null means nothing is connected. Clients read key presence, so omitting it for an unconfigured machine would be a different answer rather than a smaller payload.',
        }),
    })
    .openapi('TaskAsset');

const TaskAssetListSchema = z
    .object({ assets: z.array(TaskAssetSchema) })
    .openapi('TaskAssetList');

const TrackedMachinesSchema = z
    .object({
        machines: z
            .array(
                z
                    .object({
                        name: z.string(),
                        type: z.enum([
                            'TRACTOR',
                            'HARVESTER',
                            'IMPLEMENT',
                            'VEHICLE',
                            'IRRIGATION',
                        ]),
                    })
                    .openapi('TrackedMachineName'),
            )
            .openapi({
                description:
                    'NAME AND TYPE ONLY — no positions, no IMEI, no last-seen. This endpoint discharges a transparency duty rather than giving anybody a map, which is why it is readable by every role including the restricted machine-operator persona.',
            }),
        visibleTo: z
            .array(z.enum(['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'MECHANISATOR']))
            .openapi({
                description:
                    'The roles that can see machine POSITIONS, derived from the permission table rather than hardcoded in each client — so if the visibility rule is ever widened, every notice changes with it instead of one going quietly stale. A caller may read this notice and still not be allowed to see a position; that is the shape of a transparency duty.',
            }),
    })
    .openapi('TrackedMachines');

export function registerMachinePaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/machines',
        operationId: 'listMachines',
        summary: 'List the farm’s locatable machines with their last known position',
        description:
            'One call for the whole fleet, so a machine list is a single request rather than one per machine. OWNER + ADMIN only — a position trace is employee location data, not an asset attribute, so this is NOT readable by every member the way the asset register is. The machine-operator persona (MECHANISATOR) cannot reach this path at all and sees only the machine on its own open task. Carries a weak ETag.',
        tags: ['Machines'],
        params: TenantParams,
        success: { status: 200, description: 'The fleet.', schema: MachineListSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/machines/{assetId}/track',
        operationId: 'readMachineTrack',
        summary: 'One machine’s simplified track for one day',
        description:
            'A Europe/Sofia calendar day, simplified for display. Raw positions are deleted after 30 days by policy, and `retained` says so rather than returning a silently empty track.',
        tags: ['Machines'],
        params: MachineParams,
        query: DayQuery,
        success: { status: 200, description: 'The day’s track.', schema: TrackSchema },
        extraResponses: codedErrorResponses({
            400:
                'The `date` parameter is missing or malformed. '
                + '`DATE_REQUIRED` — absent, or not `YYYY-MM-DD`. It is deliberately not '
                + 'defaulted to today, because a default would answer confidently about a '
                + 'different day than the caller meant. '
                + '`DATE_INVALID` — well-shaped but not a real date, such as `2026-02-31`. '
                + 'Checked by round-tripping rather than by the pattern alone, since '
                + '`new Date("2026-02-31")` rolls forward into March instead of failing.',
            404:
                '`MACHINE_NOT_FOUND` — and it is the SAME refusal for a machine that does '
                + 'not exist, one belonging to another farm, and one whose asset type cannot '
                + 'carry a position source. Distinguishing them would make this endpoint an '
                + 'enumerator for the asset register.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/machines/{assetId}/worked',
        operationId: 'readMachineWorked',
        summary: 'One machine’s worked parcels for one day',
        description:
            'Reads the derived `WorkedParcel` rows and never raw positions, so it answers indefinitely. It does NOT derive on demand: a day is ~2,900 positions per machine, and a read that silently ran a geospatial aggregation would time out on the day somebody opened it for a ten-machine fleet. The nightly job owns the work; this reports whether it has happened.',
        tags: ['Machines'],
        params: MachineParams,
        query: DayQuery,
        success: { status: 200, description: 'The day’s worked parcels.', schema: WorkedSchema },
        extraResponses: codedErrorResponses({
            400:
                'The `date` parameter is missing or malformed. '
                + '`DATE_REQUIRED` — absent, or not `YYYY-MM-DD`. It is deliberately not '
                + 'defaulted to today, because a default would answer confidently about a '
                + 'different day than the caller meant. '
                + '`DATE_INVALID` — well-shaped but not a real date, such as `2026-02-31`. '
                + 'Checked by round-tripping rather than by the pattern alone, since '
                + '`new Date("2026-02-31")` rolls forward into March instead of failing.',
            404:
                '`MACHINE_NOT_FOUND` — and it is the SAME refusal for a machine that does '
                + 'not exist, one belonging to another farm, and one whose asset type cannot '
                + 'carry a position source. Distinguishing them would make this endpoint an '
                + 'enumerator for the asset register.',
        }),
    });

    // ── The MECHANISATOR reads ──────────────────────────────────────
    //
    // Under `/farm-tasks` and NOT `/machines`, which is a reachability
    // decision rather than a filing one: `isOperatorAllowedPath` admits
    // `farm-tasks` for the operator persona and admits no `machines` prefix at
    // all. They are documented HERE, with the machine operations, because the
    // subject is machines and a client looking for them should find them
    // together — the path and the subject genuinely differ.
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/farm-tasks/{taskId}/machine',
        operationId: 'readTaskMachine',
        summary: 'The machine on the caller’s own open task',
        description:
            'Authorises on ASSIGNMENT, not on a role: the caller must be the assignee of an OPEN task. An administrator who is not the assignee is refused here and uses `/machines` instead. Returns ONE machine, chosen by a total order — self-propelled before trailed, then earliest tracker install, then assetId — and discloses the collapse through `locatableCount`.',
        tags: ['Machines'],
        params: TaskParams,
        success: { status: 200, description: 'The task’s machine.', schema: TaskMachineSchema },
        extraResponses: codedErrorResponses({
            404:
                '`TASK_NOT_FOUND` — the same refusal for a task that does not exist, '
                + 'belongs to another farm, is assigned to somebody else, is closed, or '
                + 'has no locatable machine on it.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/farm-tasks/{taskId}/assets',
        operationId: 'listTaskAssets',
        summary: 'The locatable machines on a task, and whether each is findable',
        description:
            'A WIDER audience than the sibling `/machine` read — any member who can read the task, with no assignment check — and safe to be: it carries configuration and NO coordinates, so it answers which machines are findable without saying where any of them is.',
        tags: ['Machines'],
        params: TaskParams,
        success: { status: 200, description: 'The task’s locatable assets.', schema: TaskAssetListSchema },
        extraResponses: codedErrorResponses({
            404: '`TASK_NOT_FOUND` — no such task, or it belongs to another farm.',
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/farm-tasks/tracked-machines',
        operationId: 'listTrackedMachines',
        summary: 'The drivers’ notice — which machines on this farm are tracked',
        description:
            'Readable by EVERY role, the restricted machine-operator persona included, because it discharges a transparency duty. It answers for the whole tenant rather than one task: a driver is entitled to know which machines are tracked, not merely the one they happen to be on today. Lists only machines that actually have a tracker or a telematics link — listing an unconnected machine would overstate the surveillance.',
        tags: ['Machines'],
        params: TenantParams,
        success: { status: 200, description: 'Tracked machines, and who can see positions.', schema: TrackedMachinesSchema },
    });
}

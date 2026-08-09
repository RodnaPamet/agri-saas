import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import {
    getAutomationRule,
    updateAutomationRule,
    archiveAutomationRule,
    toggleAutomationRule,
} from '@/app-layer/usecases/automation-rules';
import { UpdateAutomationRuleSchema } from '@/app-layer/schemas/automation.schemas';

/**
 * Lightweight PATCH for the detail-sheet quick practices (Epic 2): an
 * enable/disable toggle and the priority stepper. Heavier reconfiguration
 * (trigger/action/filter) goes through PUT.
 */
const PatchAutomationRuleSchema = z
    .object({
        status: z.enum(['ENABLED', 'DISABLED']).optional(),
        priority: z.number().int().min(0).max(1000).optional(),
    })
    .refine((v) => v.status !== undefined || v.priority !== undefined, {
        message: 'Provide status or priority',
    });

type Ctx = { params: Promise<{ tenantSlug: string; id: string }> };

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const rule = await getAutomationRule(ctx, params.id);
    return jsonResponse(rule);
});

export const PUT = withApiErrorHandling(
    withValidatedBody(UpdateAutomationRuleSchema, async (req, { params: paramsPromise }: Ctx, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const rule = await updateAutomationRule(ctx, params.id, {
            name: body.name,
            description: body.description,
            triggerEvent: body.triggerEvent,
            triggerFilter: body.triggerFilter,
            actionType: body.actionType,
            actionConfig: body.actionConfig as never,
            status: body.status,
            priority: body.priority,
            slaWindowMinutes: body.slaWindowMinutes,
            slaReminderMinutes: body.slaReminderMinutes,
            slaBreachActionType: body.slaBreachActionType,
            slaBreachConfig: body.slaBreachConfig,
            nextRuleId: body.nextRuleId,
            nextRuleDelay: body.nextRuleDelay,
        });
        return jsonResponse(rule);
    }),
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(PatchAutomationRuleSchema, async (req, { params: paramsPromise }: Ctx, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        // Priority first (if present), then the status toggle, so a combined
        // PATCH lands both. The toggle is the authoritative return.
        let rule;
        if (body.priority !== undefined) {
            rule = await updateAutomationRule(ctx, params.id, { priority: body.priority });
        }
        if (body.status !== undefined) {
            rule = await toggleAutomationRule(ctx, params.id, body.status);
        }
        return jsonResponse(rule);
    }),
);

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const rule = await archiveAutomationRule(ctx, params.id);
    return jsonResponse(rule);
});

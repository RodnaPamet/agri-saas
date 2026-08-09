/**
 * Tracing Utilities — OpenTelemetry span helpers.
 *
 * Provides lightweight wrappers for creating spans around API requests,
 * usecases, and general operations. Uses the noop tracer when OTel
 * is not initialized, so this code is safe to call unconditionally.
 *
 * SAFETY: Never attach secrets, tokens, or raw payloads as span attributes.
 */

import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import type { RequestContext } from '@/app-layer/types';
import { getRequestContext } from './context';
import { recordAgOperationMetrics } from './metrics';

const TRACER_NAME = 'inflect-compliance';

/**
 * Get a named OTel tracer. Falls back to noop tracer if OTel is not initialized.
 */
export function getTracer(name: string = TRACER_NAME): Tracer {
    return trace.getTracer(name);
}

/**
 * Standard span attributes from RequestContext.
 */
function contextAttributes(ctx: RequestContext): Record<string, string> {
    return {
        'app.requestId': ctx.requestId,
        'app.tenantId': ctx.tenantId,
        'app.userId': ctx.userId,
        'app.role': ctx.role,
    };
}

/**
 * Wrap a usecase function in an OTel span with standard context attributes.
 *
 * @example
 *   export async function listPractices(ctx: RequestContext, filters?: Filters) {
 *       return traceUsecase('practice.list', ctx, () => {
 *           assertCanReadPractices(ctx);
 *           return runInTenantContext(ctx, (db) => PracticeRepository.list(db, ctx, filters));
 *       });
 *   }
 */
export async function traceUsecase<T>(
    name: string,
    ctx: RequestContext,
    fn: () => Promise<T>,
): Promise<T> {
    const tracer = getTracer();
    return tracer.startActiveSpan(`usecase.${name}`, async (span: Span) => {
        try {
            span.setAttributes(contextAttributes(ctx));
            const result = await fn();
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (error) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            if (error instanceof Error) {
                span.recordException(error);
            }
            throw error;
        } finally {
            span.end();
        }
    });
}

/**
 * Trace a CRITICAL ag field-workflow usecase: an OTel span (like
 * `traceUsecase`) PLUS a Prometheus duration histogram (`ag.operation.*`)
 * so the operation has both a trace AND an SLO. Span durations are not
 * exported as metrics, so the explicit histogram is what an alert like
 * "ag.field-operation p95 < 1s" queries.
 *
 * `operation` is a bounded dotted name (e.g.
 * `field-operation.markOperationParcel`) — never an id. Attach
 * ids/doseValue/status to the active span mid-body via
 * `trace.getActiveSpan()?.setAttributes(...)` (they're high-cardinality
 * and belong on the span, NOT on the metric labels).
 *
 * @example
 *   return traceAgUsecase('yield-record.createYieldRecord', ctx, async () => {
 *       const row = await runInTenantContext(ctx, (db) => …);
 *       trace.getActiveSpan()?.setAttributes({ 'ag.commodity': commodity ?? '' });
 *       return toDto(row);
 *   });
 */
export async function traceAgUsecase<T>(
    operation: string,
    ctx: RequestContext,
    fn: () => Promise<T>,
): Promise<T> {
    const tracer = getTracer();
    const startMs = performance.now();
    return tracer.startActiveSpan(`usecase.${operation}`, async (span: Span) => {
        span.setAttributes(contextAttributes(ctx));
        span.setAttribute('ag.operation', operation);
        try {
            const result = await fn();
            span.setStatus({ code: SpanStatusCode.OK });
            recordAgOperationMetrics({ operation, success: true, durationMs: Math.round(performance.now() - startMs) });
            return result;
        } catch (error) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            if (error instanceof Error) {
                span.recordException(error);
            }
            recordAgOperationMetrics({ operation, success: false, durationMs: Math.round(performance.now() - startMs) });
            throw error;
        } finally {
            span.end();
        }
    });
}

/**
 * General-purpose span wrapper for any operation.
 *
 * @example
 *   const pdf = await traceOperation('report.generatePdf', { reportId }, async () => {
 *       return generatePdfReport(data);
 *   });
 */
export async function traceOperation<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
): Promise<T> {
    const tracer = getTracer();

    // Auto-enrich with requestId from ALS context if available
    const reqCtx = getRequestContext();
    const enriched = {
        ...(reqCtx?.requestId && { 'app.requestId': reqCtx.requestId }),
        ...attributes,
    };

    return tracer.startActiveSpan(name, async (span: Span) => {
        try {
            span.setAttributes(enriched);
            const result = await fn();
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (error) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            if (error instanceof Error) {
                span.recordException(error);
            }
            throw error;
        } finally {
            span.end();
        }
    });
}

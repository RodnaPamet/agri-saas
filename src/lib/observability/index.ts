/**
 * Observability — barrel export.
 *
 * Public API:
 *   Context:  runWithRequestContext, getRequestContext, getRequestId, mergeRequestContext
 *   Logger:   logger, log, extractErrorMeta, createChildLogger, pinoInstance
 *   Tracing:  getTracer, traceUsecase, traceOperation, traceRepository
 *   Metrics:  recordRequestMetrics, recordRequestError
 *   Outcomes: recordRouteOutcome, readRouteOutcomeWindow (durable per-route
 *             request outcomes in Redis — what `zero-success-route-check` reads)
 *   Sentry:   initSentry, captureError, setSentryContext
 *   Bootstrap: initTelemetry, isTelemetryInitialized
 */

export {
    runWithRequestContext,
    getRequestContext,
    getRequestId,
    mergeRequestContext,
} from './context';
export type { RequestContextData } from './context';

export {
    logger,
    log,
    extractErrorMeta,
    createChildLogger,
    pinoInstance,
} from './logger';
export type { LogLevel, LogFields } from './logger';

export {
    getTracer,
    traceUsecase,
    traceAgUsecase,
    traceOperation,
} from './tracing';

export {
    traceRepository,
    detectResultCount,
} from './repository-tracing';

export {
    recordRequestMetrics,
    recordRequestError,
    recordJobMetrics,
    recordAgOperationMetrics,
    startQueueDepthReporting,
    normalizeRoute,
} from './metrics';

export {
    recordRouteOutcome,
    readRouteOutcomeWindow,
    ROUTE_OUTCOME_WINDOW_HOURS,
} from './route-outcomes';
export type { RouteOutcomeCounts, RouteOutcomeWindow } from './route-outcomes';

export {
    initSentry,
    captureError,
    setSentryContext,
} from './sentry';

export {
    initTelemetry,
    isTelemetryInitialized,
} from './instrumentation';

export {
    runJob,
} from './job-runner';

/**
 * Vision subsystem — a leaf/crop PHOTO → likely pest/disease + a short
 * recommendation. SERVER-ONLY: every provider here loads a heavy native
 * dependency (`onnxruntime-node`, `sharp`) or the Anthropic SDK, none of
 * which may ever enter a client bundle. The UI card imports ONLY the
 * persisted result TYPE (`PestIdentification`), never a provider.
 *
 * Two backends sit behind one `VisionProvider` interface:
 *   - `onnx`   — on-device / edge classifier (CropNet / MobileNetV2-
 *                PlantVillage) via `onnxruntime-node`. Zero network, runs
 *                where the model file is present.
 *   - `claude` — Anthropic Messages-API vision fallback, used when the
 *                on-device model is absent OR its confidence is below the
 *                fallback threshold.
 *
 * AI here is a TRIAGE aid, NOT a diagnosis. The job that consumes a
 * `PestIdentification` always pairs it with a hard "verify with an
 * agronomist" disclaimer and gates low-confidence results — see
 * `app-layer/jobs/classify-photo.ts`.
 */

/** The two vision backends a `VisionProvider` can be. */
export type VisionBackend = 'onnx' | 'claude';

/**
 * The structured identification a `VisionProvider` returns. This is the
 * raw model output — NOT the persisted shape. The classify-photo job
 * augments it with `lowConfidence`, `disclaimer`, and `at` before
 * writing it to `LogEntry.attributesJson.pestId`.
 */
export interface PestIdentification {
    /** Best-guess pest/disease/condition label, or `'unknown'`. */
    identifiedPest: string;
    /** Model confidence in `[0, 1]`. */
    confidence: number;
    /** Short, practical next-step text — always provisional. */
    recommendation: string;
    /** Backend + model id, e.g. `'cropnet-v1'` / `'claude-sonnet-4-6'`. */
    modelVersion: string;
    /** Which backend produced this identification. */
    backend: VisionBackend;
    /**
     * Tokens this identification cost, when a paid backend produced it
     * (#2596). Absent for `onnx`, which spends nothing.
     */
    usage?: VisionUsage;
}

/**
 * What a CLOUD identification cost, so the caller can write the usage ledger
 * (#2596).
 *
 * Optional, and absent from the on-device backend by construction: ONNX runs
 * locally and spends nothing, so a zero-filled `usage` would be a claim about
 * a transaction that never happened. `undefined` says "no spend to record";
 * a present value says "record this".
 *
 * It rides the RESULT rather than being written by the provider, because the
 * provider holds no `RequestContext` — that is the arrangement
 * `ai-spend-gate-covers-embeddings` exempts it on, and giving it a ctx to
 * write the ledger itself would void the exemption's own reasoning.
 */
export interface VisionUsage {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/** An image to classify — raw bytes plus the declared MIME type. */
export interface VisionImage {
    bytes: Buffer;
    mimeType: string;
}

/**
 * A swappable vision backend. Implementations are SERVER-ONLY.
 *
 * `available()` lets the orchestrator skip a backend that cannot run
 * (no ONNX model file present / no API key set) and fall through to the
 * next one — it must never throw.
 */
export interface VisionProvider {
    /** The backend this provider instance is. */
    readonly backend: VisionBackend;
    /**
     * Non-throwing readiness probe. `onnx` → an ONNX model file is
     * present at the configured path; `claude` → an API key is set.
     */
    available(): Promise<boolean>;
    /**
     * Classify an image. Throws on a hard failure (corrupt image,
     * upstream API error) — the orchestrator catches and may fall back.
     */
    identify(image: VisionImage): Promise<PestIdentification>;
}

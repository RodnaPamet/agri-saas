"use client";

/**
 * StepWizard — multi-step field flow primitive (mobile-data-entry PR-4).
 *
 * Wraps the responsive `<Modal>` (a Vaul bottom-drawer on phones) to walk a
 * field user through one decision per screen — e.g. a spray job:
 * "pick parcel → product → rate → confirm". Large tap targets, progress
 * dots, Back/Next, and a Finish that can complete OFFLINE.
 *
 * Offline submit: the caller's `onFinish` typically wraps
 * `useOfflineSync().submit(...)` and returns `{ queued: true }` when the
 * network was unavailable; the wizard then shows a brief "saved offline,
 * will sync" confirmation before closing. Online submits just close.
 *
 * The wizard OWNS the `<form>` — step `content` should be fields, not its
 * own `<form>` / submit buttons. `canAdvance` gates Next/Finish per step.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { Modal } from "./modal";

export interface StepWizardStep {
  /** Stable id (progress-dot key + analytics). */
  id: string;
  /** Heading for THIS screen (one decision per screen). */
  title: string;
  /** Optional sub-copy under the title. */
  description?: ReactNode;
  /** The step's fields / UI. */
  content: ReactNode;
  /** Gate leaving this step (validation). Default `true`. */
  canAdvance?: boolean;
}

export interface StepWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible wizard name. */
  title: string;
  steps: StepWizardStep[];
  /**
   * Fires on the final step's primary action. Wrap your
   * `useOfflineSync().submit(...)` here and return `{ queued: true }` when
   * it was queued offline so the wizard shows the offline-saved state.
   *
   * The contract, relied on by this wizard's first real consumer:
   *
   * - RESOLVING means "done" — the wizard closes.
   * - REJECTING means "failed, keep open" — the wizard clears `busy`, stays
   *   on the last step with every input intact, and swallows the rejection
   *   so it never surfaces as an unhandled promise. Pass the message to
   *   show through `error`; the wizard does not author error copy.
   */
  onFinish: () => Promise<{ queued?: boolean } | void>;
  /** Primary action label on the last step. Default "Create". */
  finishLabel?: string;
  /** Forwarded to `<Modal isDirty>` — a dismiss on a started flow confirms. */
  isDirty?: boolean;
  /**
   * Rendered in a `role="alert"` region above the actions. Pair it with a
   * rejecting `onFinish`: the wizard keeps itself open, the caller says why.
   */
  error?: ReactNode;
}

export function StepWizard({
  open,
  onOpenChange,
  title,
  steps,
  onFinish,
  finishLabel,
  isDirty,
  error,
}: StepWizardProps) {
  const t = useTranslations("ui.stepWizard");
  const tc = useTranslations("common");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  /**
   * `busy` is state, so two submits dispatched in the SAME tick both read it
   * as false and both reach `onFinish`. A ref settles synchronously and is
   * what actually makes the guard hold.
   */
  const inFlight = useRef(false);
  /** The step heading, focused on Next/Back so a screen reader follows. */
  const headingRef = useRef<HTMLSpanElement | null>(null);
  /**
   * Only a step CHANGE moves focus. On first open the Modal owns initial
   * focus, and stealing it here would fight that.
   */
  const navigated = useRef(false);

  // Reset to the first step each time the wizard (re)opens — an intentional
  // sync of the external `open` prop into internal step state (not a render-
  // time derivation; the user also advances steps via the buttons).
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional open→step reset (see above)
      setIndex(0);
      setQueued(false);
    }
  }, [open]);

  // Move focus to the new step's heading so a screen reader follows the
  // change. Guarded on `navigated` — see the ref's comment.
  useEffect(() => {
    if (!navigated.current) return;
    navigated.current = false;
    headingRef.current?.focus();
  }, [index]);

  const last = Math.max(0, steps.length - 1);
  const safeIndex = Math.min(index, last);
  const current = steps[safeIndex];
  const isLast = safeIndex >= last;
  const canAdvance = current ? current.canAdvance !== false : false;

  // Modal's setShowModal is a Dispatch (value OR updater); bridge it to the
  // simpler boolean onOpenChange. Modal only ever passes `false`, but the
  // updater form is handled for type-correctness.
  const setShow = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      onOpenChange(typeof value === "function" ? value(open) : value);
    },
    [onOpenChange, open],
  );

  const back = useCallback(() => {
    navigated.current = true;
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const finish = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await onFinish();
      if (res && typeof res === "object" && res.queued) {
        // Offline confirmation, then close.
        setQueued(true);
        window.setTimeout(() => onOpenChange(false), 1200);
        return;
      }
      onOpenChange(false);
    } catch {
      // A rejection means "failed, keep open" — see `onFinish`. Swallowed on
      // purpose: `onSubmit` calls this with `void`, so a re-throw would be an
      // unhandled rejection rather than anything a user could act on. The
      // caller renders the reason through `error`.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onFinish, onOpenChange]);

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!canAdvance || busy || queued) return;
      if (isLast) {
        void finish();
      } else {
        navigated.current = true;
        setIndex((i) => Math.min(last, i + 1));
      }
    },
    [canAdvance, busy, queued, isLast, finish, last],
  );

  if (steps.length === 0 || !current) return null;

  return (
    <Modal
      showModal={open}
      setShowModal={setShow}
      title={title}
      isDirty={isDirty}
      // A swipe or Escape mid-send would close the drawer while the request
      // is still in flight, leaving the farmer with no idea whether it went.
      preventDefaultClose={busy}
      size="md"
    >
      <Modal.Form onSubmit={onSubmit}>
        <Modal.Header
          // `Modal.Header` renders the title inside its own `Dialog.Title`
          // heading and is not a forwardRef, so the focus target is the title
          // NODE rather than the heading element. Focus still lands inside the
          // h2, which is what a screen reader announces.
          title={
            <span ref={headingRef} tabIndex={-1} className="outline-none">
              {current.title}
            </span>
          }
          description={current.description}
        >
          {/* Progress dots — current is a wide pill, past steps filled, future muted. */}
          <ol
            className="mt-2 flex items-center gap-1.5"
            aria-label={t("stepOf", { current: safeIndex + 1, total: steps.length })}
            data-testid="wizard-progress"
          >
            {steps.map((s, i) => (
              <li
                key={s.id}
                aria-current={i === safeIndex ? "step" : undefined}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === safeIndex
                    ? "w-6 bg-[var(--brand-default)]"
                    : i < safeIndex
                      ? "w-1.5 bg-[var(--brand-default)]/60"
                      : "w-1.5 bg-border-default",
                )}
              />
            ))}
          </ol>
        </Modal.Header>

        <Modal.Body data-testid="wizard-body">
          {queued ? (
            <p className="py-8 text-center text-sm text-content-muted">
              {t("savedOffline")}
            </p>
          ) : (
            current.content
          )}
        </Modal.Body>

        {error ? (
          <div
            role="alert"
            className="mx-5 mb-2 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
            data-testid="wizard-error"
          >
            {error}
          </div>
        ) : null}

        <Modal.Actions align="between">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={back}
            disabled={safeIndex === 0 || busy || queued}
            data-testid="wizard-back"
          >
            {tc("back")}
          </Button>
          {isLast ? (
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!canAdvance || busy || queued}
              data-testid="wizard-finish"
            >
              {busy ? t("saving") : (finishLabel ?? tc("create"))}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!canAdvance}
              data-testid="wizard-next"
            >
              {t("next")}
            </Button>
          )}
        </Modal.Actions>
      </Modal.Form>
    </Modal>
  );
}

export default StepWizard;

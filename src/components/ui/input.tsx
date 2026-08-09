"use client";

/**
 * Epic 55 — shared <Input> primitive.
 *
 * Token-backed, CVA-sized, accessible text/number/password/etc. input
 * that composes cleanly with <Label> and <FormField>. Keeps the legacy
 * password-toggle + inline-error affordances from the Dub port but
 * pivots every colour to the Epic 51 semantic token palette so the same
 * component works in dark + light themes.
 *
 * API surface (props):
 *   - Standard HTMLInputElement attrs (value, onChange, placeholder, …).
 *   - `size`: "sm" | "md" | "lg" — CVA variant, default "md".
 *   - `invalid`: boolean — toggles error styling and `aria-invalid`.
 *   - `error`: string — renders a role="alert" hint below the input.
 *     Supplying `error` implies `invalid`.
 *   - `description`: string — renders a muted hint below the input.
 *
 * Accessibility:
 *   - `aria-invalid` mirrors `invalid` / presence of `error`.
 *   - `aria-describedby` auto-links to the error + description elements
 *     when an `id` is supplied. Downstream `<FormField>` wraps both in
 *     one id-linked package.
 */

import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle } from "lucide-react";
import * as React from "react";
import { Eye, EyeSlash } from "./icons";

// ─── CVA ────────────────────────────────────────────────────────────

// R20-PR-B — Input migrated to the R20 practice-parity edge tokens.
// Same shape as before, but the border / hover / focus channels
// now ride `--ctrl-edge-rest` / `--ctrl-edge-hover` / `--ctrl-edge-focus`
// so a focused Input feels like a cousin of a focused Button rather
// than an unrelated practice. The Tailwind ring is dropped in favour
// of a brand-tinted box-shadow halo on focus — the halo composes
// cleanly with future iridescent input edges (deferred) and reads
// as the same "warm focus glow" the R20 button family wears.
//
// The `controlEdge` recipe from `control-variants.ts` carries the
// border + hover-border + focus-shadow + transition; the cva here
// adds Input-specific surface chrome (bg, text colour, disabled /
// read-only states) and the size scale.
export const inputVariants = cva(
    [
        // R22-PR-A — radius mirror of button-variants.ts (12→10px).
        "w-full rounded-[8px] text-sm",
        "bg-bg-default text-content-emphasis placeholder-content-subtle",
        "focus:outline-none focus-visible:outline-none",
        "border border-[var(--ctrl-edge-rest)]",
        "hover:border-[var(--ctrl-edge-hover)]",
        "focus-visible:shadow-[var(--ctrl-edge-focus)]",
        "transition-colors duration-150 motion-reduce:transition-none",
        "disabled:cursor-not-allowed disabled:bg-bg-muted disabled:text-content-muted disabled:hover:border-[var(--ctrl-edge-rest)]",
        "read-only:bg-bg-muted read-only:text-content-muted read-only:hover:border-[var(--ctrl-edge-rest)]",
    ],
    {
        variants: {
            size: {
                sm: "h-8 px-2.5 text-xs",
                // Roadmap-6 P4 — mobile thumb-target floor. `md` is the
                // DEFAULT Input size; its mobile min-height rises to 44px
                // (WCAG 2.5.5 / Apple HIG) so tapping a field is comfortable
                // on phones. Desktop pins back to h-9 (36px) via `md:min-h-9`
                // so form density is unchanged on larger screens. Kept in
                // lockstep with the Button `md` variant (R20-PR-A parity).
                md: "h-9 min-h-[44px] md:min-h-9 px-3",
                lg: "h-10 px-3.5",
            },
            invalid: {
                true: "border-border-error text-content-error placeholder-content-error/60 focus-visible:border-border-error focus-visible:shadow-[0_0_0_3px_rgb(220_38_38_/_0.20)] hover:border-border-error",
                false: "",
            },
        },
        defaultVariants: { size: "md", invalid: false },
    },
);

// ─── Props ──────────────────────────────────────────────────────────

type CvaInputProps = VariantProps<typeof inputVariants>;

export interface InputProps
    extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
        Omit<CvaInputProps, "invalid"> {
    /** Show error styling + render an `role="alert"` hint below. */
    error?: string;
    /** Muted helper text rendered below the input. */
    description?: string;
    /** Force invalid styling (used when error is surfaced elsewhere). */
    invalid?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    (
        {
            className,
            type,
            size,
            invalid,
            error,
            description,
            id,
            "aria-describedby": ariaDescribedBy,
            ...props
        },
        ref,
    ) => {
        const [isPasswordVisible, setIsPasswordVisible] = React.useState(false);
        const isPassword = type === "password";
        const effectiveType = isPassword && isPasswordVisible ? "text" : type;

        const hasError = Boolean(error);
        const effectiveInvalid = invalid || hasError;

        // Chain aria-describedby so consumers who pass their own ids
        // keep working; we append our own description/error ids when
        // the input has an id of its own.
        const errorId = id && hasError ? `${id}-error` : undefined;
        const descId = id && description ? `${id}-description` : undefined;
        const describedBy =
            [ariaDescribedBy, descId, errorId].filter(Boolean).join(" ") ||
            undefined;

        return (
            <div className="w-full">
                <div className="relative flex">
                    <input
                        type={effectiveType}
                        id={id}
                        ref={ref}
                        // mobile-data-entry PR-4 — a number input opens the
                        // phone's number pad. "decimal" (digits + point) suits
                        // ag values (dose 2.5, qty, yield, cost, GDD). A caller
                        // can override (e.g. inputMode="numeric" for integers)
                        // since the spread below wins.
                        inputMode={type === "number" ? "decimal" : undefined}
                        aria-invalid={effectiveInvalid || undefined}
                        aria-describedby={describedBy}
                        className={cn(
                            inputVariants({ size, invalid: effectiveInvalid }),
                            // Reserve room on the right for the error icon
                            // and/or password toggle so the text doesn't
                            // slide under them.
                            (hasError || isPassword) && "pr-9",
                            hasError && isPassword && "pr-14",
                            className,
                        )}
                        {...props}
                    />

                    {hasError && (
                        <div
                            className={cn(
                                "pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5",
                                isPassword && "transition-opacity group-hover:opacity-0",
                            )}
                        >
                            <AlertCircle
                                className="size-5 text-content-error"
                                aria-hidden="true"
                            />
                        </div>
                    )}

                    {isPassword && (
                        <button
                            type="button"
                            onClick={() => setIsPasswordVisible((v) => !v)}
                            className={cn(
                                "absolute inset-y-0 right-0 flex items-center px-2.5 text-content-muted transition-colors hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                hasError &&
                                    "opacity-0 transition-opacity group-hover:opacity-100",
                            )}
                            aria-label={
                                isPasswordVisible ? "Hide password" : "Show password"
                            }
                            tabIndex={-1}
                        >
                            {isPasswordVisible ? (
                                <Eye className="size-4" aria-hidden="true" />
                            ) : (
                                <EyeSlash className="size-4" aria-hidden="true" />
                            )}
                        </button>
                    )}
                </div>

                {description && !hasError && (
                    <p
                        id={descId}
                        className="mt-1.5 text-xs text-content-muted"
                    >
                        {description}
                    </p>
                )}

                {hasError && (
                    <p
                        id={errorId}
                        role="alert"
                        aria-live="polite"
                        className="mt-1.5 text-xs text-content-error"
                    >
                        {error}
                    </p>
                )}
            </div>
        );
    },
);

Input.displayName = "Input";

export { Input };

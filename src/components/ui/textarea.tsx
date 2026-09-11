"use client";

/**
 * Epic 55 — shared <Textarea> primitive.
 *
 * Matches the <Input> contract (CVA-sized, token-backed, accessible
 * error/description slots) so multi-line inputs stay visually and
 * semantically consistent with single-line inputs.
 *
 * API mirrors <Input>:
 *   - Standard HTMLTextAreaElement attrs (value, onChange, rows, …).
 *   - `invalid`: boolean — toggles error styling + `aria-invalid`.
 *   - `error`: string — role="alert" hint below; implies `invalid`.
 *   - `description`: string — muted helper text below.
 *
 * Unlike Input this primitive doesn't expose a CVA `size` variant —
 * textarea footprint is driven by `rows` / inline className. The
 * "size" concept belongs to height which `rows` already owns.
 */

import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

export const textareaVariants = cva(
    [
        // `text-base` below `md`: 14px would trigger the same iOS focus-zoom
        // as the input rung. See the note in input.tsx.
        "block w-full rounded-lg border text-base md:text-sm transition-colors",
        "bg-bg-default text-content-emphasis placeholder-content-subtle",
        "border-border-subtle",
        "hover:border-border-emphasis",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-border-emphasis",
        "disabled:cursor-not-allowed disabled:bg-bg-muted disabled:text-content-muted disabled:hover:border-border-subtle",
        "read-only:bg-bg-muted read-only:text-content-muted read-only:hover:border-border-subtle",
        "px-3 py-2",
    ],
    {
        variants: {
            invalid: {
                true: "border-border-error text-content-error placeholder-content-error/60 focus-visible:border-border-error focus-visible:ring-border-error",
                false: "",
            },
        },
        defaultVariants: { invalid: false },
    },
);

type CvaTextareaProps = VariantProps<typeof textareaVariants>;

export interface TextareaProps
    extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
        Omit<CvaTextareaProps, "invalid"> {
    error?: string;
    description?: string;
    invalid?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    (
        {
            className,
            invalid,
            error,
            description,
            id,
            "aria-describedby": ariaDescribedBy,
            ...props
        },
        ref,
    ) => {
        const hasError = Boolean(error);
        const effectiveInvalid = invalid || hasError;

        const errorId = id && hasError ? `${id}-error` : undefined;
        const descId = id && description ? `${id}-description` : undefined;
        const describedBy =
            [ariaDescribedBy, descId, errorId].filter(Boolean).join(" ") ||
            undefined;

        return (
            <div className="w-full">
                <textarea
                    ref={ref}
                    id={id}
                    aria-invalid={effectiveInvalid || undefined}
                    aria-describedby={describedBy}
                    className={cn(
                        textareaVariants({ invalid: effectiveInvalid }),
                        className,
                    )}
                    {...props}
                />

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

Textarea.displayName = "Textarea";

export { Textarea };

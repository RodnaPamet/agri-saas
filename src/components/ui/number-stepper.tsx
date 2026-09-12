"use client";

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import {
    HTMLAttributes,
    ReactNode,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
} from "react";
import { Minus, Plus } from "./icons";

/**
 * Epic 60 polish primitive — NumberStepper.
 *
 * A +/- framed numeric input for quantities, durations, thresholds,
 * retention windows, and other bounded integers. Replaces the pattern
 * of bare `<input type="number">` (which varies drastically across
 * browsers and has a notoriously bad mobile experience).
 *
 * ## Behaviour
 *
 *   - Click `-` / `+` to step by `step` (default 1), clamped to
 *     `[min, max]` when provided.
 *   - Focus the input → type a value → Enter or blur commits. Escape
 *     reverts to the last committed value.
 *   - Arrow keys (Left/Down = decrement, Right/Up = increment) work
 *     inside the input for quick nudging.
 *   - `formatValue` (optional) renders the display text while the
 *     input is NOT focused (e.g. `"5 days"`). The raw number is what
 *     users edit when they focus the field; the formatted view is
 *     purely presentational.
 *
 * ## Size variants
 *
 *   - `default` — 40px tall, reads well in forms.
 *   - `sm` — 32px tall, for dense filter toolbars / settings rows.
 *
 * ## Accessibility
 *
 * Renders as `role="group"` wrapping a `role="spinbutton"` input with
 * `aria-valuenow / valuemin / valuemax`. The buttons carry
 * `aria-label` (defaults: "Decrease" / "Increase" — caller should
 * override with a more specific label like "Decrease retention days").
 * Disabled state mirrors `aria-disabled` on the group and `disabled`
 * on the input + buttons, so screen readers and keyboard users both
 * get the right signal.
 */

const stepperVariants = cva(
    "flex w-full select-none items-stretch overflow-hidden rounded-lg border border-border-subtle bg-bg-default",
    {
        variants: {
            size: {
                default: "h-10 p-1",
                sm: "h-8 p-0.5",
            },
        },
        defaultVariants: { size: "default" },
    },
);

const stepperButtonVariants = cva(
    "flex h-full items-center justify-center rounded-lg text-content-default outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    {
        variants: {
            size: {
                default: "w-16",
                sm: "w-10",
            },
        },
        defaultVariants: { size: "default" },
    },
);

const stepperInputVariants = cva(
    "w-full border-0 bg-transparent text-center text-content-emphasis outline-none transition-colors focus:ring-0",
    {
        variants: {
            size: {
                // text-base on the phone: this is a real <input> and iOS
                // focus-zooms anything under 16px. Desktop keeps the
                // original scale above the md breakpoint.
                default: "px-3 text-base md:text-sm",
                sm: "px-2 text-base md:text-xs",
            },
        },
        defaultVariants: { size: "default" },
    },
);

export type NumberStepperProps = {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    className?: string;
    id?: string;
    formatValue?: (value: number) => ReactNode;
    decrementAriaLabel?: string;
    incrementAriaLabel?: string;
    /** Accessible label for the numeric input. Defaults to "Number".
     *  Callers should pass something specific: "Retention days",
     *  "Max retries", etc. */
    ariaLabel?: string;
} & VariantProps<typeof stepperVariants> &
    Omit<HTMLAttributes<HTMLDivElement>, "onChange">;

export function NumberStepper({
    value,
    onChange,
    min,
    max,
    step = 1,
    disabled,
    className,
    id,
    size,
    formatValue,
    decrementAriaLabel = "Decrease",
    incrementAriaLabel = "Increase",
    ariaLabel = "Number",
    ...rest
}: NumberStepperProps) {
    const [inputValue, setInputValue] = useState<string>(String(value));
    const [isEditing, setIsEditing] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const canDecrement =
        !disabled && (typeof min === "number" ? value > min : true);
    const canIncrement =
        !disabled && (typeof max === "number" ? value < max : true);

    useLayoutEffect(() => {
        if (isEditing && inputRef.current && !disabled) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing, disabled]);

    useEffect(() => {
        if (!isEditing && inputValue !== String(value)) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setInputValue(String(value));
        }
    }, [value, isEditing, inputValue]);

    const constrainToRange = useCallback(
        (next: number) => {
            let nextValue = next;
            if (typeof min === "number") nextValue = Math.max(min, nextValue);
            if (typeof max === "number") nextValue = Math.min(max, nextValue);
            return nextValue;
        },
        [min, max],
    );

    const handleDecrement = useCallback(() => {
        if (!canDecrement) return;
        const newValue = constrainToRange(value - step);
        onChange(newValue);
        setInputValue(String(newValue));
    }, [canDecrement, constrainToRange, onChange, step, value]);

    const handleIncrement = useCallback(() => {
        if (!canIncrement) return;
        const newValue = constrainToRange(value + step);
        onChange(newValue);
        setInputValue(String(newValue));
    }, [canIncrement, constrainToRange, onChange, step, value]);

    const handleInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const newInputValue = e.target.value;
            setInputValue(newInputValue);

            // Allow partial typing without triggering onChange every keystroke.
            if (newInputValue === "" || newInputValue === "-") return;

            const numValue = Number(newInputValue);
            if (!isNaN(numValue)) {
                const constrainedValue = constrainToRange(numValue);
                onChange(constrainedValue);
            }
        },
        [constrainToRange, onChange],
    );

    const handleInputBlur = useCallback(() => {
        setIsEditing(false);
        const numValue = Number(inputValue);
        if (isNaN(numValue) || inputValue === "" || inputValue === "-") {
            setInputValue(String(value));
            return;
        }
        const constrainedValue = constrainToRange(numValue);
        onChange(constrainedValue);
        setInputValue(String(constrainedValue));
    }, [inputValue, value, constrainToRange, onChange]);

    const handleInputFocus = useCallback(() => setIsEditing(true), []);

    const handleInputKeyDown = useCallback(
        (e: KeyboardEvent<HTMLInputElement>) => {
            if (disabled) return;
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                handleDecrement();
            } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                handleIncrement();
            } else if (e.key === "Enter") {
                e.preventDefault();
                handleInputBlur();
                e.currentTarget.blur();
            } else if (e.key === "Escape") {
                e.preventDefault();
                setInputValue(String(value));
                e.currentTarget.blur();
            }
        },
        [disabled, handleDecrement, handleIncrement, handleInputBlur, value],
    );

    // When a `formatValue` formatter is provided, the presentation mode
    // (non-focused) shows formatted text, but the underlying input is
    // still the source of truth for assistive tech — we style it
    // transparent rather than replacing it with a separate div so
    // there's exactly ONE spinbutton announced to screen readers.
    const showFormattedView = !isEditing && formatValue;

    return (
        <div
            id={id}
            role="group"
            aria-disabled={disabled}
            className={cn(
                stepperVariants({ size }),
                disabled && "opacity-60",
                className,
            )}
            {...rest}
        >
            <button
                type="button"
                aria-label={decrementAriaLabel}
                onClick={handleDecrement}
                disabled={!canDecrement}
                className={cn(
                    stepperButtonVariants({ size }),
                    canDecrement && "hover:bg-bg-muted active:bg-bg-subtle",
                )}
            >
                <Minus aria-hidden className="block size-4" />
            </button>

            <div className="relative flex min-w-0 flex-1 items-center justify-center">
                <input
                    ref={inputRef}
                    type="text"
                    inputMode="numeric"
                    role="spinbutton"
                    aria-label={ariaLabel}
                    aria-valuenow={value}
                    aria-valuemin={min}
                    aria-valuemax={max}
                    value={isEditing ? inputValue : String(value)}
                    onChange={handleInputChange}
                    onBlur={handleInputBlur}
                    onFocus={handleInputFocus}
                    onKeyDown={handleInputKeyDown}
                    disabled={disabled}
                    className={cn(
                        stepperInputVariants({ size }),
                        disabled && "cursor-not-allowed",
                        !disabled && "cursor-text focus:bg-bg-muted",
                        showFormattedView && "pointer-events-none opacity-0",
                    )}
                />
                {showFormattedView && (
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden
                        onClick={() => {
                            if (!disabled) {
                                setIsEditing(true);
                                setInputValue(String(value));
                            }
                        }}
                        className={cn(
                            "absolute inset-0 flex items-center justify-center text-content-emphasis outline-none",
                            "px-3 text-sm",
                            size === "sm" && "px-2 text-xs",
                            !disabled && "cursor-text hover:bg-bg-muted",
                        )}
                    >
                        {formatValue(value)}
                    </button>
                )}
            </div>

            <button
                type="button"
                aria-label={incrementAriaLabel}
                onClick={handleIncrement}
                disabled={!canIncrement}
                className={cn(
                    stepperButtonVariants({ size }),
                    canIncrement && "hover:bg-bg-muted active:bg-bg-subtle",
                )}
            >
                <Plus aria-hidden className="block size-4" />
            </button>
        </div>
    );
}

export default NumberStepper;

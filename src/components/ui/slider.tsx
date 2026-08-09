"use client";

import { cn } from "@/lib/cn";
import * as RadixSlider from "@radix-ui/react-slider";
import { ReactNode } from "react";

/**
 * Epic 60 polish primitive — Slider.
 *
 * Styled wrapper over Radix Slider so we inherit the keyboard contract
 * (Arrow step, PageUp/Down step*10, Home/End to bounds) and ARIA
 * semantics (`role="slider"`, `aria-valuemin/max/now`, `aria-orientation`)
 * for free. Everything we own is token-backed and will re-theme.
 *
 * ## The track-inset trick
 *
 * The Radix Range fills from 0 → thumb position, but the thumb is
 * `thumb-radius` tall — so if we drew the Range edge-to-edge it would
 * visibly extend past the thumb by half its width, giving the track a
 * lopsided look. We render the FILLED portion inside an inset wrapper
 * (`inset-x-[var(--thumb-radius)]`) and draw a matching-color stub
 * manually on the left edge so "full" means "reached the thumb center".
 * The mark dots are positioned on the full range (min..max), also
 * inside the inset area.
 *
 * ## Value display + marks
 *
 * `marks` — array of numeric positions to draw as dots on the track.
 *   Defaults to four evenly-spaced points (min, 1/3, 2/3, max).
 * `hint` — freeform ReactNode under the slider. Use for "min / max"
 *   range labels, a live-updated current value, or help copy.
 * `formatLabel` — if provided, renders a floating label above the
 *   thumb at the current position. Handy for percentage sliders.
 *
 * ## When NOT to use
 *
 * A slider is the wrong practice for discrete choices with ≤5 steps or
 * non-numeric options — use ToggleGroup or RadioGroup. Sliders also
 * struggle on touch without a visible numeric value; if the user
 * needs to pick precisely, pair with NumberStepper.
 */

export interface SliderProps {
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step?: number;
    marks?: number[];
    className?: string;
    hint?: ReactNode;
    disabled?: boolean;
    /** Accessible label. Required by RadixSlider — defaults to "Slider"
     *  but consumers should pass something specific ("Impact", "Volume"). */
    ariaLabel?: string;
    /** Optional formatter for a floating current-value label above the
     *  thumb. Typical use: `(v) => `${v}%`` for percentage sliders. */
    formatLabel?: (value: number) => ReactNode;
}

export function Slider({
    value,
    onChange,
    min,
    max,
    step = 1,
    marks,
    className,
    hint,
    disabled,
    ariaLabel = "Slider",
    formatLabel,
}: SliderProps) {
    const sliderMarks = marks || [
        min,
        min + (max - min) / 3,
        min + (2 * (max - min)) / 3,
        max,
    ];
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;

    return (
        <div
            className={cn(
                "relative z-0 [--thumb-radius:13px] [--track-height:16px]",
                disabled && "opacity-60",
                className,
            )}
        >
            <div className="w-full">
                <RadixSlider.Root
                    className="relative flex h-8 w-full items-center"
                    value={[value]}
                    min={min}
                    max={max}
                    step={step}
                    onValueChange={([v]: number[]) => onChange(v)}
                    disabled={disabled}
                >
                    <RadixSlider.Track className="relative h-[var(--track-height)] w-full overflow-visible rounded-full bg-bg-subtle">
                        {/* Stub on the left edge — see docblock on why. */}
                        <div className="absolute left-0 top-0 h-full w-[var(--thumb-radius)] rounded-l-full bg-content-emphasis" />

                        <div className="pointer-events-none absolute inset-x-[var(--thumb-radius)] inset-y-0">
                            <RadixSlider.Range className="absolute h-[var(--track-height)] bg-content-emphasis" />

                            {sliderMarks.map((mark) => {
                                const left =
                                    ((mark - min) / (max - min)) * 100;
                                return (
                                    <span
                                        key={mark}
                                        aria-hidden
                                        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-bg-default"
                                        style={{ left: `${left}%` }}
                                    />
                                );
                            })}
                        </div>
                    </RadixSlider.Track>

                    <RadixSlider.Thumb
                        aria-label={ariaLabel}
                        className="relative z-20 flex size-[calc(var(--thumb-radius)*2)] items-center justify-center rounded-full border-0 bg-bg-default shadow-[0_2px_2px_rgba(0,0,0,0.10),0_3px_3px_rgba(0,0,0,0.09)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                        <span className="block size-[calc(var(--thumb-radius)*1.23)] rounded-full bg-content-emphasis" />
                        {formatLabel && (
                            <span
                                aria-hidden
                                className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-bg-inverted px-2 py-0.5 text-xs font-medium text-content-inverted"
                            >
                                {formatLabel(value)}
                            </span>
                        )}
                    </RadixSlider.Thumb>
                </RadixSlider.Root>

                {hint && (
                    <div className="mt-2 min-h-[1rem] text-xs text-content-subtle">
                        {hint}
                    </div>
                )}
            </div>
            {/* Percentage is useful in-DOM for tests + assistive tech
                that reads data-* attributes; the visible presentation
                comes from Radix's ARIA values. */}
            <span aria-hidden data-value-percent={pct.toFixed(2)} />
        </div>
    );
}

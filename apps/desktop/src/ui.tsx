import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes
} from "react";

/**
 * Minimal self-owned UI primitives. They intentionally cover only what the
 * product uses — no design-system sprawl — and are styled entirely from the
 * token layer in styles.css.
 */

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "outline" | "subtle";
export type ButtonSize = "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", size = "md", icon, className, children, type = "button", ...rest },
  ref
) {
  const classes = [
    "btn",
    `btn-${variant}`,
    size === "sm" ? "btn-sm" : "",
    icon && !children ? "btn-icon-only" : "",
    className ?? ""
  ].filter(Boolean).join(" ");
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {icon ? <span className="btn-glyph" aria-hidden="true">{icon}</span> : null}
      {children ? <span className="btn-text">{children}</span> : null}
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type BadgeVariant = "soft" | "outline" | "filled";

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  variant?: BadgeVariant;
};

export function Badge({ tone = "neutral", variant = "soft", className, ...rest }: BadgeProps) {
  return <span className={["badge", `badge-${tone}`, `badge-${variant}`, className ?? ""].filter(Boolean).join(" ")} {...rest} />;
}

/* ------------------------------------------------------------------ */
/* Textarea                                                            */
/* ------------------------------------------------------------------ */

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 3, ...rest },
  ref
) {
  return <textarea ref={ref} rows={rows} className={["textarea", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
});

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

export type TooltipProps = {
  content: ReactNode;
  side?: "top" | "right" | "bottom";
  children: ReactElement;
};

/**
 * Accessible tooltip: appears on hover and keyboard focus, is wired back to
 * its trigger with `aria-describedby`, and carries `role="tooltip"`. Purely
 * CSS-positioned; it never traps focus or blocks pointer events.
 */
export function Tooltip({ content, side = "top", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!isValidElement(children)) return children;

  const trigger = children as ReactElement<Record<string, unknown>>;
  const props = trigger.props;
  const chain = (handler: unknown, next: () => void) => (event: unknown) => {
    if (typeof handler === "function") (handler as (e: unknown) => void)(event);
    next();
  };

  const triggerProps: Record<string, unknown> = {
    onMouseEnter: chain(props.onMouseEnter, () => setOpen(true)),
    onMouseLeave: chain(props.onMouseLeave, () => setOpen(false)),
    onFocus: chain(props.onFocus, () => setOpen(true)),
    onBlur: chain(props.onBlur, () => setOpen(false))
  };
  if (open) triggerProps["aria-describedby"] = id;

  return (
    <span className="tooltip-anchor">
      {cloneElement(trigger, triggerProps)}
      {open ? (
        <span className={`tooltip tooltip-${side}`} role="tooltip" id={id}>
          {content}
        </span>
      ) : null}
    </span>
  );
}

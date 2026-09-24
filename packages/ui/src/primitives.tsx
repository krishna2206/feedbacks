import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { CheckGlyph } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "borderless" | "muted" | "ghost" | "danger" | "tab";
export type ButtonSize = "sm" | "md" | "normal" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (tightens the leading padding) */
  icon?: ReactNode;
  /** Icon-only square button */
  iconOnly?: boolean;
  active?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "normal", icon, iconOnly, active, className = "", children, type = "button", ...rest },
  ref,
) {
  const cls = [
    "btn",
    `btn--${variant}`,
    size !== "normal" && `btn--${size}`,
    iconOnly && "btn--icon",
    icon && !iconOnly && children && "btn--lead",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={cls} data-active={active || undefined} {...rest}>
      {icon}
      {!iconOnly && children}
    </button>
  );
});

export function Kbd({ keys, borderless = false }: { keys: string | string[]; borderless?: boolean }) {
  const list = Array.isArray(keys) ? keys : [keys];
  return (
    <span className="kbd-group">
      {list.map((k, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list of keys, may contain duplicates (e.g. "G G")
        <kbd key={i} className={`kbd${borderless ? " kbd--borderless" : ""}`}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function Checkbox({
  checked,
  onChange,
  className = "",
  label,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  className?: string;
  label?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: custom-styled checkbox; role + aria-checked keep it accessible
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={`cbx ${className}`}
      data-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!checked);
      }}
    >
      {checked && <CheckGlyph />}
    </button>
  );
}

export function LabelDot({ color, tiny = false }: { color: string; tiny?: boolean }) {
  return <span className={`dot${tiny ? " dot--tiny" : ""}`} style={{ background: color }} />;
}

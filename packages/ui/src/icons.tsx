import type { CSSProperties } from "react";
import { FLUENT, type FluentName } from "./fluent-icons.gen";

/* UI icons = Microsoft Fluent UI System Icons (MIT), 16px regular variants,
 * extracted at build time by scripts/gen-icons.mjs. To add one: extend MAP there and run `npm run icons`.
 * Status/priority icons are separate (domain-icons.tsx). */

export type IconName = Exclude<FluentName, "caret" | "checkSmall">;

function Svg({ name, size, className, style }: { name: FluentName; size: number; className?: string; style?: CSSProperties }) {
  const icon = FLUENT[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${icon.w} ${icon.h}`}
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted SVG bodies generated at build time from @iconify-json/fluent
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Kept for API compatibility with the former stroke icons; Fluent icons are filled shapes */
  strokeWidth?: number;
}) {
  return <Svg name={name} size={size} className={className} style={style} />;
}

/** Caret next to dropdown buttons */
export function Caret({ open = false }: { open?: boolean }) {
  return <Svg name="caret" size={10} style={{ transition: "transform .1s ease-in-out", transform: open ? "rotate(180deg)" : undefined }} />;
}

/** Check glyph inside checkboxes */
export function CheckGlyph({ size = 10 }: { size?: number }) {
  return <Svg name="checkSmall" size={size} />;
}

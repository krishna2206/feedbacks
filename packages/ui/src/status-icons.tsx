/**
 * Ticket status and priority icons (original designs).
 * Status: a ring whose inner pie fills with progress; closed states become a solid disc with a glyph.
 * Priority: stacked chevrons (low → high) and a warning disc for urgent.
 */

export type StatusType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

/** Point on a circle, angle in turns (0 = top, clockwise) */
const pt = (cx: number, cy: number, r: number, turns: number) => {
  const a = turns * 2 * Math.PI - Math.PI / 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
};

function pie(progress: number, r = 3.6) {
  if (progress <= 0) return null;
  if (progress >= 1) return <circle cx="8" cy="8" r={r} />;
  const [x, y] = pt(8, 8, r, progress);
  const large = progress > 0.5 ? 1 : 0;
  return <path d={`M8 8 L8 ${8 - r} A${r} ${r} 0 ${large} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`} />;
}

export function StatusIcon({
  type,
  progress = 0.5,
  color,
  size = 14,
  label,
}: {
  type: StatusType;
  /** 0..1, used by "started" states */
  progress?: number;
  color: string;
  size?: number;
  label?: string;
}) {
  const solid = type === "completed" || type === "canceled";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label} style={{ flexShrink: 0 }}>
      {solid ? (
        <>
          <circle cx="8" cy="8" r="7" fill={color} />
          <path
            d={type === "completed" ? "M4.9 8.2 7 10.2 11.1 5.9" : "M5.6 5.6 10.4 10.4 M10.4 5.6 5.6 10.4"}
            fill="none"
            stroke="var(--bg-base)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.25"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray={type === "backlog" ? "1.6 2.1" : undefined}
            strokeLinecap="round"
          />
          <g fill={color} style={{ transition: "all .3s" }}>
            {type === "started" && pie(progress)}
            {type === "triage" && <circle cx="8" cy="8" r="2.2" />}
          </g>
        </>
      )}
    </svg>
  );
}

/** 0 none · 1 urgent · 2 high · 3 medium · 4 low */
export function PriorityIcon({ priority, size = 16, label }: { priority: 0 | 1 | 2 | 3 | 4; size?: number; label?: string }) {
  if (priority === 1)
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label} style={{ flexShrink: 0 }}>
        <circle cx="8" cy="8" r="7" fill="var(--orange-base)" />
        <path d="M8 4.3v4.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r="1.05" fill="#fff" />
      </svg>
    );
  const count = priority === 0 ? 0 : priority === 2 ? 3 : priority === 3 ? 2 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={label} style={{ flexShrink: 0 }}>
      <g fill="none" stroke="var(--label-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {count === 0 ? (
          <path d="M3.5 8h9" strokeDasharray="2 2.5" />
        ) : (
          [0, 1, 2].map((i) => (
            <path key={i} d={`M4 ${12 - i * 3.6} 8 ${8.4 - i * 3.6} 12 ${12 - i * 3.6}`} opacity={i < count ? 1 : 0.25} />
          ))
        )}
      </g>
    </svg>
  );
}

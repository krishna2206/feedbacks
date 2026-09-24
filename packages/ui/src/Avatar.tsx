import "./avatar.css";

export function initials(name: string) {
  const w = name.replace(/[._@]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return "?";
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

/** Stable background color derived from an id (or name) */
export function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const light = [38, 46, 54][h % 3];
  return `hsl(${hue} 55% ${light}%)`;
}

export function Avatar({
  user,
  size = 18,
  title,
}: {
  user?: { id?: string; name: string; image?: string | null } | null;
  size?: number;
  title?: string;
}) {
  if (!user) return <span className="avatar avatar--empty" style={{ width: size, height: size }} title={title} />;
  const label = title ?? user.name;
  if (user.image)
    return <img className="avatar" src={user.image} alt={label} title={label} width={size} height={size} style={{ objectFit: "cover" }} />;
  return (
    <span
      className="avatar"
      title={label}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.45)), background: avatarColor(user.id ?? user.name) }}
    >
      {initials(user.name)}
    </span>
  );
}

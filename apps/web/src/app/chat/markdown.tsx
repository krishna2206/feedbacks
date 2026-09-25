/**
 * Light markdown for chat messages, rendered to React elements (never HTML strings, so no XSS):
 *   ```code blocks```, `inline code`, **bold**, *italic* / _italic_, ~~strike~~,
 *   auto-linked URLs and `<@userId>` mentions.
 */
import { Fragment, type ReactNode } from "react";

type UserLookup = (id: string) => { name: string } | undefined;

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*)|(\b_[^_\s][^_\n]*_\b)|(<@[A-Za-z0-9_-]{1,64}>)|(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g;

export function inline(text: string, users: UserLookup, meId: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), users, meId, key)}</strong>);
    else if (m[3]) out.push(<s key={key}>{inline(tok.slice(2, -2), users, meId, key)}</s>);
    else if (m[4] || m[5]) out.push(<em key={key}>{inline(tok.slice(1, -1), users, meId, key)}</em>);
    else if (m[6]) {
      const id = tok.slice(2, -1);
      const u = users(id);
      out.push(
        <span key={key} className="mention" data-me={id === meId || undefined}>
          @{u?.name ?? "unknown"}
        </span>,
      );
    } else if (m[7])
      out.push(
        <a key={key} href={tok} target="_blank" rel="noopener noreferrer nofollow">
          {tok}
        </a>,
      );
    last = index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, users, meId }: { text: string; users: UserLookup; meId: string }) {
  const parts = text.split(/```(?:[a-zA-Z0-9_+-]*\n)?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) => {
        const key = `b${i}`;
        // Odd indexes are the content of fenced code blocks
        if (i % 2 === 1)
          return (
            <pre key={key} className="md-pre">
              <code>{part.replace(/\n$/, "")}</code>
            </pre>
          );
        if (!part) return null;
        const lines = part.split("\n");
        return (
          <Fragment key={key}>
            {lines.map((line, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of an immutable message body; position is their identity
              <Fragment key={`${key}-${j}`}>
                {j > 0 && <br />}
                {inline(line, users, meId, `${key}-${j}`)}
              </Fragment>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

/** Plain-text version (mentions resolved) for previews, copy and aria labels */
export function plainText(text: string, users: UserLookup) {
  return text.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${users(id)?.name ?? "unknown"}`);
}

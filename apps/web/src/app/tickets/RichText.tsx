/**
 * Block markdown for ticket descriptions and comments, rendered to React elements (never HTML strings,
 * so there is nothing to sanitize): headings, quotes, bullet/numbered lists, fenced code, paragraphs.
 * Inline syntax (bold, italic, code, links, mentions) comes from the chat renderer.
 */
import { type ReactNode, useMemo } from "react";
import { inline } from "../chat/markdown";

type Lookup = (id: string) => { name: string } | undefined;

type Block =
  | { type: "p" | "quote"; lines: string[] }
  | { type: "h"; level: 1 | 2 | 3; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "code"; text: string };

function parse(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] as string)) body.push(lines[i++] as string);
      i++;
      out.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ type: "h", level: (h[1] as string).length as 1 | 2 | 3, text: h[2] as string });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) q.push((lines[i++] as string).replace(/^>\s?/, ""));
      out.push({ type: "quote", lines: q });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i] as string))
        items.push((lines[i++] as string).replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ""));
      out.push({ type: ordered ? "ol" : "ul", items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() && !/^(```|#{1,3}\s|>|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i] as string))
      p.push(lines[i++] as string);
    out.push({ type: "p", lines: p });
  }
  return out;
}

function Lines({ lines, users, meId, k }: { lines: string[]; users: Lookup; meId: string; k: string }) {
  return (
    <>
      {lines.map((l, j) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines of an immutable text
        <span key={`${k}-${j}`}>
          {j > 0 && <br />}
          {inline(l, users, meId, `${k}-${j}`)}
        </span>
      ))}
    </>
  );
}

export function RichText({ text, users, meId, className = "rich" }: { text: string; users: Lookup; meId: string; className?: string }) {
  const blocks = useMemo(() => parse(text), [text]);
  const nodes: ReactNode[] = blocks.map((b, i) => {
    const k = `b${i}`;
    switch (b.type) {
      case "h": {
        const Tag = `h${b.level + 1}` as "h2" | "h3" | "h4";
        return <Tag key={k}>{inline(b.text, users, meId, k)}</Tag>;
      }
      case "quote":
        return (
          <blockquote key={k}>
            <Lines lines={b.lines} users={users} meId={meId} k={k} />
          </blockquote>
        );
      case "ul":
      case "ol": {
        const Tag = b.type;
        return (
          <Tag key={k}>
            {b.items.map((it, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items of an immutable text
              <li key={`${k}-${j}`}>{inline(it, users, meId, `${k}-${j}`)}</li>
            ))}
          </Tag>
        );
      }
      case "code":
        return (
          <pre key={k} className="md-pre">
            <code>{b.text}</code>
          </pre>
        );
      default:
        return (
          <p key={k}>
            <Lines lines={b.lines} users={users} meId={meId} k={k} />
          </p>
        );
    }
  });
  return <div className={className}>{nodes}</div>;
}

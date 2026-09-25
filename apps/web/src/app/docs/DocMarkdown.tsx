/**
 * Markdown for knowledge-base documents, rendered to React elements (never HTML strings, so there is
 * nothing to sanitize): headings with anchors, paragraphs, bullet / numbered / task lists, quotes,
 * fenced code, tables, rules, images and links. Inline syntax comes from the chat renderer
 * (bold, italic, code, mentions, `<doc:id>` document mentions) plus `[text](url)` links and images.
 *
 * Images are only loaded from this app's file endpoint (`/api/files/…`, permission-checked) or https;
 * links only for http(s), mailto, and relative / anchor URLs.
 */
import { Fragment, type ReactNode, useMemo } from "react";
import { inline } from "../chat/markdown";

type Lookup = (id: string) => { name: string } | undefined;

export type Heading = { level: 1 | 2 | 3; text: string; slug: string };

type Block =
  | { type: "p" | "quote"; lines: string[] }
  | { type: "h"; level: 1 | 2 | 3 | 4; text: string; slug: string }
  | { type: "list"; ordered: boolean; items: { text: string; task: null | boolean }[] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; head: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][] }
  | { type: "hr" }
  | { type: "img"; alt: string; src: string };

export const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "section";

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCK_START = /^(```|~~~|#{1,4}\s|>|\s*(?:[-*+]|\d+[.)])\s|\s*(?:-{3,}|\*{3,}|_{3,})\s*$|!\[[^\]]*\]\([^)]+\)\s*$)/;

export function parseDoc(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const slugs = new Map<string, number>();
  const uniqueSlug = (text: string) => {
    const base = slugify(text);
    const n = slugs.get(base) ?? 0;
    slugs.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = /^(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).startsWith(fence[1] as string)) body.push(lines[i++] as string);
      i++;
      out.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = h[2] as string;
      out.push({ type: "h", level: (h[1] as string).length as 1 | 2 | 3 | 4, text, slug: uniqueSlug(text) });
      i++;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line.trim());
    if (img) {
      out.push({ type: "img", alt: img[1] as string, src: img[2] as string });
      i++;
      continue;
    }
    // Tables: header row, then a separator row like | --- | :-: |
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] as string)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] as string).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim())
        rows.push(splitRow(lines[i++] as string));
      out.push({ type: "table", head, align, rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) q.push((lines[i++] as string).replace(/^>\s?/, ""));
      out.push({ type: "quote", lines: q });
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: { text: string; task: null | boolean }[] = [];
      while (i < lines.length && LIST.test(lines[i] as string)) {
        const text = (lines[i++] as string).replace(LIST, "");
        const task = /^\[([ xX])\]\s+/.exec(text);
        items.push(task ? { text: text.slice(task[0].length), task: task[1] !== " " } : { text, task: null });
      }
      out.push({ type: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() && !BLOCK_START.test(lines[i] as string)) p.push(lines[i++] as string);
    if (!p.length) p.push(lines[i++] as string);
    out.push({ type: "p", lines: p });
  }
  return out;
}

/** Headings of a document (table of contents) */
export const headingsOf = (src: string): Heading[] =>
  parseDoc(src).flatMap((b) => (b.type === "h" && b.level <= 3 ? [{ level: b.level as 1 | 2 | 3, text: b.text, slug: b.slug }] : []));

const safeHref = (url: string) => (/^(https?:|mailto:)/i.test(url) || /^[/#]/.test(url) ? url : null);
const safeImg = (url: string) => (/^\/api\/files\/[A-Za-z0-9_-]+(\/thumb)?$/.test(url) || /^https:\/\//i.test(url) ? url : null);

/** Inline text with `[text](url)` links and inline images on top of the chat inline syntax */
function rich(text: string, users: Lookup, meId: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g)) {
    const index = m.index ?? 0;
    if (index > last) out.push(...inline(text.slice(last, index), users, meId, `${key}-t${n}`));
    const k = `${key}-l${n++}`;
    const [, bang, label, url] = m as unknown as [string, string, string, string];
    if (bang) {
      const src = safeImg(url);
      out.push(src ? <img key={k} src={src} alt={label} className="doc-img doc-img--inline" loading="lazy" /> : `![${label}](${url})`);
    } else {
      const href = safeHref(url);
      out.push(
        href ? (
          <a key={k} href={href} {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>
            {inline(label, users, meId, k)}
          </a>
        ) : (
          label
        ),
      );
    }
    last = index + m[0].length;
  }
  if (last < text.length) out.push(...inline(text.slice(last), users, meId, `${key}-t${n}`));
  return out;
}

export function DocMarkdown({ text, users, meId }: { text: string; users: Lookup; meId: string }) {
  const blocks = useMemo(() => parseDoc(text), [text]);
  return (
    <div className="doc-md">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.type) {
          case "h": {
            const Tag = `h${b.level}` as "h1" | "h2" | "h3" | "h4";
            return (
              <Tag key={k} id={b.slug}>
                <a href={`#${b.slug}`} className="doc-md__anchor" aria-label={b.text}>
                  #
                </a>
                {rich(b.text, users, meId, k)}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={k}>
                {b.lines.map((l, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of an immutable text
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {rich(l, users, meId, `${k}-${j}`)}
                  </Fragment>
                ))}
              </blockquote>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={k} className={b.items.some((it) => it.task !== null) ? "doc-md__tasks" : undefined}>
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: items of an immutable text
                  <li key={j} data-task={it.task === null ? undefined : it.task}>
                    {it.task !== null && <input type="checkbox" checked={it.task} readOnly tabIndex={-1} aria-hidden />}
                    {rich(it.text, users, meId, `${k}-${j}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={k} className="md-pre" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "table":
            return (
              <div key={k} className="doc-md__table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells of an immutable text
                        <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                          {rich(c, users, meId, `${k}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: rows of an immutable text
                      <tr key={ri}>
                        {b.head.map((_, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: cells of an immutable text
                          <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                            {rich(r[j] ?? "", users, meId, `${k}-${ri}-${j}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={k} />;
          case "img": {
            const src = safeImg(b.src);
            return src ? (
              <figure key={k} className="doc-figure">
                <img src={src} alt={b.alt} className="doc-img" loading="lazy" />
                {b.alt && <figcaption>{b.alt}</figcaption>}
              </figure>
            ) : (
              <p key={k}>{`![${b.alt}](${b.src})`}</p>
            );
          }
          default:
            return (
              <p key={k}>
                {b.lines.map((l, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of an immutable text
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {rich(l, users, meId, `${k}-${j}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

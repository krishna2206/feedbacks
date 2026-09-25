import { splitMentions } from "@feedbacks/schema/chat";
import { Fragment } from "react";
import "./highlight.css";

const START = "\uE000";
const END = "\uE001";

/** Renders a string with \uE000…\uE001 markers (from the search API) as <mark>, never as HTML */
export function Highlighted({ text }: { text: string }) {
  const parts: { mark: boolean; value: string }[] = [];
  let rest = text;
  while (rest) {
    const a = rest.indexOf(START);
    if (a < 0) {
      parts.push({ mark: false, value: rest });
      break;
    }
    const b = rest.indexOf(END, a);
    if (a > 0) parts.push({ mark: false, value: rest.slice(0, a) });
    parts.push({ mark: true, value: rest.slice(a + 1, b < 0 ? undefined : b) });
    rest = b < 0 ? "" : rest.slice(b + 1);
  }
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of a string
          <mark key={i} className="hl">
            {p.value}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of a string
          <Fragment key={i}>{p.value}</Fragment>
        ),
      )}
    </>
  );
}

/** Plain text of a body with `<@userId>` mention tokens rendered as "@Name" */
export function mentionsToText(body: string, nameOf: (userId: string) => string | undefined) {
  return splitMentions(body)
    .map((p) => (p.type === "text" ? p.value : `@${nameOf(p.userId) ?? "?"}`))
    .join("");
}

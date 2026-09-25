/**
 * Markdown source editor (CodeMirror 6). Its own chunk: loaded only when someone edits a document.
 * ⌘B bold, ⌘I italic, ⌘K link, ⌘S / ⌘↵ save; pasted or dropped files are handed to `onFiles`
 * (the page uploads them and inserts the markdown through the `api` handle).
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defineLanguageFacet, HighlightStyle, Language, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { placeholder as cmPlaceholder, drawSelection, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { GFM, parser as markdownParser } from "@lezer/markdown";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

export type EditorApi = { insert: (text: string) => void; focus: () => void };

/**
 * Markdown (GFM) straight from the Lezer parser: @codemirror/lang-markdown would also bundle the HTML,
 * CSS and JavaScript languages for embedded code, which this editor doesn't need (a much smaller chunk).
 */
const markdown = () =>
  new LanguageSupport(
    new Language(
      defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } }),
      markdownParser.configure(GFM),
      [],
      "markdown",
    ),
  );

const highlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--label-title)", fontWeight: "600" },
  { tag: tags.strong, color: "var(--label-title)", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--purple-text)" },
  { tag: tags.monospace, color: "var(--teal-text)" },
  { tag: tags.quote, color: "var(--label-muted)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--label-faint)" },
  { tag: tags.list, color: "var(--label-muted)" },
]);

/** Wraps the selection (or a placeholder word) with a marker, e.g. ** for bold */
const wrap = (marker: string, fallback: string) => (view: EditorView) => {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to) || fallback;
      const insert = `${marker}${text}${marker}`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(range.from + marker.length, range.from + marker.length + text.length),
      };
    }),
  );
  return true;
};

const link = (view: EditorView) => {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to) || "link";
      const insert = `[${text}](https://)`;
      const urlStart = range.from + text.length + 3;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlStart, urlStart + 8) };
    }),
  );
  return true;
};

export default function MarkdownEditor({
  value,
  onChange,
  onSave,
  onFiles,
  placeholder,
  api,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onFiles: (files: File[]) => void;
  placeholder: string;
  api?: Ref<EditorApi>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Latest callbacks without recreating the editor
  const live = useRef({ onChange, onSave, onFiles });
  live.current = { onChange, onSave, onFiles };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; outside changes are synced below
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          cmPlaceholder(placeholder),
          keymap.of([
            { key: "Mod-b", run: wrap("**", "bold") },
            { key: "Mod-i", run: wrap("_", "italic") },
            { key: "Mod-k", run: link },
            { key: "Mod-s", preventDefault: true, run: () => (live.current.onSave(), true) },
            { key: "Mod-Enter", run: () => (live.current.onSave(), true) },
            indentWithTab,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) live.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste: (e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (!files.length) return false;
              e.preventDefault();
              live.current.onFiles(files);
              return true;
            },
            drop: (e) => {
              const files = Array.from(e.dataTransfer?.files ?? []);
              if (!files.length) return false;
              e.preventDefault();
              live.current.onFiles(files);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // Outside changes (reload after a conflict, restored version): replace the document
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useImperativeHandle(
    api,
    () => ({
      insert: (text: string) => {
        const v = view.current;
        if (!v) return;
        v.dispatch(v.state.replaceSelection(text));
        v.focus();
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return <div ref={host} className="doc-edit__cm" />;
}

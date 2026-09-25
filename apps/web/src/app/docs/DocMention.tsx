import { Icon } from "@feedbacks/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { useDocIndex } from "./data";

/** A `<doc:id>` mention: a link when the reader can read the document, a neutral chip otherwise */
export function DocMention({ id }: { id: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const doc = useDocIndex().get(id);
  if (!doc)
    return (
      <span className="doc-mention doc-mention--restricted">
        <Icon name="lock" size={12} />
        {t("docs.restrictedMention")}
      </span>
    );
  return (
    <Link to="/$orgSlug/docs/d/$docId" params={{ orgSlug: org.slug, docId: id }} className="doc-mention">
      <Icon name="doc" size={12} />
      {doc.title}
    </Link>
  );
}

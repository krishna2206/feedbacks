import { mutators } from "@feedbacks/schema/zero";
import { Button, Icon, Menu, useMenu } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { useDocIndex } from "./data";
import { useReport } from "./util";

/** "Related documents" section of a ticket (only documents the reader can read are synced) */
export function RelatedDocs({
  ticketId,
  links,
  editable,
}: {
  ticketId: string;
  links: readonly { id: string; docId: string; doc?: { id: string; title: string } | null | undefined }[];
  editable: boolean;
}) {
  const { t } = useTranslation();
  const zero = useZero();
  const report = useReport();
  const { org } = useOrg();
  const index = useDocIndex();
  const picker = useMenu();
  const linked = new Set(links.map((l) => l.docId));
  if (!links.length && !editable) return null;
  return (
    <section className="tk-section">
      <h2 className="tk-section__title">
        <Icon name="doc" size={14} />
        {t("docs.related")}
        {editable && (
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name="plus" size={14} />}
            onClick={picker.toggleFrom}
            active={picker.open}
            aria-label={t("docs.linkDoc")}
          />
        )}
      </h2>
      {links.length === 0 ? (
        <p className="tk-muted">{t("docs.noRelated")}</p>
      ) : (
        <div className="related-docs">
          {links.map((l) => (
            <Link key={l.id} to="/$orgSlug/docs/d/$docId" params={{ orgSlug: org.slug, docId: l.docId }} className="related-doc">
              <Icon name="doc" size={14} />
              <span className="truncate">{l.doc?.title ?? index.get(l.docId)?.title ?? "…"}</span>
              {editable && (
                <Button
                  variant="muted"
                  size="sm"
                  iconOnly
                  icon={<Icon name="unlink" size={14} />}
                  aria-label={t("docs.unlinkDoc")}
                  onClick={(e) => {
                    e.preventDefault();
                    void report(zero.mutate(mutators.docLinks.unlink({ organizationId: org.id, ticketId, docId: l.docId })));
                  }}
                />
              )}
            </Link>
          ))}
        </div>
      )}
      <Menu
        anchor={picker.anchor}
        onClose={picker.close}
        width={320}
        filterPlaceholder={t("docs.searchDocs")}
        emptyText={t("common.noResults")}
        items={[...index.values()]
          .filter((d) => !linked.has(d.id))
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((d) => ({
            id: d.id,
            label: d.title,
            icon: <Icon name="doc" size={14} />,
            onSelect: () =>
              void report(zero.mutate(mutators.docLinks.link({ organizationId: org.id, ticketId, docId: d.id, at: Date.now() }))),
          }))}
      />
    </section>
  );
}

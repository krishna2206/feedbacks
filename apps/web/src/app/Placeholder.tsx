import { Icon, type IconName } from "@feedbacks/ui";
import { useTranslation } from "react-i18next";
import { ViewHeader } from "./ViewHeader";

function Placeholder({ title, icon, text }: { title: string; icon: IconName; text: string }) {
  const { t } = useTranslation();
  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name={icon} size={14} />
          {title}
        </span>
      </ViewHeader>
      <div className="empty">
        <div>
          <h3>{t("common.comingSoon")}</h3>
          <p>{text}</p>
        </div>
      </div>
    </>
  );
}

export function DocsPlaceholder() {
  const { t } = useTranslation();
  return <Placeholder title={t("nav.docs")} icon="doc" text={t("placeholder.docs")} />;
}

import { Button } from "@feedbacks/ui";
import { useTranslation } from "react-i18next";
import { useGo } from "../go";

/** Tabs of the settings pages (in the view header) */
export function SettingsTabs({ current }: { current: "account" | "notifications" | "members" | "teams" | "tokens" | "integrations" }) {
  const { t } = useTranslation();
  const go = useGo();
  return (
    <div className="view-tabs">
      {(["account", "notifications", "members", "teams", "tokens", "integrations"] as const).map((page) => (
        <Button key={page} variant="tab" size="md" active={current === page} onClick={() => void go.settings(page)}>
          {t(`settings.tabs.${page}`)}
        </Button>
      ))}
    </div>
  );
}

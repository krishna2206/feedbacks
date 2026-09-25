import type { NotificationKind } from "@feedbacks/schema/enums";
import { mutators } from "@feedbacks/schema/zero";
import { Icon, type IconName, toast } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { SettingsTabs } from "../settings/SettingsTabs";
import { ViewHeader } from "../ViewHeader";
import { NOTIFICATION_KINDS, useNotificationSettings } from "./data";
import "./notifications.css";

const KIND_ICON: Record<NotificationKind, IconName> = {
  mention: "chat",
  ticket_assigned: "user",
  ticket_status: "circleDashed",
  comment: "comment",
  ticket_from_my_message: "ticket",
  access_request: "key",
};

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
  );
}

/** Settings › Notifications: which kinds to receive, and opt-in browser notifications */
export function NotificationSettingsPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const zero = useZero();
  const { mutedKinds, browserEnabled } = useNotificationSettings();
  const save = (patch: { mutedKinds?: NotificationKind[]; browserEnabled?: boolean }) =>
    zero.mutate(
      mutators.notifications.updateSettings({
        organizationId: org.id,
        mutedKinds: patch.mutedKinds ?? mutedKinds,
        browserEnabled: patch.browserEnabled ?? browserEnabled,
        at: Date.now(),
      }),
    );
  const supported = typeof Notification !== "undefined";

  const toggleBrowser = async (on: boolean) => {
    if (on && supported && Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast({ tone: "error", title: t("settings.notifications.browserDenied") }, 6000);
        return;
      }
    }
    save({ browserEnabled: on });
  };

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="settings" size={14} />
          {t("settings.title")}
        </span>
        <SettingsTabs current="notifications" />
      </ViewHeader>
      <div className="settings-page">
        <div className="settings-inner">
          <h1>{t("settings.notifications.title")}</h1>
          <p>{t("settings.notifications.intro")}</p>

          <section className="settings-section">
            <h2>{t("settings.notifications.kindsTitle")}</h2>
            <div className="settings-card">
              {NOTIFICATION_KINDS.map((kind) => {
                const on = !mutedKinds.includes(kind);
                return (
                  <div key={kind} className="settings-row">
                    <Icon name={KIND_ICON[kind]} />
                    <div className="settings-row__text">
                      <div className="settings-row__label">{t(`settings.notifications.kinds.${kind}.label`)}</div>
                      <div className="settings-row__hint">{t(`settings.notifications.kinds.${kind}.hint`)}</div>
                    </div>
                    <Switch
                      checked={on}
                      label={t(`settings.notifications.kinds.${kind}.label`)}
                      onChange={(v) => save({ mutedKinds: v ? mutedKinds.filter((k) => k !== kind) : [...mutedKinds, kind] })}
                    />
                  </div>
                );
              })}
            </div>
            <p className="settings-note">{t("settings.notifications.dmNote")}</p>
          </section>

          <section className="settings-section">
            <h2>{t("settings.notifications.browserTitle")}</h2>
            <div className="settings-card">
              <div className="settings-row">
                <Icon name="bell" />
                <div className="settings-row__text">
                  <div className="settings-row__label">{t("settings.notifications.browserLabel")}</div>
                  <div className="settings-row__hint">
                    {supported ? t("settings.notifications.browserHint") : t("settings.notifications.browserUnsupported")}
                  </div>
                </div>
                <Switch
                  checked={browserEnabled && supported && Notification.permission === "granted"}
                  label={t("settings.notifications.browserLabel")}
                  onChange={(v) => void toggleBrowser(v)}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

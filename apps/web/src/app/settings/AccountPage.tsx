import { Button, Icon, toast } from "@feedbacks/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../../lib/auth-client";
import "../members.css";
import { ViewHeader } from "../ViewHeader";
import { SettingsTabs } from "./SettingsTabs";
import "./settings.css";

/** Settings › Account: who you are, and changing your password (other sessions are signed out). */
export function AccountPage() {
  const { t } = useTranslation();
  const session = authClient.useSession();
  const user = session.data?.user;
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.next !== form.confirm) return setError(t("account.mismatch"));
    setBusy(true);
    const r = await authClient.changePassword({
      currentPassword: form.current,
      newPassword: form.next,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (r.error) return setError(r.error.status === 400 ? t("account.wrongCurrent") : (r.error.message ?? "Error"));
    setForm({ current: "", next: "", confirm: "" });
    toast({ title: t("account.changed") });
  };

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="settings" size={14} />
          {t("settings.title")}
        </span>
        <SettingsTabs current="account" />
      </ViewHeader>
      <div className="settings">
        <div className="settings__inner">
          <section>
            <h2>{t("account.title")}</h2>
            <p className="settings__note settings__lead">{user ? `${user.name} · ${user.email}` : "…"}</p>
          </section>
          <section>
            <h2>{t("account.password")}</h2>
            <p className="settings__note settings__lead">{t("account.passwordIntro")}</p>
            <form className="account-form" onSubmit={submit}>
              <input
                className="input"
                type="password"
                required
                autoComplete="current-password"
                value={form.current}
                onChange={set("current")}
                placeholder={t("account.current")}
                aria-label={t("account.current")}
              />
              <input
                className="input"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={form.next}
                onChange={set("next")}
                placeholder={t("account.new")}
                aria-label={t("account.new")}
              />
              <input
                className="input"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={form.confirm}
                onChange={set("confirm")}
                placeholder={t("account.confirm")}
                aria-label={t("account.confirm")}
              />
              {error && (
                <div className="auth__error" role="alert">
                  {error}
                </div>
              )}
              <div>
                <Button variant="primary" type="submit" disabled={busy || !form.current || !form.next}>
                  {busy ? t("account.saving") : t("account.change")}
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}

import { Button } from "@feedbacks/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { getInstance } from "../lib/instance";
import { AuthLayout, Field } from "./AuthLayout";

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(true);

  useEffect(() => {
    void getInstance().then((i) => setEmailEnabled(i.emailEnabled));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await authClient.requestPasswordReset({ email, redirectTo: `${location.origin}/reset-password` });
    setBusy(false);
    setSent(true);
  };

  return (
    <AuthLayout title={t("auth.forgotTitle")} subtitle={t("auth.forgotSubtitle")}>
      {sent ? (
        <div className="auth__note" role="status">
          {t("auth.resetSent", { email })}
          {!emailEnabled && <p style={{ marginTop: 6 }}>{t("auth.resetNoSmtp")}</p>}
        </div>
      ) : (
        <form className="auth__form" onSubmit={submit}>
          <Field label={t("auth.email")}>
            <input
              className="input"
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.emailPlaceholder")}
            />
          </Field>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("auth.sendResetLink")}
          </Button>
        </form>
      )}
      <p className="auth__footer">
        <Link to="/login">{t("auth.backToSignIn")}</Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(token && !params.get("error") ? "idle" : "error");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setState("busy");
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setState(error ? "error" : "done");
  };

  return (
    <AuthLayout title={t("auth.resetTitle")}>
      {state === "done" && (
        <div className="auth__note" role="status">
          {t("auth.passwordUpdated")}
        </div>
      )}
      {state === "error" && (
        <div className="auth__error" role="alert">
          {t("auth.invalidToken")}
        </div>
      )}
      {(state === "idle" || state === "busy") && (
        <form className="auth__form" onSubmit={submit}>
          <Field label={t("auth.newPassword")}>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              autoFocus
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.passwordPlaceholder")}
            />
          </Field>
          <Button variant="primary" type="submit" disabled={state === "busy"}>
            {t("auth.updatePassword")}
          </Button>
        </form>
      )}
      <p className="auth__footer">
        <Link to="/login">{t("auth.backToSignIn")}</Link>
      </p>
    </AuthLayout>
  );
}

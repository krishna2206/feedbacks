import { Button } from "@feedbacks/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { getInstance, type InstanceInfo } from "../lib/instance";
import { AuthLayout, Field, GoogleButton } from "./AuthLayout";

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [instance, setInstance] = useState<InstanceInfo | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("error") ? t("auth.invitationOnly") : null,
  );

  useEffect(() => {
    void getInstance().then(setInstance);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) return setError(error.status === 403 ? t("auth.invitationOnly") : t("auth.invalidCredentials"));
    void navigate({ to: "/" });
  };

  return (
    <AuthLayout title={t("auth.signInTitle")} subtitle={t("auth.signInSubtitle")}>
      {instance?.googleEnabled && (
        <>
          <GoogleButton label={t("auth.continueWithGoogle")} callbackURL="/" />
          <div className="auth__divider">{t("common.or")}</div>
        </>
      )}
      <form className="auth__form" onSubmit={submit}>
        <Field label={t("auth.email")}>
          <input
            className="input"
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("auth.emailPlaceholder")}
          />
        </Field>
        <Field label={t("auth.password")} aside={<Link to="/forgot-password">{t("auth.forgotPassword")}</Link>}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && (
          <div className="auth__error" role="alert">
            {error}
          </div>
        )}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? t("auth.signingIn") : t("auth.signIn")}
        </Button>
      </form>
      {instance?.needsSetup && (
        <p className="auth__footer">
          <Link to="/setup">{t("setup.title")}</Link>
        </p>
      )}
    </AuthLayout>
  );
}

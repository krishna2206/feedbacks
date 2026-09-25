import { Button } from "@feedbacks/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { getInstance, refreshInstance } from "../lib/instance";
import { slugify } from "../lib/slug";
import { AuthLayout, Field } from "./AuthLayout";

/** First run of a fresh instance: create the owner account + the organization */
export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [ready, setReady] = useState<boolean | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    org: "",
    // Public deployments protect setup with SETUP_TOKEN; the link can carry it as ?token=…
    token: new URLSearchParams(window.location.search).get("token") ?? "",
  });
  const [tokenRequired, setTokenRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getInstance().then((i) => {
      setReady(i.needsSetup);
      setTokenRequired(i.setupTokenRequired);
    });
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const info = await refreshInstance();
    const fetchOptions = form.token ? { headers: { "x-setup-token": form.token.trim() } } : undefined;
    // Account (skipped if the owner already created it and setup was interrupted)
    if (!info.hasUsers) {
      const r = await authClient.signUp.email({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        fetchOptions,
      });
      if (r.error)
        return setBusy(false), setError(r.error.status === 403 && tokenRequired ? t("setup.invalidToken") : (r.error.message ?? "Error"));
    } else {
      const r = await authClient.signIn.email({ email: form.email.trim(), password: form.password });
      if (r.error) return setBusy(false), setError(t("auth.invalidCredentials"));
    }
    const slug = slugify(form.org);
    const org = await authClient.organization.create({ name: form.org.trim(), slug, fetchOptions });
    if (org.error)
      return setBusy(false), setError(org.error.status === 403 && tokenRequired ? t("setup.invalidToken") : (org.error.message ?? "Error"));
    await authClient.organization.setActive({ organizationId: org.data.id });
    await refreshInstance();
    void navigate({ to: "/$orgSlug", params: { orgSlug: slug } });
  };

  if (ready === false)
    return (
      <AuthLayout title={t("setup.title")} subtitle={t("setup.alreadyDone")}>
        <p className="auth__footer">
          <Link to="/login">{t("auth.backToSignIn")}</Link>
        </p>
      </AuthLayout>
    );

  return (
    <AuthLayout title={t("setup.title")} subtitle={t("setup.subtitle")} wide>
      <form className="auth__form" onSubmit={submit}>
        {tokenRequired && (
          <Field label={t("setup.token")}>
            <input
              className="input"
              required
              autoComplete="off"
              spellCheck={false}
              value={form.token}
              onChange={set("token")}
              placeholder={t("setup.tokenPlaceholder")}
            />
          </Field>
        )}
        <div className="auth__section">{t("setup.yourAccount")}</div>
        <Field label={t("auth.name")}>
          <input className="input" required autoFocus autoComplete="name" value={form.name} onChange={set("name")} />
        </Field>
        <Field label={t("auth.email")}>
          <input
            className="input"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={set("email")}
            placeholder={t("auth.emailPlaceholder")}
          />
        </Field>
        <Field label={t("auth.password")}>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
            placeholder={t("auth.passwordPlaceholder")}
          />
        </Field>
        <div className="auth__section">{t("setup.organization")}</div>
        <Field label={t("setup.orgName")}>
          <input className="input" required value={form.org} onChange={set("org")} placeholder={t("setup.orgNamePlaceholder")} />
        </Field>
        {error && (
          <div className="auth__error" role="alert">
            {error}
          </div>
        )}
        <Button variant="primary" type="submit" disabled={busy || ready === null}>
          {busy ? t("setup.submitting") : t("setup.submit")}
        </Button>
      </form>
    </AuthLayout>
  );
}

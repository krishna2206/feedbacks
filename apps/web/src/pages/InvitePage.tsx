import { Button } from "@feedbacks/ui";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { AuthLayout, Field } from "./AuthLayout";

interface InvitationPreview {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expired: boolean;
  organizationName: string;
  inviterName: string;
  accountExists: boolean;
}

export function InvitePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { invitationId } = useParams({ from: "/invite/$invitationId" });
  const [inv, setInv] = useState<InvitationPreview | null | "invalid">(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/invitations/${invitationId}`).then(async (r) => {
      const data = r.ok ? ((await r.json()) as InvitationPreview) : null;
      setInv(data && data.status === "pending" && !data.expired ? data : "invalid");
    });
  }, [invitationId]);

  if (inv === null) return <AuthLayout title={t("common.loading")}>{null}</AuthLayout>;
  if (inv === "invalid")
    return (
      <AuthLayout title={t("invite.invalid")}>
        <p className="auth__footer">
          <Link to="/login">{t("auth.backToSignIn")}</Link>
        </p>
      </AuthLayout>
    );

  const role = t(`invite.roles.${inv.role ?? "member"}`, { defaultValue: inv.role ?? "member" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = inv.accountExists
      ? await authClient.signIn.email({ email: inv.email, password })
      : await authClient.signUp.email({ email: inv.email, name: name.trim(), password });
    if (r.error) return setBusy(false), setError(inv.accountExists ? t("auth.invalidCredentials") : (r.error.message ?? "Error"));
    const accepted = await authClient.organization.acceptInvitation({ invitationId: inv.id });
    if (accepted.error) return setBusy(false), setError(accepted.error.message ?? "Error");
    const orgs = await authClient.organization.list();
    const org = orgs.data?.find((o) => o.id === accepted.data?.invitation.organizationId);
    if (org) await authClient.organization.setActive({ organizationId: org.id });
    void navigate(org ? { to: "/$orgSlug", params: { orgSlug: org.slug } } : { to: "/" });
  };

  return (
    <AuthLayout
      title={t("invite.title", { org: inv.organizationName })}
      subtitle={`${t("invite.subtitle", { inviter: inv.inviterName, role })} ${inv.accountExists ? t("invite.signInToAccept", { email: inv.email }) : t("invite.createAccount")}`}
    >
      <form className="auth__form" onSubmit={submit}>
        <Field label={t("auth.email")}>
          <input className="input" type="email" readOnly value={inv.email} />
        </Field>
        {!inv.accountExists && (
          <Field label={t("auth.name")}>
            <input className="input" required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <Field label={t("auth.password")}>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            autoFocus={inv.accountExists}
            autoComplete={inv.accountExists ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={inv.accountExists ? undefined : t("auth.passwordPlaceholder")}
          />
        </Field>
        {error && (
          <div className="auth__error" role="alert">
            {error}
          </div>
        )}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? t("invite.joining") : t("invite.accept", { org: inv.organizationName })}
        </Button>
      </form>
    </AuthLayout>
  );
}

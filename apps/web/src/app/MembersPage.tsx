import { queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, timeAgo, toast } from "@feedbacks/ui";
import { useQuery } from "@rocicorp/zero/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { getInstance } from "../lib/instance";
import "./members.css";
import { useOrg } from "./org-context";
import { ViewHeader } from "./ViewHeader";

type Invitation = { id: string; email: string; role: string; status: string; expiresAt: Date | string };
const inviteLink = (id: string) => `${location.origin}/invite/${id}`;

/** Members & invitations. Owners/admins invite by email; without SMTP they copy the link. */
export function MembersPage() {
  const { t, i18n } = useTranslation();
  const { org, user } = useOrg();
  const [orgs] = useQuery(queries.orgs.mine());
  const members = orgs.find((o) => o.id === org.id)?.members ?? [];
  const myRole = members.find((m) => m.userId === user.id)?.role ?? "member";
  const canInvite = myRole === "owner" || myRole === "admin";

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Invitation[]>([]);
  const [last, setLast] = useState<{ id: string; email: string } | null>(null);
  const [emailEnabled, setEmailEnabled] = useState(false);

  const load = useCallback(async () => {
    if (!canInvite) return;
    const { data } = await authClient.organization.listInvitations({ query: { organizationId: org.id } });
    setPending(((data ?? []) as Invitation[]).filter((i) => i.status === "pending"));
  }, [canInvite, org.id]);

  useEffect(() => {
    void load();
    void getInstance().then((i) => setEmailEnabled(i.emailEnabled));
  }, [load]);

  const copy = async (id: string) => {
    await navigator.clipboard.writeText(inviteLink(id));
    toast({ title: t("members.linkCopied") });
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await authClient.organization.inviteMember({ email: email.trim(), role, organizationId: org.id, resend: true });
    setBusy(false);
    if (error || !data) return toast({ title: error?.message ?? "Error" });
    setLast({ id: data.id, email: data.email });
    setEmail("");
    toast({
      title: t("members.inviteSent"),
      description: emailEnabled ? t("members.inviteSentEmail", { email: data.email }) : t("members.inviteSentNoEmail"),
    });
    void load();
  };

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="users" size={14} />
          {t("members.title")}
        </span>
      </ViewHeader>
      <div className="settings">
        <div className="settings__inner">
          <section>
            <h2>{t("members.invite")}</h2>
            {canInvite ? (
              <>
                <form className="invite-form" onSubmit={invite}>
                  <input
                    className="input"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("members.invitePlaceholder")}
                  />
                  <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")} aria-label={t("members.role")}>
                    <option value="member">{t("invite.roles.member")}</option>
                    <option value="admin">{t("invite.roles.admin")}</option>
                  </select>
                  <Button variant="primary" type="submit" disabled={busy}>
                    {t("members.invite")}
                  </Button>
                </form>
                {last && (
                  <div className="invite-result">
                    <span>{last.email}</span>
                    <code>{inviteLink(last.id)}</code>
                    <Button size="sm" variant="secondary" icon={<Icon name="copy" size={14} />} onClick={() => copy(last.id)}>
                      {t("members.copyLink")}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p className="settings__note">{t("members.onlyAdmins")}</p>
            )}
          </section>

          {canInvite && (
            <section>
              <h2>{t("members.pending")}</h2>
              {pending.length === 0 ? (
                <p className="settings__note">{t("members.noPending")}</p>
              ) : (
                <div className="people">
                  {pending.map((inv) => (
                    <div key={inv.id} className="person">
                      <Avatar user={{ name: inv.email }} size={24} />
                      <div className="person__main">
                        <span className="person__name">{inv.email}</span>
                        <span className="person__sub">
                          {t("members.expires", { when: timeAgo(new Date(inv.expiresAt).getTime(), i18n.language) })}
                        </span>
                      </div>
                      <span className="role-chip">{t(`invite.roles.${inv.role}`, { defaultValue: inv.role })}</span>
                      <Button
                        size="sm"
                        variant="muted"
                        iconOnly
                        icon={<Icon name="copy" size={14} />}
                        onClick={() => copy(inv.id)}
                        aria-label={t("members.copyLink")}
                      />
                      <Button
                        size="sm"
                        variant="muted"
                        iconOnly
                        icon={<Icon name="x" size={14} />}
                        aria-label={t("members.cancel")}
                        onClick={async () => {
                          await authClient.organization.cancelInvitation({ invitationId: inv.id });
                          void load();
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section>
            <h2>{t("members.members", { count: members.length })}</h2>
            <div className="people">
              {members.map((m) => (
                <div key={m.id} className="person">
                  <Avatar user={m.user ?? null} size={24} />
                  <div className="person__main">
                    <span className="person__name">
                      {m.user?.name} {m.userId === user.id && <span className="muted">({t("members.you")})</span>}
                    </span>
                    <span className="person__sub">{m.user?.email}</span>
                  </div>
                  <span className="role-chip">{t(`invite.roles.${m.role}`, { defaultValue: m.role })}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

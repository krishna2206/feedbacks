import { Button, Icon, timeAgo, toast } from "@feedbacks/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../members.css";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { ViewHeader } from "../ViewHeader";
import { SettingsTabs } from "./SettingsTabs";
import "./settings.css";

/** One row of GET /api/tokens (see apps/api/src/routes/tokens.ts) */
type Token = {
  id: string;
  userId: string;
  userName: string;
  name: string;
  prefix: string;
  scope: "read" | "read-write";
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  expired: boolean;
};

const EXPIRY_DAYS = [30, 90, 365, 0] as const;

/**
 * Settings › API tokens: personal access tokens for the REST API, the CLI and MCP agents.
 * The secret is shown once; agents get exactly the access of the token's owner.
 */
export function TokensPage() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { isAdmin } = useOrgMembers();
  const [all, setAll] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Token["scope"]>("read-write");
  const [days, setDays] = useState<(typeof EXPIRY_DAYS)[number]>(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/tokens?organizationId=${encodeURIComponent(org.id)}${all ? "&all=1" : ""}`, {
      credentials: "same-origin",
    });
    if (res.ok) setTokens(((await res.json()) as { tokens: Token[] }).tokens);
  }, [org.id, all]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/tokens", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: org.id, name: name.trim(), scope, expiresInDays: days || null }),
    });
    setBusy(false);
    if (!res.ok) return toast({ tone: "error", title: t("tokens.createFailed") });
    const json = (await res.json()) as { token: string; name: string };
    setCreated({ token: json.token, name: json.name });
    setName("");
    void load();
  };

  const revoke = async (tk: Token) => {
    if (!confirm(t("tokens.revokeConfirm", { name: tk.name }))) return;
    const res = await fetch(`/api/tokens/${tk.id}`, { method: "DELETE", credentials: "same-origin" });
    if (!res.ok) return toast({ tone: "error", title: t("tokens.revokeFailed") });
    toast({ title: t("tokens.revoked", { name: tk.name }) });
    void load();
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast({ title: t("tokens.copied") });
  };

  const status = (tk: Token) => (tk.revokedAt ? t("tokens.statusRevoked") : tk.expired ? t("tokens.statusExpired") : null);

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="settings" size={14} />
          {t("settings.title")}
        </span>
        <SettingsTabs current="tokens" />
      </ViewHeader>
      <div className="settings">
        <div className="settings__inner">
          <section>
            <h2>{t("tokens.title")}</h2>
            <p className="settings__note settings__lead">{t("tokens.intro")}</p>
            <form className="invite-form token-form" onSubmit={create}>
              <input
                className="input"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("tokens.namePlaceholder")}
                aria-label={t("tokens.name")}
              />
              <select value={scope} onChange={(e) => setScope(e.target.value as Token["scope"])} aria-label={t("tokens.scope")}>
                <option value="read-write">{t("tokens.scopes.read-write")}</option>
                <option value="read">{t("tokens.scopes.read")}</option>
              </select>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value) as (typeof EXPIRY_DAYS)[number])}
                aria-label={t("tokens.expiry")}
              >
                {EXPIRY_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d ? t("tokens.expiresIn", { count: d }) : t("tokens.noExpiry")}
                  </option>
                ))}
              </select>
              <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
                {t("tokens.create")}
              </Button>
            </form>
            {created && (
              <div className="token-secret" role="status">
                <div className="token-secret__head">
                  <Icon name="key" size={14} />
                  <b>{t("tokens.secretTitle", { name: created.name })}</b>
                </div>
                <p>{t("tokens.secretOnce")}</p>
                <div className="invite-result">
                  <code>{created.token}</code>
                  <Button size="sm" variant="secondary" icon={<Icon name="copy" size={14} />} onClick={() => copy(created.token)}>
                    {t("tokens.copy")}
                  </Button>
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="settings__row">
              <h2>{all ? t("tokens.allTokens") : t("tokens.myTokens")}</h2>
              {isAdmin && (
                <Button size="sm" variant="tab" active={all} onClick={() => setAll(!all)}>
                  {t("tokens.showAll")}
                </Button>
              )}
            </div>
            {tokens.length === 0 ? (
              <p className="settings__note">{t("tokens.none")}</p>
            ) : (
              <div className="people">
                {tokens.map((tk) => (
                  <div key={tk.id} className="person" data-inactive={!!status(tk) || undefined}>
                    <Icon name="key" size={16} />
                    <div className="person__main">
                      <span className="person__name">
                        {tk.name} <code className="token-prefix">{tk.prefix}…</code>
                      </span>
                      <span className="person__sub">
                        {all && `${tk.userName} · `}
                        {t("tokens.createdAgo", { when: timeAgo(tk.createdAt, i18n.language) })}
                        {" · "}
                        {tk.lastUsedAt ? t("tokens.usedAgo", { when: timeAgo(tk.lastUsedAt, i18n.language) }) : t("tokens.neverUsed")}
                        {tk.expiresAt &&
                          !tk.revokedAt &&
                          !tk.expired &&
                          ` · ${t("tokens.expiresAt", { date: new Date(tk.expiresAt).toLocaleDateString(i18n.language) })}`}
                      </span>
                    </div>
                    <span className="role-chip">{status(tk) ?? t(`tokens.scopes.${tk.scope}`)}</span>
                    {!tk.revokedAt && (
                      <Button size="sm" variant="muted" onClick={() => revoke(tk)}>
                        {t("tokens.revoke")}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <p className="settings__note">{t("tokens.agentsNote")}</p>
        </div>
      </div>
    </>
  );
}

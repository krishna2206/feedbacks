import { Button, Icon, toast } from "@feedbacks/ui";
import { useTranslation } from "react-i18next";
import "../members.css";
import { useGo } from "../go";
import { ViewHeader } from "../ViewHeader";
import { SettingsTabs } from "./SettingsTabs";
import "./settings.css";

const REPO = "https://github.com/krishna2206/feedbacks";

function Snippet({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation();
  return (
    <div className="snippet">
      <div className="snippet__label">{label}</div>
      <div className="invite-result">
        <code>{text}</code>
        <Button
          size="sm"
          variant="secondary"
          iconOnly
          icon={<Icon name="copy" size={14} />}
          aria-label={t("tokens.copy")}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            toast({ title: t("tokens.copied") });
          }}
        />
      </div>
    </div>
  );
}

/** Settings › Integrations: ready-to-copy commands for the MCP server, the CLI, the Claude Code skill and the REST API */
export function IntegrationsPage() {
  const { t } = useTranslation();
  const go = useGo();
  const origin = location.origin;
  const token = "fbk_…";
  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="settings" size={14} />
          {t("settings.title")}
        </span>
        <SettingsTabs current="integrations" />
      </ViewHeader>
      <div className="settings">
        <div className="settings__inner">
          <section>
            <h2>{t("integrations.title")}</h2>
            <p className="settings__note settings__lead">{t("integrations.intro")}</p>
            <Button size="sm" variant="secondary" icon={<Icon name="key" size={14} />} onClick={() => void go.settings("tokens")}>
              {t("integrations.createToken")}
            </Button>
          </section>

          <section>
            <h2>{t("integrations.cliTitle")}</h2>
            <p className="settings__note settings__lead">{t("integrations.cliIntro")}</p>
            <Snippet label={t("integrations.cliInstall")} text="npm install -g @feedbacks/cli" />
            <Snippet label={t("integrations.cliLogin")} text={`feedbacks login --url ${origin} --token ${token}`} />
            <Snippet label={t("integrations.cliTry")} text="feedbacks messages list feedback --unprocessed --since 24h --json" />
          </section>

          <section>
            <h2>{t("integrations.mcpTitle")}</h2>
            <p className="settings__note settings__lead">{t("integrations.mcpIntro")}</p>
            <Snippet label={t("integrations.mcpUrl")} text={`${origin}/api/mcp`} />
            <Snippet
              label={t("integrations.mcpHttp")}
              text={`claude mcp add --transport http feedbacks ${origin}/api/mcp --header "Authorization: Bearer ${token}"`}
            />
            <Snippet
              label={t("integrations.mcpStdio")}
              text={`claude mcp add feedbacks --env FEEDBACKS_URL=${origin} --env FEEDBACKS_TOKEN=${token} -- npx -y @feedbacks/mcp`}
            />
          </section>

          <section>
            <h2>{t("integrations.skillTitle")}</h2>
            <p className="settings__note settings__lead">{t("integrations.skillIntro")}</p>
            <a className="settings__link" href={`${REPO}/tree/main/integrations/claude-code`} target="_blank" rel="noreferrer">
              <Icon name="external" size={14} />
              {t("integrations.skillLink")}
            </a>
          </section>

          <section>
            <h2>{t("integrations.apiTitle")}</h2>
            <p className="settings__note settings__lead">{t("integrations.apiIntro")}</p>
            <div className="settings__links">
              <a className="settings__link" href="/api/v1/reference" target="_blank" rel="noreferrer">
                <Icon name="external" size={14} />
                {t("integrations.apiReference")}
              </a>
              <a className="settings__link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
                <Icon name="external" size={14} />
                OpenAPI 3.1
              </a>
            </div>
            <Snippet label="curl" text={`curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/me`} />
          </section>
          <p className="settings__note">{t("tokens.agentsNote")}</p>
        </div>
      </div>
    </>
  );
}

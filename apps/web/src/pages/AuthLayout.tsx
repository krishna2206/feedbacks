import { Button, Icon, Menu, useMenu } from "@feedbacks/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, setLanguage } from "../i18n";
import "./auth.css";

export function AuthLayout({
  title,
  subtitle,
  wide,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const { i18n, t } = useTranslation();
  const menu = useMenu();
  return (
    <main className="auth">
      <div className="auth__lang">
        <Button variant="muted" size="md" icon={<Icon name="language" />} onClick={menu.toggleFrom} aria-label={t("nav.language")}>
          {LANGUAGES.find((l) => l.code === i18n.language)?.label}
        </Button>
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          placement="bottom-end"
          items={LANGUAGES.map((l) => ({
            id: l.code,
            label: l.label,
            checked: i18n.language === l.code,
            onSelect: () => setLanguage(l.code),
          }))}
        />
      </div>
      <div className={`auth__card${wide ? " auth__card--wide" : ""}`}>
        <img className="auth__logo" src="/favicon.svg" alt="" />
        <div>
          <h1 className="auth__title">{title}</h1>
          {subtitle && <p className="auth__subtitle">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}

export function Field({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is passed as a child
    <label className="field">
      <span className="field__label">
        {label}
        {aside}
      </span>
      {children}
    </label>
  );
}

export function GoogleButton({ label, callbackURL }: { label: string; callbackURL: string }) {
  return (
    <Button
      variant="secondary"
      icon={
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
          <path
            fill="#FFC107"
            d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"
          />
          <path
            fill="#FF3D00"
            d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
          />
          <path
            fill="#4CAF50"
            d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
          />
          <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
        </svg>
      }
      onClick={async () => {
        const { authClient } = await import("../lib/auth-client");
        await authClient.signIn.social({ provider: "google", callbackURL });
      }}
    >
      {label}
    </Button>
  );
}

import type { TicketStatus } from "@feedbacks/schema/enums";
import { queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, type IconName, Menu, type MenuEntry, shortDate, useMenu } from "@feedbacks/ui";
import { useQuery } from "@rocicorp/zero/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGo } from "../go";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { useProjects } from "../tickets/data";
import { ProjectBadge, TicketStatusIcon } from "../tickets/meta";
import { ViewHeader } from "../ViewHeader";
import { type SearchFilters, type SearchResult, useServerSearch } from "./client";
import { Highlighted } from "./Highlighted";
import type { SearchParams } from "./params";
import "./search.css";

const DAYS = { "7d": 7, "30d": 30, "365d": 365 } as const;
const KIND_ICON: Record<SearchResult["kind"], IconName> = { message: "chat", ticket: "ticket", comment: "comment", doc: "doc" };

/** Full-text search over messages, tickets, comments and documents, with filters (permission-filtered by the API) */
export function SearchPage() {
  const { t } = useTranslation();
  const { org, user } = useOrg();
  const params = useSearch({ from: "/$orgSlug/search" });
  const navigate = useNavigate({ from: "/$orgSlug/search" });
  const [text, setText] = useState(params.q ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the URL in sync (replace: typing doesn't pile up history entries)
  const setParams = (patch: Partial<SearchParams>) => void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the typed text drives the URL update
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((params.q ?? "") !== text) setParams({ q: text || undefined });
    }, 250);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => inputRef.current?.focus(), []);

  const filters: SearchFilters = useMemo(
    () => ({
      types: params.type ? [params.type] : undefined,
      channelId: params.channel,
      projectId: params.project,
      authorId: params.author,
      // Rounded to the hour: stable filters, so the debounced search doesn't restart every render
      from: params.range ? Math.floor((Date.now() - DAYS[params.range] * 86_400_000) / 3_600_000) * 3_600_000 : undefined,
      limit: 50,
    }),
    [params.type, params.channel, params.project, params.author, params.range],
  );
  const search = useServerSearch(org.id, text, filters, 150);

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="search" size={14} />
          {t("search.title")}
        </span>
      </ViewHeader>
      <div className="search-page">
        <div className="search-inner">
          <div className="search-box">
            <Icon name="search" />
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              spellCheck={false}
            />
            {search.loading && <span className="search-spinner" aria-hidden />}
            {text && (
              <Button
                variant="muted"
                size="sm"
                iconOnly
                icon={<Icon name="x" size={14} />}
                onClick={() => setText("")}
                aria-label={t("search.clear")}
              />
            )}
          </div>

          <div className="search-filters">
            <div className="search-types" role="tablist">
              {([undefined, "message", "ticket", "comment", "doc"] as const).map((k) => (
                <Button
                  key={k ?? "all"}
                  variant="tab"
                  size="sm"
                  active={params.type === k}
                  role="tab"
                  onClick={() => setParams({ type: k })}
                >
                  {t(`search.types.${k ?? "all"}`)}
                </Button>
              ))}
            </div>
            <span className="spacer" />
            <ChannelFilter value={params.channel} onChange={(channel) => setParams({ channel })} />
            <ProjectFilter value={params.project} onChange={(project) => setParams({ project })} />
            <AuthorFilter value={params.author} me={user.id} onChange={(author) => setParams({ author })} />
            <RangeFilter value={params.range} onChange={(range) => setParams({ range })} />
          </div>

          <Results query={text.trim()} state={search} />
        </div>
      </div>
    </>
  );
}

function Results({ query, state }: { query: string; state: ReturnType<typeof useServerSearch> }) {
  const { t, i18n } = useTranslation();
  const go = useGo();
  if (!query)
    return (
      <div className="search-empty">
        <Icon name="search" size={20} />
        <p>{t("search.hint")}</p>
      </div>
    );
  if (state.error) return <div className="search-empty">{t("search.error")}</div>;
  if (!state.results.length)
    return <div className="search-empty">{state.loading ? t("common.loading") : t("search.noResults", { q: query })}</div>;
  return (
    <div className="search-results" aria-busy={state.loading}>
      <div className="search-count">{t("search.count", { count: state.results.length })}</div>
      {state.results.map((r) => {
        const open = () => {
          if (r.kind === "message" && r.channel) void go.channel(r.channel.id, r.entityId, r.parentId);
          else if (r.ticket) void go.ticket(r.ticket.key);
          else if (r.kind === "doc" && r.doc) void go.doc(r.doc.id);
        };
        const where =
          r.kind === "message" && r.channel
            ? r.channel.kind === "dm"
              ? t("notifications.directMessage")
              : `#${r.channel.name}`
            : r.kind === "doc"
              ? t("nav.docs")
              : r.project?.name;
        return (
          <button key={r.id} type="button" className="search-row" onClick={open}>
            <span className="search-row__icon">
              {r.ticket && r.kind === "ticket" ? (
                <TicketStatusIcon status={r.ticket.status as TicketStatus} size={16} />
              ) : (
                <Icon name={KIND_ICON[r.kind]} />
              )}
            </span>
            <span className="search-row__main">
              <span className="search-row__title">
                {r.ticket && <span className="search-row__key">{r.ticket.key}</span>}
                <span className="truncate">
                  {r.kind === "message" ? (
                    <>
                      {r.author?.name ?? "?"} <span className="search-row__muted">{t("search.in", { where })}</span>
                    </>
                  ) : (
                    <Highlighted text={r.title || r.ticket?.title || r.doc?.title || ""} />
                  )}
                </span>
              </span>
              {r.snippet && (
                <span className="search-row__snippet">
                  {r.kind === "comment" && (
                    <span className="search-row__muted">{t("search.commentBy", { name: r.author?.name ?? "?" })} </span>
                  )}
                  <Highlighted text={r.snippet} />
                </span>
              )}
            </span>
            <span className="search-row__meta">
              {r.kind !== "message" && r.project && <ProjectBadge project={r.project} size={14} />}
              {shortDate(r.createdAt, i18n.language)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- Filters ----------------------------- */

function FilterChip({
  label,
  active,
  onClear,
  menu,
}: {
  label: string;
  active: boolean;
  onClear: () => void;
  menu: (a: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  return (
    <span className="search-chip" data-active={active || undefined}>
      <button type="button" className="search-chip__main" onClick={(e) => menu(e.currentTarget)}>
        {label}
        <Icon name="chevronDown" size={12} />
      </button>
      {active && (
        <button type="button" className="search-chip__clear" onClick={onClear} aria-label={t("search.clearFilter")}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

function PickerFilter({
  label,
  valueLabel,
  value,
  entries,
  placeholder,
  onChange,
}: {
  label: string;
  valueLabel?: string;
  value?: string;
  entries: MenuEntry[];
  placeholder: string;
  onChange: (v: string | undefined) => void;
}) {
  const m = useMenu();
  return (
    <>
      <FilterChip
        label={value ? (valueLabel ?? label) : label}
        active={!!value}
        onClear={() => onChange(undefined)}
        menu={(a) => m.openFrom(a)}
      />
      <Menu anchor={m.anchor} onClose={m.close} filterPlaceholder={placeholder} items={entries} width={240} />
    </>
  );
}

function ChannelFilter({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [channels] = useQuery(queries.channels.mine({ organizationId: org.id }));
  const entries: MenuEntry[] = channels.map((c) => ({
    id: c.id,
    label: c.name,
    icon: <Icon name={c.kind === "private" ? "lock" : "hash"} size={14} />,
    checked: value === c.id,
    onSelect: () => onChange(c.id),
  }));
  const current = channels.find((c) => c.id === value);
  return (
    <PickerFilter
      label={t("search.filters.channel")}
      valueLabel={current ? `#${current.name}` : undefined}
      value={value}
      entries={entries}
      placeholder={t("search.filters.channel")}
      onChange={onChange}
    />
  );
}

function ProjectFilter({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const { t } = useTranslation();
  const projects = useProjects(true);
  const entries: MenuEntry[] = projects.map((p) => ({
    id: p.id,
    label: p.name,
    keywords: p.key,
    icon: <ProjectBadge project={p} />,
    checked: value === p.id,
    onSelect: () => onChange(p.id),
  }));
  return (
    <PickerFilter
      label={t("search.filters.project")}
      valueLabel={projects.find((p) => p.id === value)?.name}
      value={value}
      entries={entries}
      placeholder={t("search.filters.project")}
      onChange={onChange}
    />
  );
}

function AuthorFilter({ value, me, onChange }: { value?: string; me: string; onChange: (v?: string) => void }) {
  const { t } = useTranslation();
  const { sorted, users } = useOrgMembers();
  const entries: MenuEntry[] = [...sorted]
    .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : 0))
    .map((u) => ({
      id: u.id,
      label: u.id === me ? t("tickets.me", { name: u.name }) : u.name,
      icon: <Avatar user={u} size={16} />,
      checked: value === u.id,
      onSelect: () => onChange(u.id),
    }));
  return (
    <PickerFilter
      label={t("search.filters.author")}
      valueLabel={value ? users.get(value)?.name : undefined}
      value={value}
      entries={entries}
      placeholder={t("search.filters.author")}
      onChange={onChange}
    />
  );
}

function RangeFilter({ value, onChange }: { value?: SearchParams["range"]; onChange: (v?: SearchParams["range"]) => void }) {
  const { t } = useTranslation();
  const m = useMenu();
  const entries: MenuEntry[] = (["7d", "30d", "365d"] as const).map((r) => ({
    id: r,
    label: t(`search.range.${r}`),
    checked: value === r,
    onSelect: () => onChange(r),
  }));
  return (
    <>
      <FilterChip
        label={value ? t(`search.range.${value}`) : t("search.filters.date")}
        active={!!value}
        onClear={() => onChange(undefined)}
        menu={(a) => m.openFrom(a)}
      />
      <Menu anchor={m.anchor} onClose={m.close} items={entries} width={200} />
    </>
  );
}

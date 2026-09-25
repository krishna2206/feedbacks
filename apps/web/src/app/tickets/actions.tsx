import type { TicketPriority, TicketStatus } from "@feedbacks/schema/enums";
import { newId } from "@feedbacks/schema/ids";
import { mutators } from "@feedbacks/schema/zero";
import { type Anchor, Icon, Menu, type MenuEntry, toast } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import type { OrgUser } from "../org-data";
import { useLabels } from "./data";
import type { TicketRow } from "./model";
import { assigneeEntries, labelEntries, priorityEntries, statusEntries } from "./pickers";

/** Ticket mutations with a toast when the server refuses (the optimistic change is rolled back by Zero) */
export function useTicketActions() {
  const zero = useZero();
  const { org } = useOrg();
  const { t } = useTranslation();
  const report = useCallback(
    (w: { server: Promise<{ type: string; error?: { message: string } }> }) =>
      void w.server.then((r) => {
        if (r.type === "error") toast({ tone: "error", title: t("tickets.updateFailed"), description: r.error?.message }, 6000);
      }),
    [t],
  );
  return useMemo(() => {
    const base = () => ({ organizationId: org.id, eventId: newId(), at: Date.now() });
    return {
      update: (
        ids: readonly string[],
        patch: { status?: TicketStatus; priority?: TicketPriority; assigneeId?: string | null; title?: string; description?: string },
      ) => {
        for (const ticketId of ids) report(zero.mutate(mutators.tickets.update({ ...base(), ticketId, ...patch })));
      },
      setLabels: (ticketId: string, labelIds: string[]) =>
        report(zero.mutate(mutators.tickets.setLabels({ ...base(), ticketId, labelIds }))),
      move: (ticketId: string, projectId: string) => report(zero.mutate(mutators.tickets.move({ ...base(), ticketId, projectId }))),
      linkMessages: (ticketId: string, messageIds: string[], force = false) =>
        zero.mutate(mutators.tickets.linkMessages({ ...base(), ticketId, messageIds, force })),
      unlinkMessage: (ticketId: string, messageId: string) =>
        report(zero.mutate(mutators.tickets.unlinkMessage({ ...base(), ticketId, messageId }))),
    };
  }, [zero, org.id, report]);
}

export type TicketMenuKind = "status" | "priority" | "assignee" | "labels" | "context";

/**
 * One menu at a time for a set of tickets (row buttons, keyboard s/p/a/l, bulk bar, right-click).
 * `tickets` resolves current values; `people` are the assignable members.
 */
export function useTicketMenus({
  tickets,
  people,
  keyOf,
}: {
  tickets: Map<string, TicketRow>;
  people: readonly OrgUser[];
  keyOf: (t: TicketRow) => string;
}) {
  const { t } = useTranslation();
  const { org, user } = useOrg();
  const navigate = useNavigate();
  const actions = useTicketActions();
  const { labels } = useLabels();
  const [state, setState] = useState<{ kind: TicketMenuKind; anchor: Anchor; ids: string[] } | null>(null);
  const open = useCallback((kind: TicketMenuKind, anchor: Anchor, ids: string[]) => setState({ kind, anchor, ids }), []);
  const close = useCallback(() => setState(null), []);

  let element: ReactNode = null;
  if (state) {
    const list = state.ids.map((id) => tickets.get(id)).filter((x): x is TicketRow => !!x);
    const single = list.length === 1 ? list[0] : undefined;
    const ids = list.map((x) => x.id);
    let items: MenuEntry[] = [];
    let placeholder: string | undefined;
    let keepOpen = false;
    if (state.kind === "status") {
      placeholder = t("tickets.changeStatus");
      items = statusEntries(t, single?.status, (status) => actions.update(ids, { status }));
    } else if (state.kind === "priority") {
      placeholder = t("tickets.changePriority");
      items = priorityEntries(t, single?.priority, (priority) => actions.update(ids, { priority }));
    } else if (state.kind === "assignee") {
      placeholder = t("tickets.assignTo");
      items = assigneeEntries(t, people, single?.assigneeId, user.id, (assigneeId) => actions.update(ids, { assigneeId }));
    } else if (state.kind === "labels") {
      placeholder = t("tickets.addLabels");
      keepOpen = true;
      // Toggle a label on every ticket: added if some ticket lacks it, removed otherwise
      const has = (x: TicketRow, id: string) => x.labels.some((l) => l.labelId === id);
      items = labelEntries(
        labels,
        labels.filter((l) => list.length && list.every((x) => has(x, l.id))).map((l) => l.id),
        (labelId) => {
          const addIt = !list.every((x) => has(x, labelId));
          for (const x of list) {
            const current = x.labels.map((l) => l.labelId);
            actions.setLabels(x.id, addIt ? [...new Set([...current, labelId])] : current.filter((l) => l !== labelId));
          }
        },
      );
    } else {
      const reopen = (kind: TicketMenuKind) => () => setTimeout(() => open(kind, state.anchor, state.ids), 0);
      items = [
        {
          id: "status",
          label: t("tickets.status.label"),
          icon: <Icon name="circleDashed" size={14} />,
          hint: "S",
          onSelect: reopen("status"),
        },
        {
          id: "priority",
          label: t("tickets.priorityLabel"),
          icon: <Icon name="sliders" size={14} />,
          hint: "P",
          onSelect: reopen("priority"),
        },
        { id: "assignee", label: t("tickets.assignee"), icon: <Icon name="user" size={14} />, hint: "A", onSelect: reopen("assignee") },
        { id: "labels", label: t("tickets.labels"), icon: <Icon name="tag" size={14} />, hint: "L", onSelect: reopen("labels") },
        ...(single
          ? [
              { kind: "separator" as const, id: "s1" },
              {
                id: "open",
                label: t("tickets.open"),
                icon: <Icon name="external" size={14} />,
                onSelect: () => void navigate({ to: "/$orgSlug/issue/$ref", params: { orgSlug: org.slug, ref: keyOf(single) } }),
              },
              {
                id: "copy",
                label: t("tickets.copyKey"),
                icon: <Icon name="copy" size={14} />,
                onSelect: () => {
                  void navigator.clipboard.writeText(keyOf(single));
                  toast({ title: t("tickets.keyCopied", { key: keyOf(single) }) });
                },
              },
            ]
          : []),
      ];
    }
    element = <Menu anchor={state.anchor} onClose={close} filterPlaceholder={placeholder} keepOpen={keepOpen} items={items} />;
  }
  return { open, close, element, isOpen: !!state };
}

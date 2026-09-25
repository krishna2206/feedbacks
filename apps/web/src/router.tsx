import { Toaster } from "@feedbacks/ui";
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from "@tanstack/react-router";
import { validateSearchParams } from "./app/search/params";
import { authClient } from "./lib/auth-client";
import { getInstance } from "./lib/instance";

/* Code-based routes. Every page is its own chunk; the Zero client only loads inside /$orgSlug. */

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster />
    </>
  ),
});

async function requireSession() {
  const { data } = await authClient.getSession();
  if (!data) {
    const instance = await getInstance();
    throw redirect({ to: instance.needsSetup ? "/setup" : "/login" });
  }
  return data;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    const session = await requireSession();
    const { data: orgs } = await authClient.organization.list();
    if (!orgs?.length) {
      const instance = await getInstance();
      throw redirect({ to: instance.needsSetup ? "/setup" : "/login" });
    }
    const active = orgs.find((o) => o.id === session.session.activeOrganizationId) ?? orgs[0];
    throw redirect({ to: "/$orgSlug", params: { orgSlug: active.slug } });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: lazyRouteComponent(() => import("./pages/LoginPage"), "LoginPage"),
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: lazyRouteComponent(() => import("./pages/SetupPage"), "SetupPage"),
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$invitationId",
  component: lazyRouteComponent(() => import("./pages/InvitePage"), "InvitePage"),
});
const forgotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: lazyRouteComponent(() => import("./pages/PasswordPages"), "ForgotPasswordPage"),
});
const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: lazyRouteComponent(() => import("./pages/PasswordPages"), "ResetPasswordPage"),
});

export const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$orgSlug",
  beforeLoad: async ({ params }) => {
    const session = await requireSession();
    const { data: orgs } = await authClient.organization.list();
    const org = orgs?.find((o) => o.slug === params.orgSlug);
    if (!org) throw redirect({ to: "/" });
    if (session.session.activeOrganizationId !== org.id) await authClient.organization.setActive({ organizationId: org.id });
    return { org: { id: org.id, slug: org.slug, name: org.name }, user: session.user };
  },
  component: lazyRouteComponent(() => import("./app/OrgLayout"), "OrgLayout"),
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./app/OrgHome"), "OrgHome"),
});
const channelRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/c/$channelId",
  // ?thread=<messageId> opens the thread panel, ?m=<messageId> scrolls to and highlights a message
  validateSearch: (s: Record<string, unknown>): { thread?: string; m?: string } => ({
    thread: typeof s.thread === "string" ? s.thread : undefined,
    m: typeof s.m === "string" ? s.m : undefined,
  }),
  component: lazyRouteComponent(() => import("./app/ChannelPage"), "ChannelPage"),
});
/** Full-text search (?q=&type=&channel=&project=&author=&range=) */
const searchRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/search",
  validateSearch: (s: Record<string, unknown>) => validateSearchParams(s),
  component: lazyRouteComponent(() => import("./app/search/SearchPage"), "SearchPage"),
});
const ticketsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/tickets",
  validateSearch: (s: Record<string, unknown>): { tab?: "created" | "reported" } => ({
    tab: s.tab === "created" || s.tab === "reported" ? s.tab : undefined,
  }),
  component: lazyRouteComponent(() => import("./app/tickets/TicketsPages"), "MyTicketsPage"),
});
const projectsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/projects",
  component: lazyRouteComponent(() => import("./app/tickets/ProjectsPages"), "ProjectsPage"),
});
const projectRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/projects/$projectKey",
  validateSearch: (s: Record<string, unknown>): { tab?: "active" | "backlog" } => ({
    tab: s.tab === "active" || s.tab === "backlog" ? s.tab : undefined,
  }),
  component: lazyRouteComponent(() => import("./app/tickets/TicketsPages"), "ProjectPage"),
});
const projectSettingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/projects/$projectKey/settings",
  component: lazyRouteComponent(() => import("./app/tickets/ProjectsPages"), "ProjectSettingsPage"),
});
/** A ticket by key (APP-12, former keys redirect) or by id */
const issueRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/issue/$ref",
  component: lazyRouteComponent(() => import("./app/tickets/TicketPage"), "TicketPage"),
});
/* Knowledge base: root folder, a folder, a document (?edit to open the editor, ?history for versions), trash */
const docsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/docs",
  component: lazyRouteComponent(() => import("./app/docs/DocsPages"), "DocsRootPage"),
});
const docsFolderRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/docs/f/$folderId",
  component: lazyRouteComponent(() => import("./app/docs/DocsPages"), "DocsFolderPage"),
});
const docsTrashRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/docs/trash",
  component: lazyRouteComponent(() => import("./app/docs/DocsPages"), "DocsTrashPage"),
});
const docRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/docs/d/$docId",
  validateSearch: (s: Record<string, unknown>): { edit?: boolean; history?: boolean } => ({
    edit: s.edit === true || s.edit === "true" || s.edit === "1" ? true : undefined,
    history: s.history === true || s.history === "true" || s.history === "1" ? true : undefined,
  }),
  component: lazyRouteComponent(() => import("./app/docs/DocPage"), "DocPage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$orgSlug/settings/notifications", params: { orgSlug: params.orgSlug } });
  },
});
const notificationSettingsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings/notifications",
  component: lazyRouteComponent(() => import("./app/notifications/NotificationSettingsPage"), "NotificationSettingsPage"),
});
const teamsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings/teams",
  component: lazyRouteComponent(() => import("./app/settings/TeamsPage"), "TeamsPage"),
});
const tokensRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings/tokens",
  component: lazyRouteComponent(() => import("./app/settings/TokensPage"), "TokensPage"),
});
const integrationsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings/integrations",
  component: lazyRouteComponent(() => import("./app/settings/IntegrationsPage"), "IntegrationsPage"),
});
const membersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/settings/members",
  component: lazyRouteComponent(() => import("./app/MembersPage"), "MembersPage"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  setupRoute,
  inviteRoute,
  forgotRoute,
  resetRoute,
  orgRoute.addChildren([
    orgIndexRoute,
    channelRoute,
    searchRoute,
    ticketsRoute,
    projectsRoute,
    projectRoute,
    projectSettingsRoute,
    issueRoute,
    docsRoute,
    docsFolderRoute,
    docsTrashRoute,
    docRoute,
    settingsRoute,
    notificationSettingsRoute,
    membersRoute,
    teamsRoute,
    tokensRoute,
    integrationsRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

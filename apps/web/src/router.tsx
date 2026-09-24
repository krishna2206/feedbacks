import { Toaster } from "@feedbacks/ui";
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from "@tanstack/react-router";
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
  component: lazyRouteComponent(() => import("./app/ChannelPage"), "ChannelPage"),
});
const inboxRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/inbox",
  component: lazyRouteComponent(() => import("./app/Placeholder"), "InboxPlaceholder"),
});
const ticketsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/tickets",
  component: lazyRouteComponent(() => import("./app/Placeholder"), "TicketsPlaceholder"),
});
const docsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: "/docs",
  component: lazyRouteComponent(() => import("./app/Placeholder"), "DocsPlaceholder"),
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
  orgRoute.addChildren([orgIndexRoute, channelRoute, inboxRoute, ticketsRoute, docsRoute, membersRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Same origin as the app: /api/auth */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [organizationClient()],
});

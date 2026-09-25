export interface InstanceInfo {
  needsSetup: boolean;
  hasUsers: boolean;
  /** The instance requires SETUP_TOKEN to be created (public deployments) */
  setupTokenRequired: boolean;
  googleEnabled: boolean;
  emailEnabled: boolean;
}

let cached: Promise<InstanceInfo> | null = null;

/** Instance status (cached per page load; call `refreshInstance()` after setup) */
export function getInstance(): Promise<InstanceInfo> {
  cached ??= fetch("/api/instance").then((r) => r.json() as Promise<InstanceInfo>);
  return cached;
}

export function refreshInstance() {
  cached = null;
  return getInstance();
}

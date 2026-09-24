/** Context passed to every query and mutator. Built server-side from the Better Auth session. */
export type ZeroContext = {
  userID: string;
};

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    context: ZeroContext;
  }
}

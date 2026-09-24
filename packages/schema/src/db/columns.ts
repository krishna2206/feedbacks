import { timestamp } from "drizzle-orm/pg-core";

/** All timestamps are `timestamptz`. Zero exposes them to clients as epoch milliseconds. */
export const timestampTz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

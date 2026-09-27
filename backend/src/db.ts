import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "./generated/prisma/client";

export type Db = PrismaClient;

export function createPrisma(url = process.env.DATABASE_URL ?? "file:./db/app.db"): PrismaClient {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

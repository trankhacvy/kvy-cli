import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config.js";
import * as schema from "./schema.js";

// Single shared connection pool for the process. `max` kept modest — the
// server is a single app process at MVP (design §6.5); revisit once the
// Socket.IO cluster adapter ships.
const queryClient = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;

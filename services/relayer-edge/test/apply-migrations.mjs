import { applyD1Migrations, env } from "cloudflare:test";

const migrations = env.TEST_MIGRATIONS;
await applyD1Migrations(env.SANCTIONS_DB, Array.isArray(migrations) ? migrations : JSON.parse(migrations));

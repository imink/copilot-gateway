import { initEnv } from "./src/lib/env.ts";
import { initRepo } from "./src/repo/mod.ts";
import { D1Repo, type D1Database } from "./src/repo/d1.ts";
import { app } from "./src/app.ts";

interface Env {
  DB: D1Database;
  [key: string]: unknown;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

let initialized = false;

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (!initialized) {
      initEnv((n) => (env[n] as string) ?? "");
      initRepo(new D1Repo(env.DB));
      initialized = true;
    }
    return app.fetch(req, env, ctx);
  },
};

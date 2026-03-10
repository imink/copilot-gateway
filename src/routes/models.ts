// GET /v1/models, /api/models — proxy to Copilot models endpoint

import type { Context } from "hono";
import { copilotFetch } from "../lib/copilot.ts";
import { getGithubCredentials } from "../lib/github.ts";

export const models = async (c: Context) => {
  try {
    const { token: githubToken, accountType } = await getGithubCredentials();
    const resp = await copilotFetch(
      "/models",
      { method: "GET" },
      githubToken,
      accountType,
    );
    return new Response(resp.body, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

// POST /v1/embeddings — passthrough to Copilot

import type { Context } from "hono";
import { copilotFetch } from "../lib/copilot.ts";
import { getGithubCredentials } from "../lib/github.ts";

export const embeddings = async (c: Context) => {
  try {
    const body = await c.req.text();
    const { token: githubToken, accountType } = await getGithubCredentials();
    const resp = await copilotFetch(
      "/embeddings",
      { method: "POST", body },
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

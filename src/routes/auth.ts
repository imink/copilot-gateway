// Auth routes — ADMIN_KEY validation + GitHub Device Flow OAuth
// Supports login with ADMIN_KEY (full dashboard access) or API key (restricted)
// No sessions, no cookies. All auth via key in every request.

import type { Context } from "hono";
import {
  getGithubToken,
  getGlobalGithubUser,
  setGithubConnection,
  clearGithubConnection,
  type GitHubUser,
} from "../lib/github.ts";
import { getEnv } from "../lib/env.ts";
import { validateApiKey } from "../lib/api-keys.ts";
import { requireAdmin } from "../lib/auth-guard.ts";

// GitHub OAuth app client ID (same as Copilot extension)
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_SCOPES = "read:user";

/** POST /auth/login — validate ADMIN_KEY or API key */
export const authLogin = async (c: Context) => {
  try {
    const body = await c.req.json<{ key: string }>();
    const adminKey = getEnv("ADMIN_KEY");

    // ADMIN_KEY login
    if (adminKey && body.key === adminKey) {
      return c.json({ ok: true, isAdmin: true });
    }

    // API key login
    const result = await validateApiKey(body.key);
    if (result) {
      return c.json({
        ok: true,
        isAdmin: false,
        keyId: result.id,
        keyName: result.name,
        keyHint: body.key.slice(-4),
      });
    }

    return c.json({ error: "Invalid key" }, 401);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
};

/** POST /auth/logout — no-op (client clears localStorage) */
export const authLogout = (_c: Context) => {
  // Nothing to clean up server-side; client clears its own localStorage
  return _c.json({ ok: true });
};

/** GET /auth/github — start GitHub Device Flow */
export const authGithub = async (c: Context) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  try {
    const resp = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_SCOPES,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return c.json({ error: `GitHub error: ${text}` }, 502);
    }

    const data = (await resp.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    return c.json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** POST /auth/github/poll — poll for device flow completion */
export const authGithubPoll = async (c: Context) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  try {
    const body = await c.req.json<{ device_code: string }>();

    // Poll GitHub for access token
    const resp = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: body.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );

    const data = (await resp.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
      interval?: number;
    };

    if (data.error === "authorization_pending") {
      return c.json({ status: "pending" });
    }

    if (data.error === "slow_down") {
      return c.json({ status: "slow_down", interval: data.interval });
    }

    if (data.error) {
      return c.json(
        { status: "error", error: data.error_description ?? data.error },
        400,
      );
    }

    if (data.access_token) {
      // Fetch user info
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${data.access_token}`,
          accept: "application/json",
          "user-agent": "copilot-deno",
        },
      });

      let user: GitHubUser = {
        login: "unknown",
        avatar_url: "",
        name: null,
        id: 0,
      };
      if (userResp.ok) {
        user = (await userResp.json()) as GitHubUser;
      }

      // Store globally — no session needed
      await setGithubConnection(data.access_token, user);
      return c.json({ status: "complete", user });
    }

    return c.json({ status: "error", error: "Unknown response" }, 500);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

/** GET /auth/me — get current GitHub connection info */
export const authMe = async (c: Context) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const globalToken = await getGithubToken();
  const githubConnected = !!globalToken;
  let user = githubConnected ? await getGlobalGithubUser() : null;

  // If we have a token but no cached user info, fetch it from GitHub and cache
  if (githubConnected && !user) {
    try {
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${globalToken}`,
          accept: "application/json",
          "user-agent": "copilot-deno",
        },
      });
      if (userResp.ok) {
        user = (await userResp.json()) as GitHubUser;
        await setGithubConnection(globalToken, user);
      }
    } catch {
      // Ignore — user just stays null
    }
  }

  return c.json({
    authenticated: true,
    github_connected: githubConnected,
    user,
  });
};

/** POST /auth/github/disconnect — disconnect GitHub account */
export const authGithubDisconnect = async (c: Context) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  await clearGithubConnection();
  return c.json({ ok: true });
};

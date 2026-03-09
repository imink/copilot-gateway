// Shared auth guard — reusable across route handlers

import type { Context } from "hono";

/** Returns a 403 response if the caller is not logged in with ADMIN_KEY, or null if OK. */
export function requireAdmin(c: Context): Response | null {
  if (!c.get("isAdmin")) {
    return c.json({ error: "Dashboard key required" }, 403);
  }
  return null;
}

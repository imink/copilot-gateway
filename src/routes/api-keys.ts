// API key management routes

import type { Context } from "hono";
import { createApiKey, listApiKeys, deleteApiKey, rotateApiKey, type ApiKey } from "../lib/api-keys.ts";

function requireAdmin(c: Context): Response | null {
  if (!c.get("isAdmin")) {
    return c.json({ error: "Dashboard key required" }, 403);
  }
  return null;
}

function keyToJson(k: ApiKey) {
  return { id: k.id, name: k.name, key_hint: k.key.slice(-4), created_at: k.createdAt, last_used_at: k.lastUsedAt ?? null };
}

export const listKeys = (c: Context) => {
  const isAdmin = c.get("isAdmin");
  const apiKeyId = c.get("apiKeyId");

  return listApiKeys().then((keys) => {
    const visible = isAdmin ? keys : keys.filter((k) => k.id === apiKeyId);
    return c.json(visible.map(keyToJson));
  });
};

export const createKey = async (c: Context) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const body = await c.req.json<{ name?: string }>();
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }

  const key = await createApiKey(body.name);
  return c.json({ id: key.id, name: key.name, key: key.key, created_at: key.createdAt }, 201);
};

export const deleteKey = async (c: Context) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const id = c.req.param("id") ?? "";
  const deleted = await deleteApiKey(id);
  if (!deleted) return c.json({ error: "Key not found" }, 404);
  return c.json({ ok: true });
};

export const rotateKey = async (c: Context) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const id = c.req.param("id") ?? "";
  const key = await rotateApiKey(id);
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json({ id: key.id, name: key.name, key: key.key, created_at: key.createdAt });
};

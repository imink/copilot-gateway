import { assertEquals } from "@std/assert";
import { D1Repo, type D1Database } from "./d1.ts";
import type { GitHubAccount } from "./types.ts";

interface FakePreparedStatement {
  bind(...values: unknown[]): FakePreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
  run(): Promise<{ results: Record<string, unknown>[]; success: boolean; meta: Record<string, unknown> }>;
}

function missingAccountTypeError(message: string): Error {
  return new Error(message);
}

class LegacyGithubAccountsDb implements D1Database {
  private account: GitHubAccount | null = null;
  private activeId: number | null = null;

  prepare(query: string): FakePreparedStatement {
    const db = this;
    let boundValues: unknown[] = [];

    return {
      bind(...values: unknown[]) {
        boundValues = values;
        return this;
      },
      async first<T>() {
        if (query.includes("SELECT user_id, token, account_type")) {
          throw missingAccountTypeError("no such column: account_type");
        }
        if (query.includes("SELECT user_id, token, login, name, avatar_url FROM github_accounts WHERE user_id = ?")) {
          if (!db.account || db.account.user.id !== boundValues[0]) return null;
          return {
            user_id: db.account.user.id,
            token: db.account.token,
            login: db.account.user.login,
            name: db.account.user.name,
            avatar_url: db.account.user.avatar_url,
          } as T;
        }
        if (query.includes("SELECT value FROM config WHERE key = 'active_github_account'")) {
          return db.activeId == null ? null : { value: String(db.activeId) } as T;
        }
        return null;
      },
      async all<T>() {
        if (query.includes("SELECT user_id, token, account_type")) {
          throw missingAccountTypeError("no such column: account_type");
        }
        if (query.includes("SELECT user_id, token, login, name, avatar_url FROM github_accounts")) {
          return {
            results: db.account
              ? [{
                user_id: db.account.user.id,
                token: db.account.token,
                login: db.account.user.login,
                name: db.account.user.name,
                avatar_url: db.account.user.avatar_url,
              } as T]
              : [],
            success: true,
            meta: {},
          };
        }
        return { results: [], success: true, meta: {} };
      },
      async run() {
        if (query.includes("INSERT INTO github_accounts") && query.includes("account_type")) {
          throw missingAccountTypeError("table github_accounts has no column named account_type");
        }
        if (query.includes("INSERT INTO github_accounts")) {
          db.account = {
            token: String(boundValues[1]),
            accountType: "individual",
            user: {
              id: Number(boundValues[0]),
              login: String(boundValues[2]),
              name: boundValues[3] == null ? null : String(boundValues[3]),
              avatar_url: String(boundValues[4]),
            },
          };
        }
        if (query.includes("INSERT INTO config (key, value) VALUES ('active_github_account', ?)")) {
          db.activeId = Number(boundValues[0]);
        }
        return { results: [], success: true, meta: {} };
      },
    };
  }
}

Deno.test("D1 GitHub repo falls back when account_type migration is missing", async () => {
  const repo = new D1Repo(new LegacyGithubAccountsDb());
  const account: GitHubAccount = {
    token: "ghu_test",
    accountType: "business",
    user: {
      id: 42,
      login: "tester",
      name: "Test User",
      avatar_url: "https://example.com/avatar.png",
    },
  };

  await repo.github.saveAccount(account.user.id, account);
  await repo.github.setActiveId(account.user.id);

  assertEquals(await repo.github.getActiveId(), 42);
  assertEquals(await repo.github.getAccount(42), {
    ...account,
    accountType: "individual",
  });
  assertEquals(await repo.github.listAccounts(), [{
    ...account,
    accountType: "individual",
  }]);
});

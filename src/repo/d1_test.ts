import { assertEquals } from "@std/assert";
import { type D1Database, D1Repo } from "./d1.ts";
import type { GitHubAccount } from "./types.ts";

interface FakePreparedStatement {
  bind(...values: unknown[]): FakePreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<
    { results: T[]; success: boolean; meta: Record<string, unknown> }
  >;
  run(): Promise<
    {
      results: Record<string, unknown>[];
      success: boolean;
      meta: Record<string, unknown>;
    }
  >;
}

function missingAccountTypeError(message: string): Error {
  return new Error(message);
}

class LegacyGithubAccountsDb implements D1Database {
  private account: GitHubAccount | null = null;
  private activeId: number | null = null;

  prepare(query: string): FakePreparedStatement {
    let boundValues: unknown[] = [];
    const statement: FakePreparedStatement = {
      bind: (...values: unknown[]) => {
        boundValues = values;
        return statement;
      },
      first: <T>() => {
        if (query.includes("SELECT user_id, token, account_type")) {
          return Promise.reject(
            missingAccountTypeError("no such column: account_type"),
          );
        }
        if (
          query.includes(
            "SELECT user_id, token, login, name, avatar_url FROM github_accounts WHERE user_id = ?",
          )
        ) {
          if (!this.account || this.account.user.id !== boundValues[0]) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            user_id: this.account.user.id,
            token: this.account.token,
            login: this.account.user.login,
            name: this.account.user.name,
            avatar_url: this.account.user.avatar_url,
          } as T);
        }
        if (
          query.includes(
            "SELECT value FROM config WHERE key = 'active_github_account'",
          )
        ) {
          return Promise.resolve(
            this.activeId == null
              ? null
              : { value: String(this.activeId) } as T,
          );
        }
        return Promise.resolve(null);
      },
      all: <T>() => {
        if (query.includes("SELECT user_id, token, account_type")) {
          return Promise.reject(
            missingAccountTypeError("no such column: account_type"),
          );
        }
        if (
          query.includes(
            "SELECT user_id, token, login, name, avatar_url FROM github_accounts",
          )
        ) {
          return Promise.resolve({
            results: this.account
              ? [{
                user_id: this.account.user.id,
                token: this.account.token,
                login: this.account.user.login,
                name: this.account.user.name,
                avatar_url: this.account.user.avatar_url,
              } as T]
              : [],
            success: true,
            meta: {},
          });
        }
        return Promise.resolve({ results: [], success: true, meta: {} });
      },
      run: () => {
        if (
          query.includes("INSERT INTO github_accounts") &&
          query.includes("account_type")
        ) {
          return Promise.reject(
            missingAccountTypeError(
              "table github_accounts has no column named account_type",
            ),
          );
        }
        if (query.includes("INSERT INTO github_accounts")) {
          this.account = {
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
        if (
          query.includes(
            "INSERT INTO config (key, value) VALUES ('active_github_account', ?)",
          )
        ) {
          this.activeId = Number(boundValues[0]);
        }
        return Promise.resolve({ results: [], success: true, meta: {} });
      },
    };

    return statement;
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

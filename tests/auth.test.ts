import { describe, expect, it } from "vitest";
import {
  authenticatePassword,
  assertAuthConfig,
  createSessionToken,
  verifySessionToken,
  type AuthConfig,
} from "../src/auth";

const config: AuthConfig = {
  SQL_NORMAL_PASSWORD: "normal-password",
  SQL_ADMIN_PASSWORD: "admin-password",
  AUTH_SECRET: "a-secret-that-is-long-enough-for-hmac-tests-123456",
};

describe("authentication", () => {
  it("maps the two passwords to separate roles", async () => {
    await expect(authenticatePassword("normal-password", config)).resolves.toBe("normal");
    await expect(authenticatePassword("admin-password", config)).resolves.toBe("admin");
    await expect(authenticatePassword("wrong-password", config)).resolves.toBeNull();
  });

  it("rejects an unsafe credential configuration", () => {
    expect(() => assertAuthConfig({ ...config, SQL_NORMAL_PASSWORD: config.SQL_ADMIN_PASSWORD })).toThrow(
      "必须不同",
    );
    expect(() => assertAuthConfig({ ...config, AUTH_SECRET: "short" })).toThrow("至少包含 32");
  });

  it("signs, verifies, expires, and rejects a changed token", async () => {
    const now = Date.parse("2026-08-26T00:00:00.000Z");
    const session = await createSessionToken("admin", config.AUTH_SECRET as string, now, 60);
    await expect(verifySessionToken(session.token, config.AUTH_SECRET as string, now)).resolves.toMatchObject({
      role: "admin",
      exp: Math.floor(now / 1000) + 60,
    });
    await expect(verifySessionToken(session.token, config.AUTH_SECRET as string, now + 61_000)).resolves.toBeNull();

    const tampered = `${session.token.slice(0, -1)}${session.token.endsWith("a") ? "b" : "a"}`;
    await expect(verifySessionToken(tampered, config.AUTH_SECRET as string, now)).resolves.toBeNull();
  });
});

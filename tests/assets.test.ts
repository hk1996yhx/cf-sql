import { describe, expect, it } from "vitest";
import { addAssetSecurityHeaders } from "../src/index";

describe("asset response headers", () => {
  it("copies immutable asset headers before adding security headers", () => {
    const originalHeaders = new Headers({ "content-type": "image/x-icon" });
    originalHeaders.set = () => {
      throw new TypeError("Can't modify immutable headers.");
    };
    const immutableResponse = {
      body: null,
      headers: originalHeaders,
      status: 404,
      statusText: "Not Found",
    } as unknown as Response;

    const response = addAssetSecurityHeaders(immutableResponse);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

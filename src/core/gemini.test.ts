import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backoffMs,
  blockReasonMessage,
  buildGenerateBody,
  classify,
  failureShortLabel,
  finishReasonMessage,
  GeminiFatalError,
  GeminiHttpError,
  generateImage,
  parseGroundingMetadata,
  providerFailureMessage,
  validateApiKey,
} from "./gemini";
import type { GenerationRequest } from "./session";

// A 1x1 PNG (valid base64) reused across image-parse tests.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const sizer = async () => ({ width: 1, height: 1 });

function baseRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    modelId: "gemini-3.1-flash-image",
    size: "1K",
    prompt: "a banana",
    references: [],
    googleSearch: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function imageResponse(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        content: {
          parts: [
            { text: "here you go" },
            { text: "internal reasoning", thought: true },
            { inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 } },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 100,
      totalTokenCount: 110,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 100 }],
    },
    modelVersion: "gemini-3.1-flash-image-001",
    responseId: "resp-123",
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildGenerateBody", () => {
  it("puts references first (in order), then the text part, all camelCase", () => {
    const request = baseRequest({
      references: [
        { name: "a", mimeType: "image/png", blob: new Blob() },
        { name: "b", mimeType: "image/jpeg", blob: new Blob() },
      ],
      aspectRatio: "16:9",
    });
    const body = buildGenerateBody(request, ["AAA", "BBB"]);

    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "AAA" } },
      { inlineData: { mimeType: "image/jpeg", data: "BBB" } },
      { text: "a banana" },
    ]);
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE", "TEXT"]);
    expect(body.generationConfig.imageConfig).toEqual({ imageSize: "1K", aspectRatio: "16:9" });
  });

  it("omits tools unless googleSearch is set; omits aspectRatio when absent", () => {
    const without = buildGenerateBody(baseRequest(), []);
    expect(without.tools).toBeUndefined();
    expect(without.generationConfig.imageConfig).toEqual({ imageSize: "1K" });

    const withSearch = buildGenerateBody(baseRequest({ googleSearch: true }), []);
    expect(withSearch.tools).toEqual([{ googleSearch: {} }]);
  });
});

// Fixture matches the LIVE shape captured (2026-07-16) from a real grounded
// gemini-3.1-flash-image :generateContent response: searchEntryPoint.renderedContent is a
// self-contained HTML+CSS widget, groundingChunks[].web.{uri,title}, and webSearchQueries[].
const REAL_GROUNDING = {
  searchEntryPoint: {
    renderedContent:
      '<style>.container{display:flex}</style><div class="container"><a href="https://www.google.com/search?q=x">x</a></div>',
  },
  groundingChunks: [
    {
      web: {
        uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ_one",
        title: "weatherbug.com",
      },
    },
    {
      web: {
        uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ_two",
        title: "accuweather.com",
      },
    },
  ],
  webSearchQueries: ["current weather in London UK", "London weather now"],
};

describe("parseGroundingMetadata", () => {
  it("parses the live grounding shape into widget HTML, queries, and deduped sources", () => {
    const parsed = parseGroundingMetadata(REAL_GROUNDING);
    expect(parsed).toBeDefined();
    expect(parsed!.searchEntryPointHtml).toContain("<style>");
    expect(parsed!.webSearchQueries).toEqual(["current weather in London UK", "London weather now"]);
    expect(parsed!.sources).toEqual([
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ_one", title: "weatherbug.com" },
      { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ_two", title: "accuweather.com" },
    ]);
  });

  it("dedupes repeated source URIs and tolerates chunks with no web.uri", () => {
    const parsed = parseGroundingMetadata({
      webSearchQueries: ["q"],
      groundingChunks: [
        { web: { uri: "https://a.example/1", title: "A" } },
        { web: { uri: "https://a.example/1", title: "A again" } }, // duplicate uri
        { web: { title: "no uri" } }, // no uri → skipped
        { notWeb: {} }, // malformed → skipped
      ],
    });
    expect(parsed!.sources).toEqual([{ uri: "https://a.example/1", title: "A" }]);
  });

  it("returns undefined for absent / non-object / empty metadata", () => {
    expect(parseGroundingMetadata(undefined)).toBeUndefined();
    expect(parseGroundingMetadata(null)).toBeUndefined();
    expect(parseGroundingMetadata("nope")).toBeUndefined();
    expect(parseGroundingMetadata({})).toBeUndefined();
    expect(parseGroundingMetadata({ webSearchQueries: [], groundingChunks: [] })).toBeUndefined();
  });
});

describe("generateImage — grounding attribution", () => {
  it("attaches grounding when googleSearch is on and the response carries metadata", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(imageResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 } }] }, groundingMetadata: REAL_GROUNDING }] })),
    );
    const result = await generateImage(baseRequest({ googleSearch: true }), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("succeeded");
    expect(result.grounding).toBeDefined();
    expect(result.grounding!.sources).toHaveLength(2);
    expect(result.grounding!.webSearchQueries).toHaveLength(2);
  });

  it("does NOT surface grounding when the run did not request it (even if metadata is present)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(imageResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 } }] }, groundingMetadata: REAL_GROUNDING }] })),
    );
    const result = await generateImage(baseRequest({ googleSearch: false }), { apiKey: "k", imageSizer: sizer });
    expect(result.grounding).toBeUndefined();
  });
});

describe("generateImage — success path", () => {
  it("decodes an inlineData image to a Blob, filters thought text, computes usage/cost", async () => {
    fetchMock.mockResolvedValue(jsonResponse(imageResponse()));

    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });

    expect(result.status).toBe("succeeded");
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].blob.size).toBeGreaterThan(0);
    expect(result.images[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // "thought" text is excluded; only the real text part survives.
    expect(result.text).toEqual(["here you go"]);
    expect(result.usage?.imageOutputTokens).toBe(100);
    expect(result.cost.status).toBe("calculated");
    expect(result.cost.usd).toBeGreaterThan(0);
    expect(result.modelVersion).toBe("gemini-3.1-flash-image-001");
    expect(result.responseId).toBe("resp-123");
  });

  it("sends the key as x-goog-api-key header, never in the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(imageResponse()));
    await generateImage(baseRequest(), { apiKey: "secret-key", imageSizer: sizer });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("secret-key");
    expect(String(url)).toContain(
      "generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
    );
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "secret-key" });
    expect((init as RequestInit).method).toBe("POST");
  });
});

describe("generateImage — imageless / blocked responses", () => {
  it("returns a failed result with usage when the response carries no image", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(imageResponse({ candidates: [{ content: { parts: [{ text: "no image" }] } }] })),
    );
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/returned no image/i);
    expect(result.usage).toBeDefined(); // billed tokens still reported
  });

  it("maps a promptFeedback block to the specific human explanation (P15)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(finishReasonMessage("SAFETY"));
  });

  it("keeps the generic block copy for an UNKNOWN promptFeedback blockReason", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ promptFeedback: { blockReason: "SOME_NEW_REASON" } }));
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/blocked this request/i);
  });

  it("keeps the generic copy for blockReason OTHER (a different enum from finishReason OTHER)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ promptFeedback: { blockReason: "OTHER" } }));
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/blocked this request/i);
  });

  it("maps a candidate finishReason block (200, no image) to its human explanation and keeps usage", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [] }, finishReason: "PROHIBITED_CONTENT" }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 0, totalTokenCount: 12 },
        modelVersion: "v-block",
        responseId: "resp-block",
      }),
    );
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(finishReasonMessage("PROHIBITED_CONTENT"));
    expect(result.error).toMatch(/content policy/i);
    // A blocked 200 is still billed — usage/provenance must survive.
    expect(result.usage?.promptTokens).toBe(12);
    expect(result.modelVersion).toBe("v-block");
    expect(result.responseId).toBe("resp-block");
  });

  it("explains an imageless response through its finishReason (NO_IMAGE) when mapped", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        imageResponse({
          candidates: [{ content: { parts: [{ text: "chatty answer" }] }, finishReason: "NO_IMAGE" }],
        }),
      ),
    );
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("failed");
    expect(result.error).toBe(finishReasonMessage("NO_IMAGE"));
  });

  it("excludes 'thought' image parts and keeps only the real output image", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        imageResponse({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 }, thought: true },
                  { inlineData: { mimeType: "image/png", data: PNG_1X1_BASE64 } },
                ],
              },
            },
          ],
        }),
      ),
    );
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("succeeded");
    expect(result.images).toHaveLength(1); // the thought image is dropped
  });
});

describe("generateImage — errors, retry, abort", () => {
  it("throws GeminiFatalError on a 401 (bad key aborts the whole run)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { message: "API key not valid", status: "UNAUTHENTICATED" } },
        { status: 401, statusText: "Unauthorized" },
      ),
    );
    await expect(generateImage(baseRequest(), { apiKey: "bad", imageSizer: sizer })).rejects.toThrow(
      GeminiFatalError,
    );
  });

  it("does NOT retry a 400 — returns a failed result", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { message: "Invalid argument", status: "INVALID_ARGUMENT" } },
        { status: 400, statusText: "Bad Request" },
      ),
    );
    const result = await generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
    expect(result.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 honoring the server retryDelay, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                message: "rate limited",
                status: "RESOURCE_EXHAUSTED",
                details: [{ retryDelay: "1s" }],
              },
            },
            { status: 429, statusText: "Too Many Requests" },
          ),
        )
        .mockResolvedValueOnce(jsonResponse(imageResponse()));

      const promise = generateImage(baseRequest(), { apiKey: "k", imageSizer: sizer });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.status).toBe("succeeded");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns interrupted with 'not-submitted' when aborted before any request goes out", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateImage(baseRequest(), {
      apiKey: "k",
      signal: controller.signal,
      imageSizer: sizer,
    });
    expect(result.status).toBe("interrupted");
    expect(result.cancellation?.billing).toBe("not-submitted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns interrupted (not a rejection) when aborted DURING backoff, billing unknown", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            error: {
              message: "rate limited",
              status: "RESOURCE_EXHAUSTED",
              details: [{ retryDelay: "10s" }],
            },
          },
          { status: 429, statusText: "Too Many Requests" },
        ),
      );
      const promise = generateImage(baseRequest(), {
        apiKey: "k",
        signal: controller.signal,
        imageSizer: sizer,
      });
      // Let the first request fail and enter backoff, then abort mid-wait.
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      const result = await promise;
      expect(result.status).toBe("interrupted");
      expect(result.cancellation?.billing).toBe("unknown-may-be-charged");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("classify / backoffMs", () => {
  it("buckets errors: 401 fatal, 429 backoff, 400 fail, network fail", () => {
    expect(classify(new GeminiHttpError(401, "UNAUTHENTICATED", "x"))).toBe("fatal");
    expect(classify(new GeminiHttpError(403, "PERMISSION_DENIED", "x"))).toBe("fatal");
    expect(classify(new GeminiHttpError(404, "NOT_FOUND", "x"))).toBe("fatal");
    expect(classify(new GeminiHttpError(429, "RESOURCE_EXHAUSTED", "x"))).toBe("backoff");
    expect(classify(new GeminiHttpError(503, "UNAVAILABLE", "x"))).toBe("backoff");
    expect(classify(new GeminiHttpError(400, "INVALID_ARGUMENT", "x"))).toBe("fail");
    expect(classify(new GeminiHttpError(500, "INTERNAL", "x"))).toBe("fail");
    expect(classify(new TypeError("fetch failed"))).toBe("fail");
  });

  it("honors the server retry delay, else exponential, capped at 30s", () => {
    expect(backoffMs(new GeminiHttpError(429, "x", "y", 5000), 1)).toBe(5000);
    expect(backoffMs(new GeminiHttpError(429, "x", "y"), 1)).toBe(1000);
    expect(backoffMs(new GeminiHttpError(429, "x", "y"), 3)).toBe(4000);
    expect(backoffMs(new GeminiHttpError(429, "x", "y", 99_000), 1)).toBe(30_000);
  });
});

describe("validateApiKey", () => {
  it("intersects the returned model list with the 3-model allowlist", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        models: [
          { name: "models/gemini-3.1-flash-image" },
          { name: "models/gemini-3-pro-image" },
          { name: "models/gemini-2.5-flash" }, // not allowlisted
        ],
      }),
    );
    const { availableModels } = await validateApiKey("k");
    expect(availableModels).toEqual(["gemini-3.1-flash-image", "gemini-3-pro-image"]);
    // GET /models, key in header, not URL.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1beta/models?pageSize=1000");
    expect(String(url)).not.toContain("k\b");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "k" });
  });

  it("follows pagination via nextPageToken", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: "models/gemini-3.1-flash-image" }], nextPageToken: "p2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-3-pro-image" }] }));
    const { availableModels } = await validateApiKey("k");
    expect(availableModels).toEqual(["gemini-3.1-flash-image", "gemini-3-pro-image"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=p2");
  });

  it("throws GeminiFatalError when the list call fails with a credential error (bad key)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { message: "API key not valid", status: "INVALID_ARGUMENT" } },
        { status: 400, statusText: "Bad Request" },
      ),
    );
    await expect(validateApiKey("bad")).rejects.toThrow(GeminiFatalError);
  });

  it("does NOT brand the key invalid on a transient list failure (503 rethrows non-fatal)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { message: "overloaded", status: "UNAVAILABLE" } },
        { status: 503, statusText: "Service Unavailable" },
      ),
    );
    await expect(validateApiKey("k")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GeminiHttpError && !(error instanceof GeminiFatalError),
    );
  });
});

describe("providerFailureMessage", () => {
  it("maps each provider failure bucket to its user-facing copy", () => {
    expect(providerFailureMessage("HTTP 429 RESOURCE_EXHAUSTED")).toMatch(/rate limit/i);
    expect(providerFailureMessage("401 UNAUTHENTICATED")).toMatch(/rejected the credentials/i);
    expect(providerFailureMessage("the prompt was blocked by safety settings")).toMatch(
      /blocked this request/i,
    );
    expect(providerFailureMessage("fetch failed")).toMatch(/could not be reached/i);
    expect(providerFailureMessage("provider returned no image")).toMatch(/returned no image/i);
    expect(providerFailureMessage("weird")).toMatch(/could not be generated/i);
  });
});

describe("finishReasonMessage / failureShortLabel (P15)", () => {
  // Every Google enum value we map: [reason, message fragment, short label].
  const cases: Array<[string, RegExp, string]> = [
    ["SAFETY", /safety filters/i, "Blocked: safety filter"],
    ["IMAGE_SAFETY", /safety filters/i, "Blocked: safety filter"],
    ["PROHIBITED_CONTENT", /content policy/i, "Blocked: content policy"],
    ["IMAGE_PROHIBITED_CONTENT", /content policy/i, "Blocked: content policy"],
    ["RECITATION", /copyrighted work/i, "Blocked: copyrighted material"],
    ["IMAGE_RECITATION", /copyrighted work/i, "Blocked: copyrighted material"],
    ["SPII", /personal information/i, "Blocked: personal info"],
    ["BLOCKLIST", /blocklist/i, "Blocked: banned terms"],
    ["MODEL_ARMOR", /Model Armor/, "Blocked: security filter"],
    ["JAILBREAK", /bypass its safety rules/i, "Blocked: jailbreak filter"],
    ["LANGUAGE", /unsupported language/i, "Unsupported language"],
    ["NO_IMAGE", /without producing an image/i, "No image returned"],
    ["MAX_TOKENS", /output limit/i, "Hit output limit"],
    ["OTHER", /without a usable result/i, "Provider error"],
    ["IMAGE_OTHER", /without a usable result/i, "Provider error"],
    ["MALFORMED_FUNCTION_CALL", /without a usable result/i, "Provider error"],
    ["UNEXPECTED_TOOL_CALL", /without a usable result/i, "Provider error"],
    ["TOO_MANY_TOOL_CALLS", /without a usable result/i, "Provider error"],
    ["MISSING_THOUGHT_SIGNATURE", /without a usable result/i, "Provider error"],
    ["MALFORMED_RESPONSE", /without a usable result/i, "Provider error"],
  ];

  it.each(cases)("%s maps to specific copy + a short label", (reason, fragment, short) => {
    const message = finishReasonMessage(reason);
    expect(message).toMatch(fragment);
    expect(failureShortLabel(message)).toBe(short);
  });

  it("returns undefined for STOP / unknown reasons (generic fallback stays in charge)", () => {
    expect(finishReasonMessage("STOP")).toBeUndefined();
    expect(finishReasonMessage("FINISH_REASON_UNSPECIFIED")).toBeUndefined();
    expect(finishReasonMessage("SOME_NEW_REASON")).toBeUndefined();
    expect(finishReasonMessage(undefined)).toBeUndefined();
  });

  it("maps only meaning-compatible blockReason values (OTHER stays generic)", () => {
    expect(blockReasonMessage("SAFETY")).toBe(finishReasonMessage("SAFETY"));
    expect(blockReasonMessage("PROHIBITED_CONTENT")).toBe(finishReasonMessage("PROHIBITED_CONTENT"));
    expect(blockReasonMessage("OTHER")).toBeUndefined();
    expect(blockReasonMessage("RECITATION")).toBeUndefined(); // not a blockReason value
    expect(blockReasonMessage(undefined)).toBeUndefined();
  });

  it("gives no short label for non-mapped failure copy", () => {
    expect(failureShortLabel("The provider blocked this request. Edit the subject or references and regenerate.")).toBeUndefined();
    expect(failureShortLabel(undefined)).toBeUndefined();
    expect(failureShortLabel("")).toBeUndefined();
  });
});

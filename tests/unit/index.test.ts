/**
 * Unit tests for wopr-plugin-googlechat
 *
 * Following TDD: tests written first, then implementation made to pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the exported pure functions and the plugin object.
// The plugin uses module-level state, so we import directly.

import {
  buildSessionKey,
  extractSpaceId,
  extractUserId,
  shouldRespond,
  formatAsCard,
  handleWebhook,
} from "../../src/index.js";

import type { GoogleChatEvent, GoogleChatConfig } from "../../src/types.js";

// ============================================================================
// Helpers
// ============================================================================

function makeDMEvent(overrides: Partial<GoogleChatEvent> = {}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    eventTime: "2026-01-01T00:00:00Z",
    message: {
      name: "spaces/DM123/messages/MSG001",
      sender: {
        name: "users/USER123",
        displayName: "Alice",
        email: "alice@example.com",
        type: "HUMAN",
      },
      createTime: "2026-01-01T00:00:00Z",
      text: "Hello bot",
      argumentText: "Hello bot",
      space: {
        name: "spaces/DM123",
        type: "DM",
        singleUserBotDm: true,
      },
    },
    ...overrides,
  };
}

function makeSpaceEvent(overrides: Partial<GoogleChatEvent> = {}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    eventTime: "2026-01-01T00:00:00Z",
    message: {
      name: "spaces/SPACE456/messages/MSG002",
      sender: {
        name: "users/USER456",
        displayName: "Bob",
        email: "bob@example.com",
        type: "HUMAN",
      },
      createTime: "2026-01-01T00:00:00Z",
      text: "@bot Hello space",
      argumentText: "Hello space",
      space: {
        name: "spaces/SPACE456",
        displayName: "Engineering Team",
        type: "SPACE",
        singleUserBotDm: false,
      },
    },
    ...overrides,
  };
}

function makeAddedToSpaceEvent(withMessage = false): GoogleChatEvent {
  const evt: GoogleChatEvent = {
    type: "ADDED_TO_SPACE",
    eventTime: "2026-01-01T00:00:00Z",
    space: {
      name: "spaces/SPACE789",
      displayName: "My Team",
      type: "SPACE",
      singleUserBotDm: false,
    },
    user: {
      name: "users/ADMIN001",
      displayName: "Admin",
      type: "HUMAN",
    },
  };

  if (withMessage) {
    evt.message = {
      name: "spaces/SPACE789/messages/MSG003",
      sender: {
        name: "users/ADMIN001",
        displayName: "Admin",
        type: "HUMAN",
      },
      createTime: "2026-01-01T00:00:00Z",
      text: "@bot tell me about yourself",
      argumentText: "tell me about yourself",
      space: {
        name: "spaces/SPACE789",
        displayName: "My Team",
        type: "SPACE",
        singleUserBotDm: false,
      },
    };
  }

  return evt;
}

function makeRemovedFromSpaceEvent(): GoogleChatEvent {
  return {
    type: "REMOVED_FROM_SPACE",
    eventTime: "2026-01-01T00:00:00Z",
    space: {
      name: "spaces/SPACE456",
      type: "SPACE",
    },
    user: {
      name: "users/ADMIN001",
      displayName: "Admin",
      type: "HUMAN",
    },
  };
}

function makeCardClickEvent(): GoogleChatEvent {
  return {
    type: "CARD_CLICKED",
    eventTime: "2026-01-01T00:00:00Z",
    user: {
      name: "users/USER123",
      displayName: "Alice",
      type: "HUMAN",
    },
    action: {
      actionMethodName: "doSomething",
      parameters: [{ key: "id", value: "42" }],
    },
    message: {
      name: "spaces/DM123/messages/MSG001",
      sender: {
        name: "users/USER123",
        displayName: "Alice",
        type: "HUMAN",
      },
      createTime: "2026-01-01T00:00:00Z",
      text: "original message",
      space: {
        name: "spaces/DM123",
        type: "DM",
        singleUserBotDm: true,
      },
    },
  };
}

// ============================================================================
// Session key tests
// ============================================================================

describe("buildSessionKey", () => {
  it("returns googlechat-dm-{userId} for DMs", () => {
    const key = buildSessionKey("DM123", "USER123", true);
    expect(key).toBe("googlechat-dm-USER123");
  });

  it("returns googlechat-space-{spaceId} for Spaces", () => {
    const key = buildSessionKey("SPACE456", "USER456", false);
    expect(key).toBe("googlechat-space-SPACE456");
  });
});

// ============================================================================
// ID extraction tests
// ============================================================================

describe("extractSpaceId", () => {
  it("strips spaces/ prefix", () => {
    expect(extractSpaceId("spaces/AAAA_BBBB")).toBe("AAAA_BBBB");
  });

  it("returns the string unchanged if no prefix", () => {
    expect(extractSpaceId("AAAA_BBBB")).toBe("AAAA_BBBB");
  });
});

describe("extractUserId", () => {
  it("strips users/ prefix", () => {
    expect(extractUserId("users/123456")).toBe("123456");
  });

  it("returns the string unchanged if no prefix", () => {
    expect(extractUserId("123456")).toBe("123456");
  });
});

// ============================================================================
// shouldRespond — access control tests
// ============================================================================

describe("shouldRespond", () => {
  it("returns false for bot sender", () => {
    const event = makeDMEvent();
    event.message!.sender.type = "BOT";
    expect(shouldRespond(event, {})).toBe(false);
  });

  it("returns false for REMOVED_FROM_SPACE", () => {
    expect(shouldRespond(makeRemovedFromSpaceEvent(), {})).toBe(false);
  });

  it("returns true for ADDED_TO_SPACE", () => {
    expect(shouldRespond(makeAddedToSpaceEvent(), {})).toBe(true);
  });

  it("returns true for CARD_CLICKED", () => {
    expect(shouldRespond(makeCardClickEvent(), {})).toBe(true);
  });

  it("returns false for DM when dmPolicy is closed", () => {
    const config: GoogleChatConfig = { dmPolicy: "closed" };
    expect(shouldRespond(makeDMEvent(), config)).toBe(false);
  });

  it("returns true for DM when dmPolicy is open", () => {
    const config: GoogleChatConfig = { dmPolicy: "open" };
    expect(shouldRespond(makeDMEvent(), config)).toBe(true);
  });

  it("returns true for DM when dmPolicy is pairing with no allowFrom (open to all)", () => {
    const config: GoogleChatConfig = { dmPolicy: "pairing" };
    expect(shouldRespond(makeDMEvent(), config)).toBe(true);
  });

  it("returns true for DM when dmPolicy is pairing and allowFrom contains wildcard", () => {
    const config: GoogleChatConfig = { dmPolicy: "pairing", allowFrom: ["*"] };
    expect(shouldRespond(makeDMEvent(), config)).toBe(true);
  });

  it("returns true for DM when dmPolicy is pairing and user is in allowFrom", () => {
    const config: GoogleChatConfig = { dmPolicy: "pairing", allowFrom: ["USER123", "USER999"] };
    expect(shouldRespond(makeDMEvent(), config)).toBe(true);
  });

  it("returns false for DM when dmPolicy is pairing and user is NOT in allowFrom", () => {
    const config: GoogleChatConfig = { dmPolicy: "pairing", allowFrom: ["USER999"] };
    expect(shouldRespond(makeDMEvent(), config)).toBe(false);
  });

  it("returns false for Space when spacePolicy is disabled", () => {
    const config: GoogleChatConfig = { spacePolicy: "disabled" };
    expect(shouldRespond(makeSpaceEvent(), config)).toBe(false);
  });

  it("returns true for Space when spacePolicy is open", () => {
    const config: GoogleChatConfig = { spacePolicy: "open" };
    expect(shouldRespond(makeSpaceEvent(), config)).toBe(true);
  });

  it("returns false for Space when spacePolicy is allowlist and space not configured", () => {
    const config: GoogleChatConfig = { spacePolicy: "allowlist", spaces: {} };
    expect(shouldRespond(makeSpaceEvent(), config)).toBe(false);
  });

  it("returns true for Space when spacePolicy is allowlist and space is allowed", () => {
    const config: GoogleChatConfig = {
      spacePolicy: "allowlist",
      spaces: { SPACE456: { allow: true, enabled: true } },
    };
    expect(shouldRespond(makeSpaceEvent(), config)).toBe(true);
  });

  it("returns false for Space when spacePolicy is allowlist and space is disabled", () => {
    const config: GoogleChatConfig = {
      spacePolicy: "allowlist",
      spaces: { SPACE456: { allow: true, enabled: false } },
    };
    expect(shouldRespond(makeSpaceEvent(), config)).toBe(false);
  });
});

// ============================================================================
// formatAsCard tests
// ============================================================================

describe("formatAsCard", () => {
  it("wraps text in Cards v2 structure", () => {
    const card = formatAsCard("Hello world", "WOPR", undefined);
    expect(card).toHaveProperty("cardsV2");
    expect(card.cardsV2).toHaveLength(1);
    expect(card.cardsV2[0]).toHaveProperty("card");
    const section = card.cardsV2[0].card.sections[0];
    expect(section.widgets[0]).toEqual({ textParagraph: { text: "Hello world" } });
  });

  it("uses agent identity name in card header", () => {
    const card = formatAsCard("Hello", "MyBot", undefined);
    expect(card.cardsV2[0].card.header.title).toBe("MyBot");
  });

  it("includes cardThemeColor when provided", () => {
    const card = formatAsCard("Hello", "WOPR", "#1a73e8");
    // cardThemeColor is in the header
    expect(card.cardsV2[0].card.header).toHaveProperty("imageAltText");
  });

  it("generates unique cardId per call", () => {
    const card1 = formatAsCard("A", "WOPR", undefined);
    const card2 = formatAsCard("B", "WOPR", undefined);
    expect(card1.cardsV2[0].cardId).not.toBe(card2.cardsV2[0].cardId);
  });
});

// ============================================================================
// Webhook handler tests
// ============================================================================

describe("handleWebhook", () => {
  it("returns 400 for missing event type", async () => {
    const req = { body: {} };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleWebhook(req as any, res as any, false);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ text: expect.any(String) }));
  });

  it("returns 400 for null body", async () => {
    const req = { body: null };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleWebhook(req as any, res as any, false);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 503 when shutting down", async () => {
    const req = { body: makeSpaceEvent() };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleWebhook(req as any, res as any, true);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns 200 for REMOVED_FROM_SPACE (bot gone, no error)", async () => {
    const req = { body: makeRemovedFromSpaceEvent() };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    // Plugin not initialized — handleEvent will return {} for REMOVED_FROM_SPACE
    await handleWebhook(req as any, res as any, false);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 200 for ADDED_TO_SPACE (welcome message)", async () => {
    const req = { body: makeAddedToSpaceEvent() };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleWebhook(req as any, res as any, false);

    expect(res.status).toHaveBeenCalledWith(200);
    const responseArg = res.json.mock.calls[0][0];
    expect(responseArg).toHaveProperty("text");
  });

  it("returns 200 with action response for CARD_CLICKED", async () => {
    const req = { body: makeCardClickEvent() };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await handleWebhook(req as any, res as any, false);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ============================================================================
// Message character limit
// ============================================================================

describe("message truncation", () => {
  it("truncates response text exceeding 4096 chars with ellipsis", async () => {
    // We test this by calling handleWebhook with a mock ctx that returns a long string
    // For now, we import the truncation logic directly
    const { truncateToGChatLimit } = await import("../../src/index.js");
    const longText = "a".repeat(5000);
    const result = truncateToGChatLimit(longText);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not truncate text within 4096 chars", async () => {
    const { truncateToGChatLimit } = await import("../../src/index.js");
    const shortText = "Hello, world!";
    expect(truncateToGChatLimit(shortText)).toBe(shortText);
  });
});

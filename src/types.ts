/**
 * Google Chat-specific types for wopr-plugin-googlechat.
 *
 * WOPR shared types are imported from @wopr-network/plugin-types.
 * This file contains only Google Chat event/config/response types.
 */

// Re-export shared WOPR types for convenience
export type {
  WOPRPlugin,
  WOPRPluginContext,
  ConfigSchema,
  ChannelProvider,
  ChannelCommand,
  ChannelCommandContext,
  ChannelMessageContext,
  ChannelMessageParser,
  AgentIdentity,
  StreamMessage,
} from "@wopr-network/plugin-types";

// ============================================================================
// Google Chat Configuration
// ============================================================================

export interface GoogleChatConfig {
  enabled?: boolean;

  // Authentication
  serviceAccountKeyPath?: string; // Path to service account JSON file
  projectNumber?: string; // Google Cloud project number (for JWT validation)

  // Webhook endpoint
  webhookPath?: string; // Default: /googlechat/events
  webhookPort?: number; // Default: 8443

  // DM settings
  dmPolicy?: "open" | "pairing" | "closed";
  allowFrom?: string[]; // Google user IDs allowed in pairing mode

  // Space (group) settings
  spacePolicy?: "allowlist" | "open" | "disabled";
  spaces?: Record<
    string,
    {
      allow?: boolean;
      requireMention?: boolean;
      enabled?: boolean;
    }
  >;

  // Response settings
  useCards?: boolean; // Use Cards v2 format for responses (default: false, plain text)
  cardThemeColor?: string; // Hex color for card header (e.g., "#1a73e8")

  // Threading
  replyToMode?: "off" | "thread"; // Google Chat supports threads in named spaces
}

// ============================================================================
// Google Chat Event Types
// ============================================================================

/** Google Chat interaction event types */
export type GoogleChatEventType =
  | "MESSAGE"
  | "ADDED_TO_SPACE"
  | "REMOVED_FROM_SPACE"
  | "CARD_CLICKED";

/** Google Chat space type */
export type GoogleChatSpaceType = "DM" | "ROOM" | "SPACE";

/** Incoming Google Chat event payload (HTTP POST body) */
export interface GoogleChatEvent {
  type: GoogleChatEventType;
  eventTime: string;
  token?: string; // Verification token (deprecated, use JWT)

  // Message event
  message?: {
    name: string; // e.g., "spaces/SPACE_ID/messages/MESSAGE_ID"
    sender: {
      name: string; // e.g., "users/USER_ID"
      displayName: string;
      email?: string;
      type: "HUMAN" | "BOT";
    };
    createTime: string;
    text: string;
    argumentText?: string; // Text without @mention prefix
    thread?: {
      name: string; // e.g., "spaces/SPACE_ID/threads/THREAD_ID"
    };
    space: {
      name: string; // e.g., "spaces/SPACE_ID"
      displayName?: string;
      type: GoogleChatSpaceType;
      singleUserBotDm?: boolean;
    };
    annotations?: Array<{
      type: "USER_MENTION" | "SLASH_COMMAND";
      startIndex?: number;
      length?: number;
      userMention?: {
        user: { name: string; displayName: string; type: string };
      };
      slashCommand?: { commandId: string; commandName?: string };
    }>;
    slashCommand?: {
      commandId: string;
    };
  };

  // Space info (for ADDED_TO_SPACE / REMOVED_FROM_SPACE)
  space?: {
    name: string;
    displayName?: string;
    type: GoogleChatSpaceType;
    singleUserBotDm?: boolean;
  };

  // User who triggered the event
  user?: {
    name: string;
    displayName: string;
    email?: string;
    type: "HUMAN" | "BOT";
  };

  // Card click action
  action?: {
    actionMethodName: string;
    parameters?: Array<{ key: string; value: string }>;
  };

  configCompleteRedirectUrl?: string;
}

// ============================================================================
// Google Chat Response Types
// ============================================================================

export type GoogleChatWidget =
  | { textParagraph: { text: string } }
  | {
      decoratedText: {
        topLabel?: string;
        text: string;
        bottomLabel?: string;
        icon?: { knownIcon: string };
      };
    }
  | {
      buttonList: {
        buttons: Array<{
          text: string;
          onClick: {
            openLink?: { url: string };
            action?: {
              actionMethodName: string;
              parameters?: Array<{ key: string; value: string }>;
            };
          };
        }>;
      };
    }
  | { divider: Record<string, never> }
  | { image: { imageUrl: string; altText?: string } };

/** Google Chat Cards v2 response format */
export interface GoogleChatCardResponse {
  cardsV2?: Array<{
    cardId: string;
    card: {
      header?: {
        title: string;
        subtitle?: string;
        imageAltText?: string;
        imageUrl?: string;
        imageType?: "CIRCLE" | "SQUARE";
      };
      sections: Array<{
        header?: string;
        collapsible?: boolean;
        widgets: Array<GoogleChatWidget>;
      }>;
    };
  }>;
}

/** Synchronous response to Google Chat */
export interface GoogleChatSyncResponse {
  text?: string;
  cardsV2?: GoogleChatCardResponse["cardsV2"];
  thread?: { threadKey: string };
  actionResponse?: {
    type: "NEW_MESSAGE" | "UPDATE_MESSAGE" | "REQUEST_CONFIG" | "DIALOG";
    url?: string;
  };
}

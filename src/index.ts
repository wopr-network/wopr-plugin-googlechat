/**
 * wopr-plugin-googlechat
 *
 * Google Chat channel plugin for WOPR. Receives interaction events via HTTP
 * endpoint and uses @googleapis/chat for async message operations.
 * Authentication uses Google Cloud service account (chat.bot scope).
 */

import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import winston from "winston";
import type {
  AgentIdentity,
  ChannelCommand,
  ChannelMessageParser,
  ChannelProvider,
  ConfigSchema,
  WOPRPlugin,
  WOPRPluginContext,
} from "./types.js";
import type {
  GoogleChatConfig,
  GoogleChatEvent,
  GoogleChatSyncResponse,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

export const GCHAT_LIMIT = 4096;

// ============================================================================
// Module-level state (same pattern as wopr-plugin-slack, wopr-plugin-msteams)
// ============================================================================

let pluginCtx: WOPRPluginContext | null = null;
let config: GoogleChatConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "robot_face" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chatClient: any = null;
let channelProvider: ChannelProvider | null = null;
let configUnsub: (() => void) | null = null;
let isShuttingDown = false;
let logger: winston.Logger;

// ============================================================================
// Logger
// ============================================================================

function initLogger(): winston.Logger {
  return winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    defaultMeta: { service: "wopr-plugin-googlechat" },
    transports: [
      new winston.transports.File({
        filename: path.join(
          process.env.WOPR_HOME || "/tmp/wopr-test",
          "logs",
          "googlechat-plugin-error.log",
        ),
        level: "error",
      }),
      new winston.transports.File({
        filename: path.join(
          process.env.WOPR_HOME || "/tmp/wopr-test",
          "logs",
          "googlechat-plugin.log",
        ),
        level: "debug",
      }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple(),
        ),
        level: "warn",
      }),
    ],
  });
}

// ============================================================================
// Config schema
// ============================================================================

const configSchema: ConfigSchema = {
  title: "Google Chat Integration",
  description: "Configure Google Chat bot for Google Workspace",
  fields: [
    {
      name: "serviceAccountKeyPath",
      type: "text",
      label: "Service Account Key Path",
      placeholder: "/path/to/service-account.json",
      required: true,
      description: "Path to Google Cloud service account JSON key file",
    },
    {
      name: "projectNumber",
      type: "text",
      label: "Project Number",
      placeholder: "123456789",
      required: true,
      description: "Google Cloud project number (for JWT validation)",
    },
    {
      name: "webhookPort",
      type: "number",
      label: "Webhook Port",
      placeholder: "8443",
      default: 8443,
      description: "Port for the HTTP webhook endpoint",
    },
    {
      name: "webhookPath",
      type: "text",
      label: "Webhook Path",
      placeholder: "/googlechat/events",
      default: "/googlechat/events",
      description: "URL path for Google Chat event delivery",
    },
    {
      name: "dmPolicy",
      type: "select",
      label: "DM Policy",
      options: [
        { value: "pairing", label: "Pairing (approve unknown users)" },
        { value: "open", label: "Open (accept all DMs)" },
        { value: "closed", label: "Closed (ignore DMs)" },
      ],
      default: "pairing",
      description: "How to handle direct messages",
    },
    {
      name: "spacePolicy",
      type: "select",
      label: "Space Policy",
      options: [
        { value: "allowlist", label: "Allowlist (specified spaces only)" },
        { value: "open", label: "Open (all spaces, mention required)" },
        { value: "disabled", label: "Disabled (no group messages)" },
      ],
      default: "open",
      description: "How to handle Space (group) messages",
    },
    {
      name: "useCards",
      type: "checkbox",
      label: "Use Card Responses",
      default: false,
      description: "Wrap responses in Cards v2 format with header and styling",
    },
    {
      name: "replyToMode",
      type: "select",
      label: "Reply Threading",
      options: [
        { value: "off", label: "Reply in space (no threading)" },
        { value: "thread", label: "Reply in thread" },
      ],
      default: "off",
      description: "Control threading of replies",
    },
    {
      name: "enabled",
      type: "checkbox",
      label: "Enabled",
      default: true,
    },
  ],
};

// ============================================================================
// Pure utility functions (exported for testing)
// ============================================================================

export function buildSessionKey(
  spaceId: string,
  userId: string,
  isDM: boolean,
): string {
  if (isDM) {
    return `googlechat-dm-${userId}`;
  }
  return `googlechat-space-${spaceId}`;
}

export function extractSpaceId(spaceName: string): string {
  return spaceName.replace("spaces/", "");
}

export function extractUserId(userName: string): string {
  return userName.replace("users/", "");
}

export function truncateToGChatLimit(text: string): string {
  if (text.length <= GCHAT_LIMIT) return text;
  return text.substring(0, GCHAT_LIMIT - 3) + "...";
}

export function formatAsCard(
  text: string,
  agentName: string,
  cardThemeColor: string | undefined,
): {
  cardsV2: Array<{
    cardId: string;
    card: {
      header: {
        title: string;
        subtitle?: string;
        imageAltText?: string;
        imageType: "CIRCLE";
      };
      sections: Array<{ widgets: Array<{ textParagraph: { text: string } }> }>;
    };
  }>;
} {
  const header: {
    title: string;
    subtitle?: string;
    imageAltText?: string;
    imageType: "CIRCLE";
  } = {
    title: agentName || "WOPR",
    imageType: "CIRCLE",
  };

  if (cardThemeColor) {
    header.imageAltText = cardThemeColor;
  }

  return {
    cardsV2: [
      {
        cardId: `wopr-response-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        card: {
          header,
          sections: [
            {
              widgets: [{ textParagraph: { text } }],
            },
          ],
        },
      },
    ],
  };
}

/**
 * Determine whether the plugin should respond to this event.
 * Takes the config explicitly so it can be tested without module state.
 */
export function shouldRespond(
  event: GoogleChatEvent,
  cfg: GoogleChatConfig,
): boolean {
  const { type } = event;

  if (type === "REMOVED_FROM_SPACE") return false;
  if (type === "ADDED_TO_SPACE") return true;
  if (type === "CARD_CLICKED") return true;

  if (type === "MESSAGE") {
    const msg = event.message;
    if (!msg) return false;

    // Ignore bot messages
    if (msg.sender.type === "BOT") return false;

    const isDM =
      msg.space.singleUserBotDm === true || msg.space.type === "DM";

    if (isDM) {
      const policy = cfg.dmPolicy ?? "pairing";
      if (policy === "closed") return false;
      if (policy === "open") return true;
      // pairing mode
      const allowFrom = cfg.allowFrom ?? [];
      if (allowFrom.length === 0 || allowFrom.includes("*")) return true;
      const userId = extractUserId(msg.sender.name);
      return allowFrom.includes(userId);
    } else {
      // Space / Room
      const policy = cfg.spacePolicy ?? "open";
      if (policy === "disabled") return false;
      if (policy === "open") return true;
      // allowlist
      const spaceId = extractSpaceId(msg.space.name);
      const spaceCfg = cfg.spaces?.[spaceId];
      if (!spaceCfg) return false;
      if (spaceCfg.enabled === false) return false;
      if (spaceCfg.allow === false) return false;
      return true;
    }
  }

  return false;
}

// ============================================================================
// Google Auth
// ============================================================================

async function initGoogleAuth(): Promise<GoogleAuth> {
  const keyPath =
    config.serviceAccountKeyPath ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!keyPath) {
    throw new Error(
      "Service account key not configured. Set serviceAccountKeyPath in config or GOOGLE_APPLICATION_CREDENTIALS env var",
    );
  }

  return new GoogleAuth({
    keyFile: keyPath,
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
  });
}

// ============================================================================
// Card click handler
// ============================================================================

async function handleCardClick(
  event: GoogleChatEvent,
): Promise<GoogleChatSyncResponse> {
  if (!event.action) return {};

  const methodName = event.action.actionMethodName;
  const params = event.action.parameters ?? [];

  logger.info({ msg: "Card clicked", methodName, params });

  return {
    actionResponse: { type: "UPDATE_MESSAGE" },
    text: `Action "${methodName}" received.`,
  };
}

// ============================================================================
// Slash command handler
// ============================================================================

async function handleSlashCommand(
  event: GoogleChatEvent,
): Promise<GoogleChatSyncResponse> {
  if (!pluginCtx || !event.message?.slashCommand) return { text: "" };

  const commandId = event.message.slashCommand.commandId;
  const messageText = event.message.argumentText?.trim() ?? "";

  const slashAnnotation = event.message.annotations?.find(
    (a) => a.type === "SLASH_COMMAND",
  );
  const commandName =
    slashAnnotation?.slashCommand?.commandName ?? `command-${commandId}`;

  logger.info({
    msg: "Slash command received",
    commandId,
    commandName,
    text: messageText,
  });

  const spaceId = extractSpaceId(event.message.space.name);
  const userId = extractUserId(event.message.sender.name);
  const isDM =
    event.message.space.singleUserBotDm === true ||
    event.message.space.type === "DM";
  const sessionKey = buildSessionKey(spaceId, userId, isDM);

  const channelRef = {
    id: spaceId,
    type: "googlechat",
    name: event.message.space.displayName ?? spaceId,
  };

  try {
    const injectedText = `/${commandName} ${messageText}`.trim();
    const response = await pluginCtx.inject(sessionKey, injectedText, {
      from: event.message.sender.displayName,
      channel: channelRef,
    });

    if (config.useCards) {
      return formatAsCard(
        response,
        agentIdentity.name ?? "WOPR",
        config.cardThemeColor,
      );
    }
    return { text: response };
  } catch (error: unknown) {
    logger.error({
      msg: "Slash command failed",
      commandId,
      error: String(error),
    });
    return { text: "Error executing command. Please try again." };
  }
}

// ============================================================================
// Message handler
// ============================================================================

async function handleMessage(
  event: GoogleChatEvent,
): Promise<GoogleChatSyncResponse> {
  if (!pluginCtx || !event.message) return { text: "" };

  const msg = event.message;
  const spaceId = extractSpaceId(msg.space.name);
  const userId = extractUserId(msg.sender.name);
  const userName = msg.sender.displayName;
  const isDM =
    msg.space.singleUserBotDm === true || msg.space.type === "DM";

  const messageText = msg.argumentText?.trim() ?? msg.text;
  const sessionKey = buildSessionKey(spaceId, userId, isDM);

  const channelRef = {
    id: spaceId,
    type: "googlechat",
    name: msg.space.displayName ?? (isDM ? `DM with ${userName}` : spaceId),
  };

  logger.debug({
    msg: "RECEIVED MESSAGE",
    text: messageText?.substring(0, 100),
    user: userName,
    space: spaceId,
    isDM,
  });

  // Slash command routing
  if (msg.slashCommand) {
    return handleSlashCommand(event);
  }

  try {
    const response = await pluginCtx.inject(sessionKey, messageText, {
      from: userName,
      channel: channelRef,
    });

    const responseText = truncateToGChatLimit(
      response || "I couldn't generate a response. Please try again.",
    );

    const threadResponse: GoogleChatSyncResponse = {};
    if (config.replyToMode === "thread" && msg.thread) {
      threadResponse.thread = { threadKey: msg.thread.name };
    }

    if (config.useCards) {
      return {
        ...formatAsCard(
          responseText,
          agentIdentity.name ?? "WOPR",
          config.cardThemeColor,
        ),
        ...threadResponse,
      };
    }
    return { text: responseText, ...threadResponse };
  } catch (error: unknown) {
    logger.error({ msg: "Inject failed", error: String(error) });
    const errorText =
      "Sorry, I encountered an error processing your request. Please try again.";
    if (config.useCards) {
      return formatAsCard(
        errorText,
        agentIdentity.name ?? "WOPR",
        config.cardThemeColor,
      );
    }
    return { text: errorText };
  }
}

// ============================================================================
// Main event dispatcher
// ============================================================================

async function handleEvent(
  event: GoogleChatEvent,
): Promise<GoogleChatSyncResponse> {
  if (event.type === "REMOVED_FROM_SPACE") {
    const spaceId = extractSpaceId(event.space?.name ?? "");
    logger.info({ msg: "Removed from space", spaceId });
    return {};
  }

  if (event.type === "ADDED_TO_SPACE") {
    const spaceName = event.space?.displayName ?? "this space";
    const welcomeText = `Hello! I'm ${agentIdentity.name ?? "WOPR"}. I'm ready to chat in ${spaceName}. Send me a message or use a slash command to get started.`;
    logger.info({
      msg: "Added to space",
      space: event.space?.name,
      type: event.space?.type,
    });

    // If ADDED_TO_SPACE also contains a message (via @mention), handle it
    if (event.message?.text) {
      return handleMessage(event);
    }

    if (config.useCards) {
      return formatAsCard(
        welcomeText,
        agentIdentity.name ?? "WOPR",
        config.cardThemeColor,
      );
    }
    return { text: welcomeText };
  }

  if (event.type === "CARD_CLICKED") {
    return handleCardClick(event);
  }

  if (event.type === "MESSAGE") {
    if (!shouldRespond(event, config)) {
      if (event.message && pluginCtx) {
        const spaceId = extractSpaceId(event.message.space.name);
        const userId = extractUserId(event.message.sender.name);
        const isDM =
          event.message.space.singleUserBotDm === true ||
          event.message.space.type === "DM";
        const sessionKey = buildSessionKey(spaceId, userId, isDM);
        try {
          pluginCtx.logMessage(sessionKey, event.message.text, {
            from: event.message.sender.displayName,
            channel: { type: "googlechat", id: spaceId },
          });
        } catch (_e) {
          // ignore
        }
      }
      return {};
    }
    return handleMessage(event);
  }

  return {};
}

// ============================================================================
// HTTP webhook handler (exported for testing and external registration)
// ============================================================================

export async function handleWebhook(
  req: { body: unknown },
  res: {
    status(code: number): { json(body: unknown): void };
    json?(body: unknown): void;
  },
  shuttingDown = isShuttingDown,
): Promise<void> {
  if (shuttingDown) {
    res.status(503).json({ text: "Bot is shutting down" });
    return;
  }

  try {
    const event = req.body as GoogleChatEvent;

    if (!event || !event.type) {
      logger?.warn?.({ msg: "Invalid event payload", body: req.body });
      res.status(400).json({ text: "Invalid event" });
      return;
    }

    logger?.debug?.({
      msg: "Incoming event",
      type: event.type,
      space: event.space?.name ?? event.message?.space?.name,
    });

    const response = await handleEvent(event);
    res.status(200).json(response);
  } catch (error: unknown) {
    logger?.error?.({
      msg: "Webhook handler error",
      error: String(error),
    });
    // Always return 200 to prevent Google Chat retries
    res.status(200).json({ text: "Internal error occurred." });
  }
}

// ============================================================================
// ChannelProvider (registered commands/parsers from other plugins)
// ============================================================================

const registeredCommands: Map<string, ChannelCommand> = new Map();
const registeredParsers: Map<string, ChannelMessageParser> = new Map();
let botUsername = "WOPR";

function buildChannelProvider(): ChannelProvider {
  return {
    id: "googlechat",

    registerCommand(cmd: ChannelCommand): void {
      registeredCommands.set(cmd.name, cmd);
      logger?.info?.({ msg: "Channel command registered", name: cmd.name });
    },

    unregisterCommand(name: string): void {
      registeredCommands.delete(name);
    },

    getCommands(): ChannelCommand[] {
      return Array.from(registeredCommands.values());
    },

    addMessageParser(parser: ChannelMessageParser): void {
      registeredParsers.set(parser.id, parser);
      logger?.info?.({ msg: "Message parser registered", id: parser.id });
    },

    removeMessageParser(id: string): void {
      registeredParsers.delete(id);
    },

    getMessageParsers(): ChannelMessageParser[] {
      return Array.from(registeredParsers.values());
    },

    async send(channelId: string, content: string): Promise<void> {
      if (!chatClient) {
        logger?.error?.({
          msg: "Cannot send — Google Chat API client not initialized",
        });
        return;
      }

      const text = truncateToGChatLimit(content);
      const spaceName = channelId.startsWith("spaces/")
        ? channelId
        : `spaces/${channelId}`;

      try {
        await chatClient.spaces.messages.create({
          parent: spaceName,
          requestBody: config.useCards
            ? formatAsCard(
                text,
                agentIdentity.name ?? "WOPR",
                config.cardThemeColor,
              )
            : { text },
        });
      } catch (err: unknown) {
        logger?.error?.({
          msg: "Failed to send message to Google Chat",
          channelId,
          error: String(err),
        });
        throw err;
      }
    },

    getBotUsername(): string {
      return botUsername;
    },
  };
}

// ============================================================================
// Plugin definition
// ============================================================================

const plugin: WOPRPlugin = {
  name: "@wopr-network/wopr-plugin-googlechat",
  version: "1.0.0",
  description: "Google Chat integration for Google Workspace",

  manifest: {
    name: "@wopr-network/wopr-plugin-googlechat",
    version: "1.0.0",
    description: "Google Chat integration for Google Workspace",
    capabilities: ["channel"],
    requires: {
      env: ["GOOGLE_APPLICATION_CREDENTIALS"],
      network: {
        outbound: true,
        inbound: true,
        hosts: ["chat.googleapis.com"],
      },
    },
    provides: {
      capabilities: [
        {
          type: "channel",
          id: "googlechat",
          displayName: "Google Chat",
          tier: "byok",
        },
      ],
    },
    icon: "💬",
    category: "communication",
    tags: ["googlechat", "google-workspace", "chat", "channel"],
    lifecycle: {
      shutdownBehavior: "drain",
      shutdownTimeoutMs: 30_000,
    },
  },

  async init(ctx: WOPRPluginContext): Promise<void> {
    pluginCtx = ctx;
    logger = initLogger();

    // 1. Register config schema
    ctx.registerConfigSchema("wopr-plugin-googlechat", configSchema);

    // 2. Load config with env var fallbacks
    const fullConfig = ctx.getConfig<{
      channels?: { googlechat?: GoogleChatConfig };
    }>();
    config = fullConfig?.channels?.googlechat ?? {};

    if (
      !config.serviceAccountKeyPath &&
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ) {
      config.serviceAccountKeyPath =
        process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    if (!config.projectNumber && process.env.GOOGLE_PROJECT_NUMBER) {
      config.projectNumber = process.env.GOOGLE_PROJECT_NUMBER;
    }

    if (!config.enabled) {
      ctx.log.info("Google Chat plugin disabled in config");
      return;
    }

    // 3. Load agent identity
    const identity = await ctx.getAgentIdentity();
    agentIdentity = identity;
    botUsername = identity.name ?? "WOPR";

    // 4. Initialize Google auth + chat client (for async outbound messages)
    try {
      const auth = await initGoogleAuth();
      // biome-ignore lint/suspicious/noExplicitAny: googleapis auth types are complex
      chatClient = google.chat({ version: "v1", auth: auth as any });
      ctx.log.info("Google Chat API client initialized");
    } catch (error: unknown) {
      ctx.log.warn(
        "Google Chat API client not initialized (async messaging unavailable): " +
          String(error),
      );
      // Plugin continues in sync-only mode via webhook responses
    }

    // 5. Build and register channel provider
    channelProvider = buildChannelProvider();
    ctx.registerChannelProvider(channelProvider);

    // 6. Subscribe to config changes
    configUnsub = ctx.events.on(
      "config:change",
      async ({ key, newValue }: { key: string; newValue: unknown }) => {
        if (key === "channels.googlechat") {
          config = (newValue as GoogleChatConfig) ?? {};
          ctx.log.info("Google Chat config updated");
        }
      },
    );

    const port = config.webhookPort ?? 8443;
    const webhookPath = config.webhookPath ?? "/googlechat/events";
    ctx.log.info(
      `Google Chat plugin initialized — webhook: https://<domain>:${port}${webhookPath}`,
    );
    ctx.log.info(
      "Configure this URL in Google Cloud Console > Google Chat API > Configuration > Connection settings",
    );
  },

  async shutdown(): Promise<void> {
    isShuttingDown = true;

    // Unsubscribe from events
    if (configUnsub) {
      configUnsub();
      configUnsub = null;
    }

    // Unregister channel provider
    pluginCtx?.unregisterChannelProvider("googlechat");

    logger?.info("Google Chat plugin shut down");
    chatClient = null;
    channelProvider = null;
    pluginCtx = null;
  },
};

export default plugin;

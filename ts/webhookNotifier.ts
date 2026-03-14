import os from "node:os";
import { getInstallEnv } from "./installEnv.ts";
import { logger } from "./logger.ts";

export type WebhookStatus = "RUNNING" | "IDLE" | "EXIT";

/**
 * Notify the AGENT_YES_MESSAGE_WEBHOOK URL with a status message.
 *
 * AGENT_YES_MESSAGE_WEBHOOK should be set in the agent-yes install dir .env, e.g.:
 *   AGENT_YES_MESSAGE_WEBHOOK=https://example.com/hook?q=%s
 *
 * The %s placeholder is replaced with the URL-encoded message:
 *   [STATUS] hostname:cwd details
 */
export async function notifyWebhook(
  status: WebhookStatus,
  details: string,
  cwd = process.cwd(),
): Promise<void> {
  const webhookTemplate = await getInstallEnv("AGENT_YES_MESSAGE_WEBHOOK");
  if (!webhookTemplate) return;

  const hostname = os.hostname();
  const message = `[${status}] ${hostname}:${cwd}${details ? " " + details : ""}`;
  const url = webhookTemplate.replace("%s", encodeURIComponent(message));

  try {
    const res = await fetch(url);
    logger.debug(`[webhook] ${status} notified (${res.status}): ${url}`);
  } catch (error) {
    logger.warn(`[webhook] Failed to notify ${status}: ${error}`);
  }
}

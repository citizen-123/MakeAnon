import prisma from './database';
import { WebhookEvent, WebhookPayload } from '../types';
import { createHmacSignature, retryWithBackoff } from '../utils/helpers';
import logger from '../utils/logger';

const WEBHOOK_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000');
const WEBHOOK_MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || '3');
const WEBHOOKS_ENABLED = process.env.WEBHOOKS_ENABLED !== 'false';

/**
 * Trigger webhooks for a specific event
 */
export async function triggerWebhooks(
  userId: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  if (!WEBHOOKS_ENABLED) return;

  try {
    const webhooks = await prisma.webhook.findMany({
      where: {
        userId,
        isActive: true,
        events: { has: event },
      },
    });

    for (const webhook of webhooks) {
      // Fire and forget - don't block on webhook delivery
      deliverWebhook(webhook.id, webhook.url, webhook.secret, event, data).catch((error) => {
        logger.error(`Webhook delivery failed for ${webhook.id}:`, error);
      });
    }
  } catch (error) {
    logger.error('Failed to trigger webhooks:', error);
  }
}

/**
 * Deliver a webhook to a URL
 */
async function deliverWebhook(
  webhookId: string,
  url: string,
  secret: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  const body = JSON.stringify(payload);
  const signature = createHmacSignature(body, secret);

  try {
    await retryWithBackoff(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-MakeAnon-Signature': signature,
              'X-MakeAnon-Event': event,
            },
            body,
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        } finally {
          clearTimeout(timeout);
        }
      },
      WEBHOOK_MAX_RETRIES,
      1000
    );

    // Update last triggered time and reset failure count
    await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        lastTriggered: new Date(),
        failureCount: 0,
      },
    });

    logger.debug(`Webhook delivered: ${event} to ${url}`);
  } catch (error) {
    // Increment failure count
    const updated = await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        failureCount: { increment: 1 },
      },
    });

    // Disable webhook after too many failures
    if (updated.failureCount >= 10) {
      await prisma.webhook.update({
        where: { id: webhookId },
        data: { isActive: false },
      });
      logger.warn(`Webhook disabled due to failures: ${webhookId}`);
    }

    throw error;
  }
}

/**
 * Create a webhook for a user
 */
export async function createWebhook(
  userId: string,
  url: string,
  events: WebhookEvent[]
): Promise<{ id: string; secret: string } | null> {
  try {
    // Generate a secret for HMAC signing
    const secret = require('crypto').randomBytes(32).toString('hex');

    const webhook = await prisma.webhook.create({
      data: {
        userId,
        url,
        secret,
        events,
      },
    });

    return { id: webhook.id, secret };
  } catch (error) {
    logger.error('Failed to create webhook:', error);
    return null;
  }
}

/**
 * Get webhooks for a user
 */
export async function getWebhooks(userId: string) {
  return prisma.webhook.findMany({
    where: { userId },
    select: {
      id: true,
      url: true,
      events: true,
      isActive: true,
      lastTriggered: true,
      failureCount: true,
      createdAt: true,
    },
  });
}

/**
 * Delete a webhook
 */
export async function deleteWebhook(userId: string, webhookId: string): Promise<boolean> {
  try {
    await prisma.webhook.deleteMany({
      where: { id: webhookId, userId },
    });
    return true;
  } catch (error) {
    logger.error('Failed to delete webhook:', error);
    return false;
  }
}

/**
 * Toggle webhook active status
 */
export async function toggleWebhook(
  userId: string,
  webhookId: string
): Promise<boolean | null> {
  try {
    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, userId },
    });

    if (!webhook) return null;

    await prisma.webhook.update({
      where: { id: webhookId },
      data: { isActive: !webhook.isActive },
    });

    return !webhook.isActive;
  } catch (error) {
    logger.error('Failed to toggle webhook:', error);
    return null;
  }
}

export default {
  triggerWebhooks,
  createWebhook,
  getWebhooks,
  deleteWebhook,
  toggleWebhook,
};

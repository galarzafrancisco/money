import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { safeEqual } from '../web-auth/secrets';
import { UpAuthRejectedError, UpUnavailableError } from './up-api.client';
import { UpSyncService } from './up-sync.service';
import { UpVault } from './up-vault';
import type { UpWebhookOutcome } from './up.entities';
import { UpRepository } from './up.repository';

/** Authentication of a provider event failed. Deliberately says nothing about why */
export class WebhookRejectedError extends DomainError {
  readonly code = 'invalid_signature';
  readonly httpStatus = 401;
}

/** The event is authentic but its content is not something Money understands */
export class WebhookMalformedError extends DomainError {
  readonly code = 'invalid_event';
  readonly httpStatus = 400;
}

/** The event is authentic but could not be processed now; the provider should retry */
export class WebhookRetryError extends DomainError {
  readonly code = 'try_again';
  readonly httpStatus = 503;
}

const envelope = z.object({
  data: z.object({
    id: z.string().min(1).max(64),
    attributes: z.object({ eventType: z.string().min(1).max(40) }),
    relationships: z.object({
      webhook: z.object({ data: z.object({ id: z.string().min(1).max(64) }) }),
      transaction: z.object({ data: z.object({ id: z.string().min(1).max(64) }).nullable().optional() }).optional(),
    }),
  }),
});

const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/;
/** Equalises the work for an unknown webhook ID so response time does not reveal which IDs exist */
const DUMMY_SECRET = 'money-unknown-webhook';

export type WebhookResult = { status: 'processed' | 'duplicate' | 'ignored'; outcome?: UpWebhookOutcome };

/**
 * The global inbound endpoint for Up's webhook events (POST /api/v1/webhooks/up).
 *
 * Order of work, and why:
 *  1. Find the integration from the event's webhook ID. The ID only selects
 *     which secret to verify with; nothing is trusted yet.
 *  2. Verify X-Up-Authenticity-Signature, the HMAC-SHA256 of the raw body, with
 *     that integration's secret. Anything failing 1-2 gets the same 401.
 *  3. Only then record the event ID (replay and duplicate protection) and act.
 *
 * The event carries only IDs, never contents. Money fetches the current state
 * of the transaction from Up with the user's token, so the result does not
 * depend on the order events arrive in, and a forged body cannot inject data.
 */
@Injectable()
export class UpWebhookService {
  constructor(
    private readonly repo: UpRepository,
    private readonly sync: UpSyncService,
    private readonly vault: UpVault,
  ) {}

  async receive(rawBody: Buffer | undefined, signature: string | undefined): Promise<WebhookResult> {
    if (!rawBody || !signature || !SIGNATURE_PATTERN.test(signature)) throw new WebhookRejectedError('Webhook authentication failed');

    let webhookId: string | undefined;
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
      webhookId = (json as { data?: { relationships?: { webhook?: { data?: { id?: unknown } } } } }).data?.relationships?.webhook?.data?.id as string | undefined;
    } catch {
      throw new WebhookRejectedError('Webhook authentication failed');
    }
    const integration = typeof webhookId === 'string' && webhookId.length <= 64 ? await this.repo.findIntegrationByWebhookId(webhookId) : null;
    const secret = integration?.webhookSecretCiphertext ? this.vault.tryDecrypt(integration.webhookSecretCiphertext, integration.id) : null;
    const expected = createHmac('sha256', secret ?? DUMMY_SECRET).update(rawBody).digest('hex');
    const authentic = safeEqual(expected, signature.toLowerCase());
    if (!integration || secret === null || !authentic) throw new WebhookRejectedError('Webhook authentication failed');

    // Authentic from here on
    if (integration.status !== 'active') return { status: 'ignored' };
    const parsed = envelope.safeParse(json);
    if (!parsed.success) throw new WebhookMalformedError('The event does not have the expected shape');
    const event = parsed.data.data;
    const upTransactionId = event.relationships.transaction?.data?.id ?? null;

    const { row, created } = await this.repo.recordEvent({
      userId: integration.userId,
      integrationId: integration.id,
      eventId: event.id,
      eventType: event.attributes.eventType,
      upTransactionId,
    });
    if (!created && row.processedAt) return { status: 'duplicate', outcome: row.outcome ?? undefined };

    const outcome = await this.process(integration, event.attributes.eventType, upTransactionId);
    if (outcome === 'unreadable') throw new WebhookRetryError('Money could not process the event now');
    await this.repo.completeEvent(row.id, outcome);
    return { status: outcome === 'ignored' ? 'ignored' : 'processed', outcome };
  }

  private async process(
    integration: NonNullable<Awaited<ReturnType<UpRepository['findIntegrationByWebhookId']>>>,
    eventType: string,
    upTransactionId: string | null,
  ): Promise<UpWebhookOutcome | 'unreadable'> {
    if (eventType === 'PING') return 'ping';
    if (!upTransactionId) return 'ignored';
    try {
      if (eventType === 'TRANSACTION_DELETED') return await this.sync.markDeleted(integration, upTransactionId);
      if (eventType === 'TRANSACTION_CREATED' || eventType === 'TRANSACTION_SETTLED') {
        const token = this.sync.tokenOf(integration);
        if (!token) return 'unreadable';
        return await this.sync.refreshTransaction(integration, token, upTransactionId);
      }
      return 'ignored'; // an event type added by Up later: acknowledge, do not fail
    } catch (error) {
      if (error instanceof UpAuthRejectedError) {
        // The token was revoked: retrying cannot help. Record it and acknowledge
        await this.sync.classify(integration, error);
        return 'ignored';
      }
      if (error instanceof UpUnavailableError || error instanceof z.ZodError) return 'unreadable';
      throw error;
    }
  }
}

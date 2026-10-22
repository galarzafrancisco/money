import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UpWebhookService } from './up-webhook.service';

/**
 * Up's webhook callback. Intentionally NOT behind Taico authentication or the
 * session/CSRF middleware: Up has no Taico token and sends no cookie. Every
 * request is authenticated by UpWebhookService with the per-webhook HMAC
 * signature before anything else happens. Not part of the OpenAPI spec or the
 * generated client: it is a provider endpoint, not an API for Money's clients.
 */
@Controller('api/v1/webhooks')
export class UpWebhookController {
  constructor(private readonly webhooks: UpWebhookService) {}

  @Post('up')
  @HttpCode(200)
  receive(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-up-authenticity-signature') signature: string | undefined) {
    return this.webhooks.receive(req.rawBody, signature);
  }
}

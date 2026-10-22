import { Inject, Injectable } from '@nestjs/common';
import { NotConfiguredError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { TokenCipher } from '../web-auth/secrets';

/**
 * Encrypts the Up personal access token and webhook secrets at rest. The row
 * ID is bound as associated data, so a ciphertext copied to another row does
 * not decrypt. Without UP_ENCRYPTION_KEY the integration is unavailable.
 */
@Injectable()
export class UpVault {
  private readonly cipher: TokenCipher | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.cipher = config.up.encryptionKey ? new TokenCipher(config.up.encryptionKey) : null;
  }

  get available(): boolean {
    return this.cipher !== null;
  }

  encrypt(plaintext: string, context: string): string {
    return this.require().encrypt(plaintext, context);
  }

  /** Null when the value cannot be decrypted (wrong key, tampered, other row) */
  tryDecrypt(ciphertext: string, context: string): string | null {
    try {
      return this.require().decrypt(ciphertext, context);
    } catch (error) {
      if (error instanceof NotConfiguredError) throw error;
      return null;
    }
  }

  private require(): TokenCipher {
    if (!this.cipher) throw new NotConfiguredError('The Up integration is not configured on this server (UP_ENCRYPTION_KEY is not set)');
    return this.cipher;
  }
}

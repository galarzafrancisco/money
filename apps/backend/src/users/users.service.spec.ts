import type { AuthContext } from '@taico/auth';
import { UsersService } from './users.service';

function auth(iss: string, sub: string, extra: Record<string, unknown> = {}): AuthContext {
  const claims = { iss, sub, aud: 'x', exp: 0, iat: 0, jti: 'j', client_id: 'c', scope: '', ...extra };
  return { token: 't', claims, scopes: [], subject: sub, clientId: 'c', extra: { subject: sub, claims } } as AuthContext;
}

describe('UsersService', () => {
  it('keys users by issuer and subject, so the same subject from two issuers is two users', async () => {
    const rows = new Map<string, { id: string; displayName: string | null; email: string | null }>();
    const repo = {
      upsertIdentity: async (identity: { issuer: string; subject: string; displayName: string | null; email: string | null }) => {
        const key = `${identity.issuer}|${identity.subject}`;
        const row = rows.get(key) ?? { id: `user-${rows.size + 1}`, displayName: identity.displayName, email: identity.email };
        rows.set(key, row);
        return row;
      },
    };
    const service = new UsersService(repo as never);
    const a = await service.resolve(auth('https://taico.one', 'same'));
    const b = await service.resolve(auth('https://taico.two', 'same'));
    const again = await service.resolve(auth('https://taico.one', 'same', { displayName: 'Ada' }));
    expect(a.id).not.toBe(b.id);
    expect(again.id).toBe(a.id);
  });
});

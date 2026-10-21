# @money/client

Typed client for Money's REST API, **generated** from the backend's OpenAPI spec
(`apps/backend/openapi.json`) with [`@taico/openapi-sdkgen`](https://www.npmjs.com/package/@taico/openapi-sdkgen).
See [docs/architecture/api-clients.md](../../docs/architecture/api-clients.md).

```ts
import { ApiClient, moneyErrorOf } from '@money/client';

const money = new ApiClient({ baseUrl: window.location.origin, credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
const accounts = await money.accounts.listAccounts();
```

- `npm run build` regenerates `src/generated` from the spec, then compiles. Nx builds
  `@money/backend` first, because the backend build writes the spec.
- `src/generated` is a build output and gitignored. Never edit it; change the
  backend's `@ApiRoute` metadata or zod schemas instead.
- `moneyErrorOf(error)` reads Money's `{ error: { code, message, details } }` envelope
  from a failed call.

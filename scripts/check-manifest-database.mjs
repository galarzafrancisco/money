// Checks the database settings of Money's rendered Kubernetes manifests
// (`kustomize build` output), so the deployment cannot silently go back to a
// non-durable database or carry credentials in Git.
//
//   kustomize build install/manifests/overlays/main > rendered.yaml
//   node scripts/check-manifest-database.mjs rendered.yaml
//
// The Deployment `money` must:
// - run DATABASE_MODE=postgres (not memory or pglite),
// - take DATABASE_URL only from the spark-ops Secret money-database, key
//   DATABASE_URL, and not mark that reference optional,
// - not set DATABASE_URL anywhere else (literal env value, ConfigMap).
// The manifests must define the Service money-postgres and the EndpointSlice
// money-postgres-host that route the pod to the host database (port 15434, with
// the host address filled in from SPARK_IP), and must not define the Secret
// money-database, which spark-ops provisions because it holds the credentials.
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-manifest-database.mjs <rendered.yaml>');
  process.exit(2);
}

const docs = parseAllDocuments(readFileSync(file, 'utf8'))
  .map((d) => d.toJS())
  .filter(Boolean);
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const configMaps = new Map(docs.filter((d) => d.kind === 'ConfigMap').map((d) => [d.metadata.name, d.data ?? {}]));
for (const [name, data] of configMaps) {
  check(!('DATABASE_URL' in data), `ConfigMap/${name} must not set DATABASE_URL (it comes from the money-database Secret)`);
}
check(
  !docs.some((d) => d.kind === 'Secret' && d.metadata?.name === 'money-database'),
  'Secret/money-database must not be defined here: spark-ops provisions it (it holds the credentials)',
);
const dbService = docs.find((d) => d.kind === 'Service' && d.metadata?.name === 'money-postgres');
check(Boolean(dbService), 'Service/money-postgres not found');
check(dbService?.spec.ports?.[0]?.port === 5432, 'Service/money-postgres must expose port 5432');
const slice = docs.find((d) => d.kind === 'EndpointSlice' && d.metadata?.name === 'money-postgres-host');
check(Boolean(slice), 'EndpointSlice/money-postgres-host not found');
check(
  slice?.metadata.labels?.['kubernetes.io/service-name'] === 'money-postgres',
  'EndpointSlice/money-postgres-host must be labelled kubernetes.io/service-name: money-postgres',
);
const address = slice?.endpoints?.[0]?.addresses?.[0];
check(
  /^\d+\.\d+\.\d+\.\d+$/.test(address ?? ''),
  `EndpointSlice/money-postgres-host address must be the hydrated Spark IP (got ${JSON.stringify(address)})`,
);

const deployment = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'money');
check(Boolean(deployment), 'Deployment/money not found');
const container = deployment?.spec.template.spec.containers.find((c) => c.name === 'money');
check(Boolean(deployment && container), 'Deployment/money has no container named money');

if (container) {
  const env = container.env ?? [];
  // Resolve a variable the way the kubelet does: env wins over envFrom.
  const fromConfigMaps = Object.assign(
    {},
    ...(container.envFrom ?? []).filter((s) => s.configMapRef).map((s) => configMaps.get(s.configMapRef.name) ?? {}),
  );
  const mode = env.find((e) => e.name === 'DATABASE_MODE')?.value ?? fromConfigMaps.DATABASE_MODE;
  check(mode === 'postgres', `DATABASE_MODE must be postgres (got ${JSON.stringify(mode)})`);

  const urls = env.filter((e) => e.name === 'DATABASE_URL');
  check(urls.length === 1, `DATABASE_URL must be set exactly once in env (found ${urls.length})`);
  const ref = urls[0]?.valueFrom?.secretKeyRef;
  check(urls[0]?.value === undefined, 'DATABASE_URL must not have a literal value');
  check(ref?.name === 'money-database' && ref?.key === 'DATABASE_URL', 'DATABASE_URL must come from secretKeyRef money-database/DATABASE_URL');
  check(ref?.optional !== true, 'the money-database secretKeyRef must not be optional');
}

if (failures.length > 0) {
  console.error(`Manifest database check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Manifest database check passed (postgres, DATABASE_URL from Secret money-database).');

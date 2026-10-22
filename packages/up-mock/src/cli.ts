#!/usr/bin/env node
import { createUpMock } from './mock';

/** Runs the mock as a standalone server: `up-bank-mock [--port 4190] [--token up:yeah:demo]` */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const mock = createUpMock({ adminApi: true });
  const token = value('--token', 'up:mock:demo-token');
  mock.addCustomer(token);
  const url = await mock.listen(Number(value('--port', '4190')));
  console.log(`up-bank-mock listening: ${url}\nfictional personal access token: ${token}\n(offline; webhooks only deliver to loopback hosts)`);
}

void main();

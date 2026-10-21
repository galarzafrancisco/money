import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-support/test-app';
import { isBackendPath, serveWebApp } from './web-app/serve-web-app';

describe('serving the web app', () => {
  let t: TestApp;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'money-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Money</title>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    t = await createTestApp({
      configure: (app) => expect(serveWebApp(app as NestExpressApplication, dir)).toBe(true),
    });
  });
  afterAll(() => t.close());

  it('serves index.html for client-side routes, uncached', async () => {
    const response = await request(t.app.getHttpServer()).get('/accounts/123/transactions').set('Accept', 'text/html').expect(200);
    expect(response.text).toContain('<title>Money</title>');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('serves hashed assets with long-lived caching', async () => {
    const response = await request(t.app.getHttpServer()).get('/assets/app-abc123.js').expect(200);
    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('never shadows the API, auth, MCP or health endpoints', async () => {
    await request(t.app.getHttpServer()).get('/api/accounts').set('Accept', 'text/html').expect(401);
    await request(t.app.getHttpServer()).get('/health').set('Accept', 'text/html').expect(200, { status: 'ok' });
    const session = await request(t.app.getHttpServer()).get('/auth/session').set('Accept', 'text/html').expect(200);
    expect(session.body).toMatchObject({ authenticated: false });
    expect(isBackendPath('/mcp')).toBe(true);
    expect(isBackendPath('/apiary')).toBe(false);
  });

  it('does not answer non-HTML requests with the app', async () => {
    await request(t.app.getHttpServer()).get('/nope.json').set('Accept', 'application/json').expect(404);
  });

  it('serves nothing when there is no build', () => {
    expect(serveWebApp({} as NestExpressApplication, join(dir, 'missing'))).toBe(false);
  });
});

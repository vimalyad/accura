import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local fixture site for CI-safe eval tasks: real HTTP pages with real
 * navigation, forms and prices, but zero dependence on the live web.
 */
const PAGES: Record<string, string> = {
  '/form': `
<html><head><title>Signup</title></head><body>
  <h1>Create your account</h1>
  <form id="f">
    <input id="name" type="text" placeholder="Full name">
    <input id="email" type="email" placeholder="Email address">
    <button type="submit">Submit form</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = document.createElement('div');
      msg.id = 'msg';
      msg.textContent = 'Thanks ' + document.getElementById('name').value +
        ' (' + document.getElementById('email').value + ')';
      document.body.appendChild(msg);
    });
  </script>
</body></html>`,
  '/prices': `
<html><head><title>Catalog</title></head><body>
  <h1>Widget catalog</h1>
  <ul>
    <li>Basic Widget — $12.50</li>
    <li>Super Widget — $49.99</li>
    <li>Mega Widget — $99.00</li>
  </ul>
  <a href="/form">Order now</a>
</body></html>`,
  '/nav': `
<html><head><title>Start</title></head><body>
  <h1>Welcome</h1>
  <a href="/nav/about">About us</a>
</body></html>`,
  '/nav/about': `
<html><head><title>About</title></head><body>
  <h1>About</h1>
  <p>Founded in 2019 in Pune.</p>
  <a href="/nav">Home</a>
</body></html>`,
};

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Resolves fixture:/path start URLs against a running fixture server. */
export function resolveStartUrl(startUrl: string | undefined, fixtureBaseUrl?: string): string | undefined {
  if (!startUrl) return undefined;
  if (startUrl.startsWith('fixture:')) {
    if (!fixtureBaseUrl) {
      throw new Error(`Task uses ${startUrl} but no fixture server is running`);
    }
    return fixtureBaseUrl + startUrl.slice('fixture:'.length);
  }
  return startUrl;
}

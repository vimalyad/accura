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
  // A shadcn/react-hook-form style form: Name input + Description textarea with
  // client-side validation, mirroring https://ui.shadcn.com/docs/forms/react-hook-form
  // but deterministic and offline so the agent demo never depends on the live web.
  '/shadcn-form': `
<html><head><title>React Hook Form</title>
<style>
  body { font: 15px ui-sans-serif, system-ui; max-width: 560px; margin: 48px auto; color: #0a0a0a; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; }
  label { font-weight: 600; }
  .desc { color: #71717a; font-size: 13px; }
  input, textarea { border: 1px solid #e4e4e7; border-radius: 8px; padding: 8px 12px; font: inherit; }
  textarea { min-height: 90px; }
  button { background: #18181b; color: #fafafa; border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; cursor: pointer; }
  .error { color: #dc2626; font-size: 13px; display: none; }
  [data-invalid] input, [data-invalid] textarea { border-color: #dc2626; }
</style></head><body>
  <h1>Create profile</h1>
  <form id="f" novalidate>
    <div class="field" id="name-field">
      <label for="name">Name</label>
      <input id="name" name="name" type="text" placeholder="Your name" aria-invalid="false">
      <span class="error" id="name-error">Name is required.</span>
    </div>
    <div class="field" id="description-field">
      <label for="description">Description</label>
      <textarea id="description" name="description" placeholder="Tell us about yourself" aria-invalid="false"></textarea>
      <span class="desc">A short bio shown on your public profile.</span>
      <span class="error" id="description-error">Description is required.</span>
    </div>
    <button type="submit">Submit</button>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('name').value.trim();
      const description = document.getElementById('description').value.trim();
      let valid = true;
      for (const [id, value] of [['name', name], ['description', description]]) {
        const field = document.getElementById(id + '-field');
        const input = document.getElementById(id);
        const ok = value.length > 0;
        valid = valid && ok;
        input.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (ok) field.removeAttribute('data-invalid'); else field.setAttribute('data-invalid', 'true');
        document.getElementById(id + '-error').style.display = ok ? 'none' : 'block';
      }
      if (!valid) return;
      const msg = document.createElement('div');
      msg.id = 'msg';
      msg.textContent = 'Profile saved for ' + name + ' — ' + description;
      document.body.appendChild(msg);
    });
  </script>
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

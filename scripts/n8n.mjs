// Tiny n8n API client. Reads N8N_API_KEY from .env; never prints it.
// Usage: node scripts/n8n.mjs <METHOD> <path> [jsonFile]   e.g. GET /workflows
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
export const BASE = 'https://agency-report-demo.onrender.com';

export async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!(res.headers.get("content-type") || "").includes("json")) throw new Error(`${method} ${path} → ${res.status} non-JSON: ${(text.match(/<title>[^<]*/) || [text.slice(0, 120)])[0]}`);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [method, path, file] = process.argv.slice(2);
  if (method) console.log(JSON.stringify(await api(method, path, file && JSON.parse(readFileSync(file, 'utf8'))), null, 2));
}

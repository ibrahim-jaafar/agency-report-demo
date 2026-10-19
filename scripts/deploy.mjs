// Upload dist/*.json to n8n (update by name, else create), wire the error workflow, publish.
// Usage: node scripts/make-templates.mjs && node scripts/deploy.mjs
import { readFileSync } from 'node:fs';
import { buildAll } from './build-workflows.mjs';
import { api } from './n8n.mjs';

const ORDER = ['error-handler', 'demo-status', 'demo-run'];
buildAll();
const existing = (await api('GET', '/workflows?limit=100')).data;
const ids = {};
for (const name of ORDER) {
  const wf = JSON.parse(readFileSync(new URL(`../dist/${name}.json`, import.meta.url), 'utf8'));
  if (name === 'demo-run') wf.settings.errorWorkflow = ids['error-handler'];
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
  const found = existing.find(w => w.name === name);
  const saved = found ? await api('PUT', `/workflows/${found.id}`, body) : await api('POST', '/workflows', body);
  ids[name] = saved.id;
  await api('POST', `/workflows/${saved.id}/activate`);
  console.log(`${found ? 'updated' : 'created'} ${name} (${saved.id})`);
}

// Injects the tested lib/ code into n8n Code nodes that contain the /*@lib*/ marker.
// Usage: node scripts/build-workflows.mjs [srcDir] [distDir]
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIB_ORDER = ['rng', 'scenario', 'leads', 'spend', 'kpis', 'checks', 'meta', 'ai', 'limits', 'report'];
const MARKER = '/*@lib*/';

export function libSource() {
  return LIB_ORDER.map(name => readFileSync(join(ROOT, 'lib', `${name}.js`), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')).join('\n');
}

export function buildWorkflow(template, lib) {
  const out = structuredClone(template);
  for (const node of out.nodes || []) {
    const code = node.type === 'n8n-nodes-base.code' && node.parameters?.jsCode;
    if (code && code.includes(MARKER)) node.parameters.jsCode = code.replace(MARKER, () => lib); // a function, so "$$" in lib stays "$$"
  }
  return out;
}

export function buildAll(srcDir = join(ROOT, 'workflows/src'), distDir = join(ROOT, 'dist')) {
  const lib = libSource();
  mkdirSync(distDir, { recursive: true });
  const files = readdirSync(srcDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const tpl = JSON.parse(readFileSync(join(srcDir, f), 'utf8'));
    writeFileSync(join(distDir, f), JSON.stringify(buildWorkflow(tpl, lib), null, 2));
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('built:', buildAll(process.argv[2], process.argv[3]).join(', '));
}

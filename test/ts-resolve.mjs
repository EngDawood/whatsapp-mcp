// The source imports './x.js' (what the bundler wants); under node the file is './x.ts'.
// 'cloudflare:workers' only exists in the Workers runtime; tests get empty base classes.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const WORKERS = 'data:text/javascript,' + encodeURIComponent('export class RpcTarget {} export class DurableObject {}');
export async function resolve(spec, ctx, next) {
  // the Workers runtime module, for code that only needs its base classes to exist
  if (spec === 'cloudflare:workers') return { url: WORKERS, shortCircuit: true };
  if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.startsWith('file:')) {
    const ts = new URL(spec.slice(0, -3) + '.ts', ctx.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, ctx);
  }
  return next(spec, ctx);
}`));

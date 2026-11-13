// Demo-only stand-in for OxideGate, used to record the GIFs in this folder.
// Serves INVENTED sample data on 127.0.0.1:8898 and seeds a throwaway HOME
// with a matching MCP snapshot. Never used by the package or the tests.
//   node docs/media/demo-proxy.mjs <fake-home-dir>
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.argv[2];
if (!home) throw new Error('usage: demo-proxy.mjs <fake-home-dir>');
mkdirSync(join(home, '.config', 'mcp-savings'), { recursive: true });
writeFileSync(
  join(home, '.config', 'mcp-savings', 'snapshot.json'),
  JSON.stringify({
    timestamp: Date.now(),
    mcpMeasurement: [
      { server: 'github', enabled: true, tokens: 5400, bytes: 21300, ok: true },
      { server: 'filesystem', enabled: true, tokens: 1900, bytes: 7600, ok: true },
      { server: 'context7', enabled: true, tokens: 1200, bytes: 4900, ok: true },
      { server: 'postgres', enabled: true, tokens: 900, bytes: 3500, ok: true },
    ],
  }),
);

const entry = (i) => ({
  timestamp: new Date(Date.now() - (9 - i) * 60_000).toISOString(),
  model: 'claude-sonnet-demo',
  upstream: 'anthropic',
  client: 'demo-client/1.0 (external, cli)',
  tools_by_server: [
    { server: '(native)', kind: 'native', tools: 6, bytes: 2410 },
    { server: 'github', kind: 'mcp', tools: 24, bytes: 21300 },
    { server: 'filesystem', kind: 'mcp', tools: 11, bytes: 7600 },
    { server: 'context7', kind: 'mcp', tools: 2, bytes: 4900 },
    { server: 'postgres', kind: 'mcp', tools: 4, bytes: 3500 },
  ],
  context_tools_bytes: null,
  tools_overhead_bytes: 41,
});
const requests = Array.from({ length: 10 }, (_, i) => entry(i));
const version = {
  contract: 1,
  endpoints: ['/health', '/stats', '/sessions', '/requests', '/mcp', '/history'],
  fields: ['tool_names', 'session'],
  oxidegate: '0.13.0',
};
const sessions = {
  saturated: false,
  sessions: [
    { key: 'ses_demo_a1', is_session: true, source: 'explicit', cost_usd: 0.883174, requests: 26, input_tokens: 735589, cache_read_tokens: 410220, output_tokens: 4200, fixed_toll: { hooks: null, instructions: null, skills: { bytes: 6839, seen_in: 25 } } },
    { key: 'ses_demo_b2', is_session: true, source: 'explicit', cost_usd: 0.214802, requests: 9, input_tokens: 188340, cache_read_tokens: 90100, output_tokens: 1750, fixed_toll: { hooks: null, instructions: null, skills: null } },
    { key: 'unattributed', is_session: false, source: 'unattributed', cost_usd: 0, requests: 3, input_tokens: 12004, cache_read_tokens: 0, output_tokens: 0, fixed_toll: { hooks: null, instructions: null, skills: null } },
  ],
};
const routes = { '/health': { status: 'ok' }, '/version': version, '/requests': requests, '/stats': [], '/sessions': sessions };
createServer((req, res) => {
  const body = routes[req.url.split('?')[0]];
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'not found' }));
}).listen(8898, '127.0.0.1');

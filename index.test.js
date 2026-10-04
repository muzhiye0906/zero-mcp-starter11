import { describe, expect, it, vi } from 'vitest';
import worker, { isAllowedOrigin } from './index.js';

const env = {
  ALLOWED_ORIGINS: 'https://freverzeroloveowo.top,https://localhost',
  JINA_API_KEY: 'jina-secret',
  WEATHERAPI_KEY: 'weather-secret',
};

const originRequest = (origin) => new Request('https://worker.test/mcp/search', { headers: { Origin: origin } });

const call = (path, { origin = 'https://freverzeroloveowo.top', method = 'tools/list', name = '', target = '' } = {}) => worker.fetch(new Request(`https://worker.test${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: origin,
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...(name ? { 'Mcp-Name': name } : {}),
    ...(target ? { 'X-Zero-Mcp-Target': target } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params: name ? { name, arguments: {} } : {} }),
}), env);

describe('zero-mcp-starter worker', () => {
  it('accepts the production site and the Capacitor Android origin', () => {
    // Android 应用的页面来源是 https://localhost；缺这一项会让手机端全部被 403 拒绝。
    expect(isAllowedOrigin(originRequest('https://freverzeroloveowo.top'), env)).toBe(true);
    expect(isAllowedOrigin(originRequest('https://localhost'), env)).toBe(true);
    expect(isAllowedOrigin(originRequest('https://evil.example'), env)).toBe(false);
  });

  it('withholds CORS from unknown origins and blocks them from the relay', async () => {
    const search = await call('/mcp/search', { origin: 'https://evil.example' });
    expect(search.status).toBe(200);
    expect(search.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const relay = await call('/mcp/relay', { origin: 'https://evil.example', target: 'https://remote.example/mcp' });
    expect(relay.status).toBe(403);
    expect(relay.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('exposes the two Search tools', async () => {
    const payload = await (await call('/mcp/search')).json();
    expect(payload.result.tools.map((tool) => tool.name)).toEqual(['search_web', 'read_webpage']);
  });

  it('serves the relay route so custom MCP servers do not hit a 404', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: {} }), { headers: { 'Content-Type': 'application/json' } }));
    const response = await call('/mcp/relay', { target: 'https://remote.example/mcp' });
    const [url] = fetchMock.mock.calls[0];
    expect(response.status).toBe(200);
    expect(url).toBe('https://remote.example/mcp');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://freverzeroloveowo.top');
    fetchMock.mockRestore();
  });

  it('refuses to relay to a private address', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await call('/mcp/relay', { target: 'https://127.0.0.1/mcp' });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('returns 404 for unknown paths', async () => {
    const response = await call('/mcp/unknown');
    expect(response.status).toBe(404);
  });
});

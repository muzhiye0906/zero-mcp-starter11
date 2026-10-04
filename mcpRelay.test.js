import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { assertSafeMcpTarget, relayMcpRequest } from './mcpRelay.js';

const env = { ALLOWED_ORIGINS: 'https://freverzeroloveowo.top,http://192.168.1.4:3001,http://localhost:3001' };

function relayRequest(method, params = {}, target = 'https://blog.mcp.cloudflare.com/mcp') {
  return new Request('https://my-zero-mcp.example/mcp/relay', {
    method: 'POST',
    headers: {
      Origin: 'http://192.168.1.4:3001',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      'X-Zero-Mcp-Target': target,
      ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'request-1', method, params }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Zero MCP relay target validation', () => {
  it('accepts a public HTTPS MCP target', () => {
    expect(assertSafeMcpTarget('https://blog.mcp.cloudflare.com/mcp').href).toBe('https://blog.mcp.cloudflare.com/mcp');
  });

  it.each([
    ['http target', 'http://example.com/mcp'],
    ['localhost', 'https://localhost/mcp'],
    ['private IPv4', 'https://192.168.1.2/mcp'],
    ['link-local IPv4', 'https://169.254.169.254/latest/meta-data'],
    ['IPv6 loopback', 'https://[::1]/mcp'],
    ['internal hostname', 'https://service.internal/mcp'],
  ])('rejects %s', (_label, target) => {
    expect(() => assertSafeMcpTarget(target)).toThrow();
  });

  it('rejects redirects instead of following an unsafe location', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/mcp' } }));
    await expect(relayMcpRequest(relayRequest('tools/list'), { fetchImpl })).rejects.toMatchObject({ code: 'MCP_RELAY_REDIRECT_REJECTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Zero MCP relay routing', () => {
  it('answers LAN development CORS preflight with relay headers', async () => {
    const response = await worker.fetch(new Request('https://my-zero-mcp.example/mcp/relay', {
      method: 'OPTIONS',
      headers: { Origin: 'http://192.168.1.4:3001' },
    }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://192.168.1.4:3001');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Zero-Mcp-Target');
  });

  it('relays tools/list with the original JSON-RPC body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'request-1', result: { tools: [{ name: 'search' }] } }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchImpl);
    const request = relayRequest('tools/list');
    const expectedBody = await request.clone().text();
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://192.168.1.4:3001');
    const [target, init] = fetchImpl.mock.calls[0];
    expect(target).toBe('https://blog.mcp.cloudflare.com/mcp');
    expect(new TextDecoder().decode(init.body)).toBe(expectedBody);
    expect(init.redirect).toBe('manual');
    expect(await response.json()).toMatchObject({ result: { tools: [{ name: 'search' }] } });
  });

  it('relays tools/call and preserves the MCP tool name', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'request-1', result: { content: [{ type: 'text', text: 'ok' }] } }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchImpl);
    const response = await worker.fetch(relayRequest('tools/call', { name: 'search', arguments: { query: 'Zero' } }), env);
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls[0][1].headers.get('Mcp-Name')).toBe('search');
  });

  it('keeps builtin Search and Weather on their direct endpoints', async () => {
    for (const path of ['/mcp/search', '/mcp/weather']) {
      const response = await worker.fetch(new Request(`https://my-zero-mcp.example${path}`, {
        method: 'POST',
        headers: {
          Origin: 'http://192.168.1.4:3001',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'builtin', method: 'tools/list', params: {} }),
      }), env);
      expect(response.status).toBe(200);
      expect((await response.json()).result.tools).toHaveLength(2);
    }
  });
});

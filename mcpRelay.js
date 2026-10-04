export const MAX_RELAY_BODY_BYTES = 256 * 1024;
export const MAX_RELAY_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

const ALLOWED_REQUEST_HEADERS = Object.freeze([
  'Accept',
  'Content-Type',
  'MCP-Protocol-Version',
  'Mcp-Method',
  'Mcp-Name',
  'Authorization',
  'X-API-Key',
]);

const ALLOWED_RESPONSE_HEADERS = Object.freeze([
  'Content-Type',
  'MCP-Protocol-Version',
  'Mcp-Session-Id',
  'Retry-After',
]);

const INTERNAL_HOST_SUFFIXES = Object.freeze([
  '.local',
  '.localhost',
  '.internal',
  '.localdomain',
  '.home',
  '.home.arpa',
  '.lan',
]);

export class McpRelayError extends Error {
  constructor(message, { status = 400, code = 'MCP_RELAY_INVALID_REQUEST' } = {}) {
    super(message);
    this.name = 'McpRelayError';
    this.status = status;
    this.code = code;
  }
}

function parseIpv4(hostname) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
  const octets = hostname.split('.').map(Number);
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function isBlockedIpv4(octets) {
  const [first, second, third] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isBlockedIpv6(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!value.includes(':')) return false;
  if (value === '::' || value === '::1' || value.startsWith('::ffff:')) return true;
  const first = value.split(':')[0];
  if (first === 'fc' || first === 'fd' || first.startsWith('fc') || first.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(first) || first.startsWith('ff')) return true;
  if (value.startsWith('2001:db8:')) return true;
  return false;
}

export function assertSafeMcpTarget(value) {
  let target;
  try { target = new URL(String(value || '').trim()); } catch {
    throw new McpRelayError('Invalid MCP relay target', { code: 'MCP_RELAY_TARGET_INVALID' });
  }
  if (target.protocol !== 'https:') throw new McpRelayError('MCP relay target must use HTTPS', { code: 'MCP_RELAY_TARGET_HTTPS_REQUIRED' });
  if (target.username || target.password) throw new McpRelayError('MCP relay target cannot include credentials', { code: 'MCP_RELAY_TARGET_CREDENTIALS' });
  if (target.hash) throw new McpRelayError('MCP relay target cannot include a fragment', { code: 'MCP_RELAY_TARGET_FRAGMENT' });

  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const ipv6Literal = hostname.includes(':');
  if (!hostname || hostname === 'localhost' || (!hostname.includes('.') && !ipv6Literal)) {
    throw new McpRelayError('MCP relay target hostname is not public', { code: 'MCP_RELAY_TARGET_PRIVATE' });
  }
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new McpRelayError('MCP relay target hostname is internal', { code: 'MCP_RELAY_TARGET_PRIVATE' });
  }
  const ipv4 = parseIpv4(hostname);
  if ((ipv4 && isBlockedIpv4(ipv4)) || isBlockedIpv6(hostname)) {
    throw new McpRelayError('MCP relay target address is not public', { code: 'MCP_RELAY_TARGET_PRIVATE' });
  }
  return target;
}

function isAllowedMcpRpcMethod(method) {
  return method === 'initialize'
    || method === 'ping'
    || method === 'notifications/initialized'
    || /^(tools|resources|prompts|logging|completion)\/[a-z0-9_.-]+$/i.test(method);
}

async function readRelayBody(request) {
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_RELAY_BODY_BYTES) throw new McpRelayError('MCP relay request is too large', { status: 413, code: 'MCP_RELAY_BODY_TOO_LARGE' });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_RELAY_BODY_BYTES) throw new McpRelayError('MCP relay request is too large', { status: 413, code: 'MCP_RELAY_BODY_TOO_LARGE' });
  return body;
}

function validateMcpPayload(body, request) {
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(body)); } catch {
    throw new McpRelayError('MCP relay body must be valid JSON', { code: 'MCP_RELAY_BODY_INVALID' });
  }
  const method = String(payload?.method || '');
  if (payload?.jsonrpc !== '2.0' || !isAllowedMcpRpcMethod(method)) {
    throw new McpRelayError('Unsupported MCP JSON-RPC method', { code: 'MCP_RELAY_METHOD_REJECTED' });
  }
  const methodHeader = request.headers.get('Mcp-Method');
  if (!methodHeader || methodHeader !== method) {
    throw new McpRelayError('MCP method header mismatch', { code: 'MCP_RELAY_METHOD_MISMATCH' });
  }
}

function buildUpstreamHeaders(request) {
  const headers = new Headers();
  for (const name of ALLOWED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function buildRelayResponseHeaders(upstream) {
  const headers = new Headers();
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function relayMcpRequest(request, { fetchImpl = fetch } = {}) {
  if (request.method !== 'POST') throw new McpRelayError('Method not allowed', { status: 405, code: 'MCP_RELAY_HTTP_METHOD_REJECTED' });
  const contentType = request.headers.get('Content-Type') || '';
  const accept = request.headers.get('Accept') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new McpRelayError('MCP relay requires application/json', { status: 415, code: 'MCP_RELAY_CONTENT_TYPE_REJECTED' });
  }
  if (!/application\/json|text\/event-stream/i.test(accept)) {
    throw new McpRelayError('MCP relay requires an MCP Accept header', { status: 406, code: 'MCP_RELAY_ACCEPT_REJECTED' });
  }

  const target = assertSafeMcpTarget(request.headers.get('X-Zero-Mcp-Target'));
  const body = await readRelayBody(request);
  validateMcpPayload(body, request);

  const upstream = await fetchImpl(target.href, {
    method: 'POST',
    headers: buildUpstreamHeaders(request),
    body,
    redirect: 'manual',
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    throw new McpRelayError('MCP relay does not follow redirects', { status: 502, code: 'MCP_RELAY_REDIRECT_REJECTED' });
  }

  const upstreamType = upstream.headers.get('Content-Type') || '';
  if (upstream.status !== 204 && !/application\/json|text\/event-stream/i.test(upstreamType)) {
    throw new McpRelayError('Unsupported MCP upstream response type', { status: 502, code: 'MCP_RELAY_RESPONSE_TYPE_REJECTED' });
  }

  const responseHeaders = buildRelayResponseHeaders(upstream);
  if (/application\/json/i.test(upstreamType)) {
    const responseBody = await upstream.arrayBuffer();
    if (responseBody.byteLength > MAX_RELAY_JSON_RESPONSE_BYTES) {
      throw new McpRelayError('MCP relay response is too large', { status: 502, code: 'MCP_RELAY_RESPONSE_TOO_LARGE' });
    }
    return new Response(responseBody, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

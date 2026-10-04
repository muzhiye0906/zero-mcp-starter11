import { McpRelayError, relayMcpRequest } from './mcpRelay.js';

const PROTOCOL_VERSION = '2026-07-28';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const SEARCH_HOST = 's.jina.ai';
const READER_HOST = 'r.jina.ai';
const WEATHER_HOST = 'api.weatherapi.com';
export function isAllowedOrigin(request, env) {
  const origin = request?.headers.get('Origin');
  const configured = String(env?.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return Boolean(origin && configured.includes(origin));
}

function corsHeaders(request, env) {
  const origin = request?.headers.get('Origin');
  const allowedOrigin = isAllowedOrigin(request, env) ? origin : '';
  return {
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Zero-Mcp-Target, Authorization, X-API-Key',
    'Access-Control-Expose-Headers': 'Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Retry-After',
    Vary: 'Origin',
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200, request, env) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) } });
}

function rpc(id, result, request, env) { return json({ jsonrpc: '2.0', id, result }, 200, request, env); }
function rpcError(id, code, message, request, env) { return json({ jsonrpc: '2.0', id, error: { code, message } }, 200, request, env); }

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new Error('request too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('request too large');
  return JSON.parse(text);
}

async function fetchLimited(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect missing location');
      const target = new URL(location, url);
      if (target.hostname !== new URL(url).hostname || !(await isSafePublicUrl(target))) throw new Error('unsafe redirect');
      return fetchLimited(target.href, options, timeoutMs);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
    return { response, text };
  } finally { clearTimeout(timer); }
}

async function isSafePublicUrl(value) {
  if (!['http:', 'https:'].includes(value.protocol)) return false;
  const hostname = value.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1' || hostname.endsWith('.local')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) return false;
  if (hostname.startsWith('172.')) {
    const second = Number(hostname.split('.')[1]);
    if (second >= 16 && second <= 31) return false;
  }
  // DNS rebinding/private IP validation is delegated to Cloudflare's resolver boundary in P0.
  return true;
}

function toolsFor(path) {
  if (path.endsWith('/search')) return [
    { name: 'search_web', title: 'Search web', description: 'Search public web pages.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] } },
    { name: 'read_webpage', title: 'Read webpage', description: 'Read the main text of a public webpage.', inputSchema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } },
  ];
  return [
    { name: 'get_current_weather', title: 'Current weather', description: 'Get current weather for a location.', inputSchema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
    { name: 'get_weather_forecast', title: 'Weather forecast', description: 'Get a short weather forecast.', inputSchema: { type: 'object', properties: { location: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 7 } }, required: ['location'] } },
  ];
}

async function searchWeb(args, env) {
  const query = String(args?.query || '').trim();
  if (!query) throw new Error('query is required');
  const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 5));
  const { response, text } = await fetchLimited(`https://${SEARCH_HOST}/?q=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${env.JINA_API_KEY}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error('search upstream failed');
  let payload;
  try { payload = JSON.parse(text); } catch { payload = {}; }
  return normalizeSearchResults(payload.data || payload.results || [], maxResults);
}

export function normalizeSearchResults(items, maxResults = 5) {
  const limit = Math.min(10, Math.max(1, Number(maxResults) || 5));
  return { results: items.slice(0, limit).map((item) => ({ title: String(item.title || '').slice(0, 200), url: String(item.url || ''), content: String(item.content || item.description || item.snippet || '').slice(0, 1200) })) };
}

async function readWebpage(args) {
  const target = new URL(String(args?.url || ''));
  if (!(await isSafePublicUrl(target))) throw new Error('unsafe URL');
  const { response, text } = await fetchLimited(`https://${READER_HOST}/${target.href}`, { headers: { Accept: 'text/plain' } });
  if (!response.ok) throw new Error('reader upstream failed');
  return { url: target.href, content: text.slice(0, 30000) };
}

async function weather(args, env, forecast = false) {
  const location = String(args?.location || '').trim();
  if (!location) throw new Error('location is required');
  const days = Math.min(7, Math.max(1, Number(args?.days) || 1));
  const endpoint = forecast ? 'forecast.json' : 'current.json';
  const url = `https://${WEATHER_HOST}/v1/${endpoint}?q=${encodeURIComponent(location)}&days=${days}&aqi=no&alerts=no`;
  const { response, text } = await fetchLimited(url, { headers: { key: env.WEATHERAPI_KEY } });
  if (!response.ok) throw new Error('weather upstream failed');
  const data = JSON.parse(text);
  if (!forecast) return { location: data.location?.name, country: data.location?.country, localTime: data.location?.localtime, condition: data.current?.condition?.text, temperatureC: data.current?.temp_c, feelsLikeC: data.current?.feelslike_c, humidity: data.current?.humidity, windKph: data.current?.wind_kph, precipMm: data.current?.precip_mm };
  return { location: data.location?.name, country: data.location?.country, forecast: (data.forecast?.forecastday || []).map((day) => ({ date: day.date, condition: day.day?.condition?.text, maxTempC: day.day?.maxtemp_c, minTempC: day.day?.mintemp_c, chanceOfRain: day.day?.daily_chance_of_rain, sunrise: day.astro?.sunrise, sunset: day.astro?.sunset })) };
}

async function handle(request, env, path) {
  const body = await readJson(request);
  const id = body.id;
  const method = body.method;
  if (request.headers.get('MCP-Protocol-Version') !== PROTOCOL_VERSION) return rpcError(id, -32001, 'Unsupported MCP protocol version', request, env);
  if (request.headers.get('Mcp-Method') !== method) return rpcError(id, -32600, 'MCP method header mismatch', request, env);
  if (method === 'tools/list') return rpc(id, { tools: toolsFor(path) }, request, env);
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found', request, env);
  if (request.headers.get('Mcp-Name') !== body.params?.name) return rpcError(id, -32600, 'MCP name header mismatch', request, env);
  const args = body.params?.arguments || {};
  try {
    let structuredContent;
    if (path.endsWith('/search') && body.params?.name === 'search_web') structuredContent = await searchWeb(args, env);
    else if (path.endsWith('/search') && body.params?.name === 'read_webpage') structuredContent = await readWebpage(args);
    else if (path.endsWith('/weather') && body.params?.name === 'get_current_weather') structuredContent = await weather(args, env);
    else if (path.endsWith('/weather') && body.params?.name === 'get_weather_forecast') structuredContent = await weather(args, env, true);
    else return rpcError(id, -32602, 'Unknown tool', request, env);
    return rpc(id, { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false }, request, env);
  } catch (error) { return rpc(id, { content: [{ type: 'text', text: 'Tool request failed' }], isError: true }, request, env); }
}

export default { async fetch(request, env) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  if (request.method === 'OPTIONS') {
    if (path === '/mcp/relay' && !isAllowedOrigin(request, env)) return json({ error: 'Origin not allowed' }, 403, request, env);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (path === '/mcp/relay') {
    if (!isAllowedOrigin(request, env)) return json({ error: 'Origin not allowed' }, 403, request, env);
    try { return withCors(await relayMcpRequest(request), request, env); } catch (error) {
      if (error instanceof McpRelayError) return json({ error: { code: error.code, message: error.message } }, error.status, request, env);
      return json({ error: { code: 'MCP_RELAY_UPSTREAM_FAILED', message: 'MCP relay request failed' } }, 502, request, env);
    }
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, request, env);
  if (path !== '/mcp/search' && path !== '/mcp/weather') return json({ error: 'Not found' }, 404, request, env);
  try { return await handle(request, env, path); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400, request, env); }
} };

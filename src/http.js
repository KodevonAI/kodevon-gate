// fetch con JSON, timeout y errores legibles.
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body && typeof body !== 'string' && !(body instanceof URLSearchParams)
        ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body && typeof body !== 'string' && !(body instanceof URLSearchParams) ? JSON.stringify(body) : body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${method} ${url.split('?')[0]}: ${text.slice(0, 500)}`);
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

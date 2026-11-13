const path = '/servicelayer/api/idm/account/soip/login';

export async function handleLogin(request, env, upstreamFetch = fetch) {
    const headers = new Headers({'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'Vary': 'Origin'});
    const reply = (status, data) => new Response(JSON.stringify(data), {status, headers});
    const origin = request.headers.get('Origin');
    if (origin && origin !== 'null' && origin !== 'file://') return reply(403, {error: 'Origin is not allowed'});
    if (origin) headers.set('Access-Control-Allow-Origin', origin);
    const url = new URL(request.url);
    if (url.pathname !== path || url.search !== '?isocode=IE') return reply(404, {error: 'Unknown endpoint'});
    if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Methods', 'POST');
        headers.set('Access-Control-Allow-Headers', 'Content-Type, X-RTE-Helper-Key');
        headers.set('Access-Control-Max-Age', '600');
        return new Response(null, {status: 204, headers});
    }
    if (!env.SECRET_KEY) return reply(503, {error: 'Worker needs configuration'});
    const supplied = request.headers.get('X-RTE-Helper-Key') || '';
    // Hash both values before a fixed-length comparison.
    const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    const expected = new Uint8Array(await digest(env.SECRET_KEY));
    const actual = new Uint8Array(await digest(supplied));
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
    if (difference !== 0) return reply(403, {error: 'Invalid helper key'});
    if (request.method !== 'POST') return reply(405, {error: 'POST is required'});
    const reader = request.body?.getReader();
    let body = '', size = 0;
    try {
        if (!reader) return reply(400, {error: 'Missing body'});
        const decoder = new TextDecoder();
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1024) {
                await reader.cancel();
                return reply(413, {error: 'Request is too large'});
            }
            body += decoder.decode(value, {stream: true});
        }
        body += decoder.decode();
        const data = JSON.parse(body);
        if (!data || Object.keys(data).length !== 1 || typeof data.deviceId !== 'string' || !/^\d{15}$/.test(data.deviceId)) {
            return reply(400, {error: 'A 15 digit deviceId is required'});
        }
    } catch {
        return reply(400, {error: 'Invalid body'});
    }
    try {
        const response = await upstreamFetch('https://www.rte.ie' + path + '?isocode=IE', {
            method: 'POST', headers: {'Accept': '*/*', 'Content-Type': 'application/json'},
            body, redirect: 'manual', signal: AbortSignal.timeout(15000)
        });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            return reply(502, {error: 'Unexpected RTÉ redirect'});
        }
        return new Response(response.body, {status: response.status, headers});
    } catch {
        return reply(502, {error: 'RTÉ login request failed'});
    }
}

export default {fetch(request, env) { return handleLogin(request, env); }};

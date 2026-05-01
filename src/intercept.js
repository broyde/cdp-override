import http from 'node:http';
import https from 'node:https';

export async function start(cdp, mod) {
  cdp.onEvent = (method, params) => {
    if (method === 'Fetch.requestPaused') {
      handlePaused(cdp, mod, params);
    }
  };
  await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*'}]});
  await reloadExistingPages(cdp);
}

async function reloadExistingPages(cdp) {
  const {targetInfos} = await cdp.send('Target.getTargets');
  for (const t of targetInfos) {
    if (t.type !== 'page' || !t.url.startsWith('http')) {
      continue;
    }

    const {sessionId} = await cdp.send('Target.attachToTarget', {targetId: t.targetId, flatten: true});
    try {
      await cdp.send('Page.reload', {ignoreCache: true}, sessionId);
    } finally {
      await cdp.send('Target.detachFromTarget', {sessionId}).catch(() => {});
    }
  }
}

async function handlePaused(cdp, {replace, resolve}, {requestId, request}) {
  let result;
  try {
    result = await replace(request.url);
  } catch (e) {
    console.error('replace() threw:', e);
  }

  if (!result || result === request.url) {
    return cdp.send('Fetch.continueRequest', {requestId}).catch(() => {});
  }

  if (typeof result === 'object') {
    return fulfillInline(cdp, requestId, result);
  }

  const url = new URL(result);
  const headers = copyHeaders(request.headers);
  if (resolve) {
    try {
      const newHost = await resolve(url.host);
      if (newHost && newHost !== url.host) {
        headers.Host = url.host;
        url.host = newHost;
      }
    } catch (e) {
      console.error('resolve() threw:', e);
    }
  }

  try {
    const res = await rawFetch(url.toString(), headers);
    const {body, headers: responseHeaders} = await inlineSourceMap(res.body, res.headers, url.toString(), headers);
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: res.status,
      responseHeaders,
      body: body.toString('base64'),
    });
  } catch (e) {
    console.error(`fetch failed for ${url}:`, e.message);
    await cdp.send('Fetch.failRequest', {requestId, errorReason: 'Failed'}).catch(() => {});
  }
}

async function inlineSourceMap(body, headers, baseUrl, fetchHeaders) {
  const ct = headers.find((h) => h.name.toLowerCase() === 'content-type');
  if (!ct) {
    return {body, headers};
  }

  const isJs = /javascript|ecmascript/i.test(ct.value);
  const isCss = !isJs && /\bcss\b/i.test(ct.value);
  if (!isJs && !isCss) {
    return {body, headers};
  }

  const findRe = isJs ? /\/\/[#@]\s*sourceMappingURL=(\S+)/ : /\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\//;
  const stripRe = isJs ? /\/\/[#@]\s*sourceMappingURL=\S+/g : /\/\*[#@]\s*sourceMappingURL=\S+?\s*\*\//g;

  let mapUrl = null;
  const smHeader = headers.find((h) => h.name.toLowerCase() === 'sourcemap');
  if (smHeader) {
    mapUrl = smHeader.value;
  }

  let text;
  if (!mapUrl) {
    text = body.toString('utf8');
    const m = text.match(findRe);
    if (m) {
      mapUrl = m[1];
    }
  }
  if (!mapUrl) {
    return {body, headers};
  }

  let mapBuf;
  try {
    const resolved = new URL(mapUrl, baseUrl).toString();
    ({body: mapBuf} = await rawFetch(resolved, fetchHeaders));
  } catch (e) {
    console.error(`source map fetch failed:`, e.message);
    return {body, headers};
  }

  const newHeaders = headers.filter((h) => h.name.toLowerCase() !== 'sourcemap');
  if (text === undefined) {
    text = body.toString('utf8');
  }
  text = text.replace(stripRe, '').replace(/\s+$/, '');
  const dataUrl = `data:application/json;base64,${mapBuf.toString('base64')}`;
  text += isJs ? `\n//# sourceMappingURL=${dataUrl}\n` : `\n/*# sourceMappingURL=${dataUrl} */\n`;

  return {body: Buffer.from(text, 'utf8'), headers: newHeaders};
}

function copyHeaders(src = {}) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith(':')) {
      continue;
    }
    if (k.toLowerCase() === 'host') {
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function fulfillInline(cdp, requestId, {status = 200, headers = {}, body = ''}) {
  const buf = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body));
  const responseHeaders = Object.entries(headers).map(([name, value]) => ({name, value: String(value)}));
  await cdp
    .send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders,
      body: buf.toString('base64'),
    })
    .catch(() => {});
}

function rawFetch(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https:') ? https : http;
    const req = lib.request(urlStr, {method: 'GET', headers}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const responseHeaders = [];
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) {
              responseHeaders.push({name, value: v});
            }
          } else {
            responseHeaders.push({name, value: String(value)});
          }
        }
        resolve({
          status: res.statusCode ?? 502,
          headers: responseHeaders,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

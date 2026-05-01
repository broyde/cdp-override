export async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, {once: true});
    ws.addEventListener('error', fail, {once: true});
  });

  let nextId = 1;
  const pending = new Map();

  const client = {
    onEvent: null,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      ws.send(JSON.stringify({id, method, params, sessionId}));
      return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
    },
    close: () => ws.close(),
  };

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method) {
      client.onEvent?.(msg.method, msg.params, msg.sessionId);
    }
  });

  return client;
}

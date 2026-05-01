export function replace(url) {
  // Forward to a local file:
  if (url === 'https://example.com/test') {
    return 'http://example.local/test';
  }

  // Custom inline response:
  if (url === 'https://example.com/api/ping') {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    };
  }

  // Redirect:
  if (url === 'https://example.com/') {
    return { status: 302, headers: { Location: '/index.html' } };
  }

  // Anything else: undefined → pass through to the live origin.
}

export function resolve(host) {
  // Map the logical host returned by replace() to a real host:port.
  if (host === 'example.local') {
    return '127.0.0.1:3000';
  }
}

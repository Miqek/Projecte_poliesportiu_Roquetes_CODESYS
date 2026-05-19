window.APP_CONFIG = Object.freeze({
    wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || '127.0.0.1'}:8081`,
    pollMs: 50,
    baseQbOffset: 0
  });
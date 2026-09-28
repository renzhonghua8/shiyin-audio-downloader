(() => {
  // Only a user-bound origin gets this script. The worker checks the origin again.
  if (window !== window.top || window.__shiyinBridgeInstalled) return;
  window.__shiyinBridgeInstalled = true;
  const channel = 'SHIYIN_BROWSER_HELPER_V1';
  const actions = new Set(['ping', 'scan', 'cancelScan', 'download', 'downloadBatch', 'getDownloadStatus']);
  let inFlight = 0;
  const reply = message => window.postMessage({channel, direction: 'to-page', ...message}, window.origin);
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.origin || !message || typeof message !== 'object' || Array.isArray(message) || message.channel !== channel || message.direction !== 'to-helper') return;
    if (typeof message.id !== 'string' || !/^[\w:.-]{1,160}$/.test(message.id) || !actions.has(message.action)) return;
    if (inFlight >= 16) { reply({id: message.id, ok: false, error: {code: 'BUSY', message: '浏览器助手正在处理其他请求，请稍后重试'}}); return; }
    try { if (JSON.stringify(message).length > 20000) return; } catch { return; }
    inFlight++;
    try {
      chrome.runtime.sendMessage({...message, bridgeOrigin: window.origin}, response => {
        inFlight--;
        const failure = chrome.runtime.lastError;
        if (failure || !response) { reply({id: message.id, ok: false, error: {code: 'HELPER_EXPIRED', message: '浏览器助手连接已失效，请重新打开插件连接此网页'}}); return; }
        reply({id: message.id, ok: !!response.ok, ...(response.ok ? {result: response.result} : {error: response.error})});
      });
    } catch { inFlight--; reply({id: message.id, ok: false, error: {code: 'HELPER_EXPIRED', message: '浏览器助手连接已失效，请重新连接'}}); }
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.channel === channel && message.direction === 'to-page' && message.event === 'scan-progress' && typeof message.requestId === 'string') reply({event: 'scan-progress', requestId: message.requestId, message: String(message.message || '').slice(0, 240)});
  });
})();

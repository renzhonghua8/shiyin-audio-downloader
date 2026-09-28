import {validateSiteOrigin} from './core.mjs';
const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
const show = message => {status.textContent = message;};
let activeTab;
connect.disabled = true;
chrome.tabs.query({active: true, currentWindow: true}).then(tabs => {
  activeTab = tabs[0]; connect.disabled = false;
}).catch(() => show('无法读取当前网页，请切换到拾音网页后重新打开插件'));
async function refresh() {
  const response = await chrome.runtime.sendMessage({popupAction: 'status'});
  if (!response?.ok) throw new Error(response?.error?.message || '连接状态读取失败');
  const result = response.result;
  show(result?.siteOrigin ? `已连接：${result.siteOrigin}${result.scanPaused ? '\nB 站页面需要您正常播放或验证，然后回拾音重试。' : ''}` : result?.error || '尚未连接。请先打开自己的拾音网页。');
  disconnect.disabled = !result?.siteOrigin;
}
connect.addEventListener('click', async () => {
  connect.disabled = true;
  try {
    const tab = activeTab;
    const origin = validateSiteOrigin(tab?.url);
    if (new URL(origin).hostname === 'www.bilibili.com' || new URL(origin).hostname.endsWith('.bilivideo.com')) throw new Error('请切换到拾音网页，再点击连接');
    const pattern = origin + '/*';
    // Send the binding intent before the native dialog can close this popup.
    // Do not await here: permissions.request must retain this click's gesture.
    const prepared = chrome.runtime.sendMessage({popupAction: 'prepareBind', origin, tabId: tab.id, pattern});
    prepared.catch(() => {});
    // Invoke the permission request directly in this click's user gesture; do
    // not put an asynchronous tab lookup before the permission request.
    if (!await chrome.permissions.request({origins: [pattern]})) throw new Error('未授予此网站权限，无法连接网页');
    const response = await prepared;
    if (!response?.ok) throw new Error(response?.error?.message || '连接失败，请刷新拾音网页后重试');
    await refresh();
  } catch (error) {show(error.message || '连接失败');}
  finally {connect.disabled = false;}
});
disconnect.addEventListener('click', async () => {
  disconnect.disabled = true;
  try {await chrome.runtime.sendMessage({popupAction: 'disconnect'}); await refresh();}
  catch {show('无法断开，请重试');}
});
refresh().catch(() => show('无法连接浏览器后台，请重新打开插件'));

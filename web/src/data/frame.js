import { messages } from '../messages.js';
import { applyMessages } from '../ui/message-bindings.js';
import { BMLBrowser, keyCodeToAribKey, OverlayInputApplication } from '../../vendor/bml-browser.js';
applyMessages(document);
const session = Number(location.hash.slice(1));
const notify = (type, properties = {}) =>
  parent.postMessage({ type, session, ...properties }, location.origin);
const reportError = () => notify('bml-status', { text: messages.data.pageFailed });
addEventListener('error', reportError);
addEventListener('unhandledrejection', reportError);
const host = document.getElementById('bml');
const input = document.getElementById('input');
const page = document.getElementById('page');
const EXTRA_KEYS = { '*': 101, '#': 102 };
const browser = new BMLBrowser({
  containerElement: host,
  mediaElement: document.createElement('div'),
  tabIndex: 0,
  storagePrefix: '1seg-bml:',
  nvramPrefix: '1seg-bml:',
  broadcasterDatabasePrefix: '1seg-bml:',
  fonts: {
    squareGothic: { source: 'url("./fonts/Kosugi-Regular.woff2")' },
    roundGothic: { source: 'url("./fonts/KosugiMaru-Regular.woff2")' },
    boldRoundGothic: { source: 'url("./fonts/KosugiMaru-Bold.woff2")' },
  },
  inputApplication: new OverlayInputApplication(input),
  ip: { isIPConnected: () => 0 },
  log: { level: 'error' },
  indicator: {
    setUrl: (_, loading) => {
      if (loading) notify('bml-status', { text: messages.data.loading });
    },
    setReceivingStatus: () => {},
    setNetworkingGetStatus: () => {},
    setNetworkingPostStatus: () => {},
    setEventName: () => {},
  },
  showErrorMessage: reportError,
});
let resolution = { width: 240, height: 480 };
function resize() {
  const scale = Math.min(innerWidth / resolution.width, 1);
  host.style.width = `${resolution.width}px`;
  host.style.height = `${resolution.height}px`;
  host.style.transform = `scale(${scale})`;
  page.style.width = `${resolution.width * scale}px`;
  page.style.height = `${resolution.height * scale}px`;
}
browser.addEventListener('load', (event) => {
  resolution = event.detail.resolution;
  resize();
  notify('bml-loaded');
});
addEventListener('resize', resize);
addEventListener('message', (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.session !== session
  )
    return;
  if (event.data.action === 'messages') {
    for (const message of event.data.messages) browser.emitMessage(message);
  } else if (event.data.action === 'key' && Number.isInteger(event.data.key)) {
    browser.content.processKeyDown(event.data.key);
    browser.content.processKeyUp(event.data.key);
  }
});
// Keys focused inside the shadow DOM are handled by web-bml itself.
const handleKey = (event) => {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    input.style.display !== 'none'
  )
    return;
  const extra = EXTRA_KEYS[event.key];
  if (event.composedPath().includes(host) && extra == null) return;
  const key = extra ?? keyCodeToAribKey(event.key);
  if (!(key >= 0)) return;
  if (event.type === 'keydown') {
    event.preventDefault();
    browser.content.processKeyDown(key);
  } else browser.content.processKeyUp(key);
};
addEventListener('keydown', handleKey);
addEventListener('keyup', handleKey);
resize();
notify('bml-ready');

import { messages } from '../messages.js';
import { applyMessages } from '../ui/message-bindings.js';

applyMessages(document);
const app = document.getElementById('rx-cinema');
const startup = document.getElementById('app-startup');
const status = document.getElementById('app-startup-status');
const retry = document.getElementById('app-startup-retry');
retry.onclick = () => location.reload();
try {
  await import('./main.js');
  startup.hidden = true;
  app.hidden = false;
  app.inert = false;
} catch (error) {
  status.textContent = error.message || messages.app.startFailed;
  retry.hidden = false;
}

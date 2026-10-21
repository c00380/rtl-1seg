import { messages } from '../messages.js';
import { setText, setAttribute } from './utils.js';
import {
  tooltipMachine,
  connectTooltip,
  machine,
  connect,
  collection,
  VanillaMachine,
  normalizeProps,
  spreadProps,
} from '../../vendor/select.js';

// Native selects retain the receiver contract. Only a user selection emits change;
// Zag's internal hidden-select bridge is deliberately not bound to those controls.
export class SelectMenus {
  constructor(app, controls, onChange) {
    this.active = null;
    this.onChange = onChange;
    this.menus = [...app.querySelectorAll('[data-dropdown]')].map((root) => {
      const key = root.dataset.dropdown,
        control = controls[key],
        trigger = root.querySelector('.rx-select-button'),
        list = root.querySelector('.rx-select-menu'),
        output = root.querySelector('.rx-select-value'),
        positioner = document.createElement('div');
      const id = 'rx-select-' + key;
      positioner.className = 'rx-select-positioner';
      list.before(positioner);
      positioner.append(list);
      const menu = {
        root,
        key,
        control,
        trigger,
        list,
        output,
        positioner,
        buttons: [],
        items: [],
        cleanups: new Map(),
        optionSignature: null,
        selected: null,
        disabled: null,
      };
      menu.props = {
        id,
        ids: {
          root: root.id || id,
          trigger: trigger.id || id + '-trigger',
          content: list.id,
          positioner: id + '-positioner',
        },
        collection: collection({ items: [] }),
        defaultValue: [],
        loopFocus: true,
        positioning: {
          placement: key === 'transmit-guard' ? 'top-start' : 'bottom-start',
          gutter: 6,
          sameWidth: true,
        },
        onValueChange: ({ value }) => {
          const item = menu.items.find((item) => item.value === value[0]);
          if (!item || item.disabled || control.disabled || control.value === item.nativeValue)
            return;
          control.value = item.nativeValue;
          control.dispatchEvent(new Event('change'));
          this.onChange();
        },
        onOpenChange: ({ open }) => {
          if (open) {
            if (this.active && this.active !== menu) this.close();
            this.active = menu;
          } else if (this.active === menu) this.active = null;
        },
      };
      menu.service = new VanillaMachine(machine, menu.props);
      menu.unsubscribe = menu.service.subscribe(() => this.render(menu));
      menu.service.start();
      this.render(menu);
      return menu;
    });
    window.addEventListener('pagehide', () => this.destroy(), { once: true });
  }

  apply(menu, node, props) {
    menu.cleanups.set(node, spreadProps(node, props));
  }

  render(menu) {
    const api = (menu.api = connect(menu.service.service, normalizeProps));
    this.apply(menu, menu.root, api.getRootProps());
    this.apply(menu, menu.trigger, { ...api.getTriggerProps(), 'aria-labelledby': undefined });
    this.apply(menu, menu.positioner, api.getPositionerProps());
    const contentProps = api.getContentProps();
    this.apply(menu, menu.list, {
      ...contentProps,
      'aria-labelledby': undefined,
      // This inline settings list follows the document's native Tab order.
      // Close without restoring focus so Tab can follow the native DOM order.
      onkeydown: (event) => {
        if (event.key === 'Tab') this.close();
        else contentProps.onkeydown(event);
      },
    });
    this.apply(menu, menu.output, api.getValueTextProps());
    for (let i = 0; i < menu.buttons.length; i++) {
      const item = menu.items[i],
        button = menu.buttons[i];
      this.apply(menu, button, {
        ...api.getItemProps({ item }),
        type: 'button',
        tabindex: -1,
        disabled: item.disabled || api.disabled,
      });
    }
    setText(
      menu.output,
      menu.items.find((item) => item.nativeValue === menu.control.value)?.label ?? '',
    );
  }

  close(restoreFocus = false) {
    const menu = this.active;
    if (!menu) return;
    this.active = null;
    menu.service.send({ type: 'CLOSE', restoreFocus, replaces: 'open' });
  }

  sync(menuKey = null) {
    for (const menu of this.menus) {
      if (menuKey !== null && menu.key !== menuKey) continue;
      const { key, control } = menu;
      const items = [...control.options].map((option) => ({
        value: 'value:' + option.value,
        nativeValue: option.value,
        label:
          key === 'tuner'
            ? option.text.replace(messages.common.physicalChannelPrefix, '')
            : option.value
              ? option.text
              : '',
        disabled: option.disabled,
      }));
      const signature = JSON.stringify(items),
        selected = control.value,
        disabled = control.disabled || !items.some((item) => !item.disabled);
      if (
        menu.optionSignature === signature &&
        menu.selected === selected &&
        menu.disabled === disabled
      )
        continue;
      if (menu.optionSignature !== signature) {
        menu.optionSignature = signature;
        for (const button of menu.buttons) {
          menu.cleanups.get(button)?.();
          menu.cleanups.delete(button);
        }
        menu.items = items;
        menu.buttons = items.map((item) => {
          const button = document.createElement('button'),
            text = document.createElement('strong');
          button.className = 'rx-select-option';
          text.textContent = item.label;
          button.append(text);
          return button;
        });
        menu.list.replaceChildren(...menu.buttons);
      }
      menu.selected = selected;
      menu.disabled = disabled;
      if (disabled && this.active === menu) this.close();
      menu.props = {
        ...menu.props,
        collection: collection({ items: menu.items }),
        disabled,
        value: items.some((item) => item.nativeValue === selected) ? ['value:' + selected] : [],
      };
      menu.service.updateProps(menu.props);
    }
  }

  destroy() {
    for (const menu of this.menus) {
      menu.unsubscribe();
      menu.service.stop();
      for (const cleanup of menu.cleanups.values()) cleanup();
      menu.cleanups.clear();
    }
    this.active = null;
  }
}

export function installTooltips() {
  const tooltipId = 'receiver-tooltip';
  const positioner = document.createElement('div');
  const tooltip = document.createElement('div');
  positioner.className = 'rx-tooltip-positioner';
  positioner.hidden = true;
  tooltip.className = 'rx-tooltip';
  positioner.append(tooltip);
  document.body.append(positioner);
  let activeTrigger = null,
    nextId = 0,
    destroyed = false;
  const getContent = (trigger) =>
    (trigger?.dataset.tooltip ?? trigger?.getAttribute('aria-label') ?? '').trim();
  const describe = (trigger, described) => {
    if (!trigger) return;
    const ids = new Set(
      (trigger.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
    );
    if (described) ids.add(tooltipId);
    else ids.delete(tooltipId);
    if (ids.size) setAttribute(trigger, 'aria-describedby', [...ids].join(' '));
    else trigger.removeAttribute('aria-describedby');
  };
  const service = new VanillaMachine(tooltipMachine, {
    id: tooltipId,
    ids: { content: tooltipId, trigger: (value) => value },
    openDelay: 700,
    closeDelay: 300,
    closeOnScroll: false,
    positioning: {
      placement: 'top',
      strategy: 'fixed',
      gutter: 5,
      overflowPadding: 5,
      overlap: true,
    },
  });
  let api, cleanPositioner, cleanTooltip;
  const render = () => {
    api = connectTooltip(service.service, normalizeProps);
    const trigger = api.triggerValue ? document.getElementById(api.triggerValue) : null;
    const content = getContent(trigger);
    // Hide immediately on leave; Zag keeps the 300 ms window for instant re-entry.
    const visible = api.open && !service.service.state.matches('closing') && !!content;
    if (activeTrigger !== trigger || !visible) describe(activeTrigger, false);
    activeTrigger = visible ? trigger : null;
    describe(activeTrigger, true);
    cleanPositioner = spreadProps(positioner, { ...api.getPositionerProps(), hidden: !visible });
    cleanTooltip = spreadProps(tooltip, { ...api.getContentProps(), hidden: !visible });
    setText(tooltip, content);
    if (api.triggerValue && (!trigger || !content) && !service.service.state.matches('closed')) {
      const value = api.triggerValue;
      queueMicrotask(() => {
        const current = document.getElementById(value);
        if (!destroyed && api.triggerValue === value && (!current || !getContent(current)))
          api.setOpen(false);
      });
    }
  };
  const unsubscribe = service.subscribe(render);
  service.start();
  render();
  // Delegate Zag's trigger handlers so new controls work without a machine per
  // element, and select triggers keep their own IDs, data attributes and ARIA.
  const dispatch = (event, handler, leaving = false) => {
    const trigger =
      event.target instanceof Element
        ? event.target.closest('[data-tooltip],.rx-icon[aria-label]')
        : null;
    if (!trigger || !getContent(trigger)) return;
    if (leaving && event.relatedTarget?.nodeType && trigger.contains(event.relatedTarget)) return;
    if (leaving && trigger.id !== api.triggerValue) return;
    if (!trigger.id) {
      do {
        trigger.id = tooltipId + '-trigger-' + ++nextId;
      } while (document.getElementById(trigger.id) !== trigger);
    }
    if (api.triggerValue !== trigger.id && service.service.state.matches('opening'))
      service.send({ type: 'pointer.leave' });
    api.getTriggerProps({ value: trigger.id })[handler]?.(event);
  };
  const handlers = {
    pointerover: (event) => dispatch(event, 'onpointermove'),
    pointermove: (event) => dispatch(event, 'onpointermove'),
    pointerout: (event) => dispatch(event, 'onpointerleave', true),
    pointercancel: (event) => dispatch(event, 'onpointercancel', true),
    pointerdown: (event) => dispatch(event, 'onpointerdown'),
    click: (event) => dispatch(event, 'onclick'),
    focusin: (event) => dispatch(event, 'onfocusin'),
    focusout: (event) => dispatch(event, 'onfocusout', true),
    contextmenu: () => api.setOpen(false),
  };
  for (const [type, handler] of Object.entries(handlers)) document.addEventListener(type, handler);
  const observer = new MutationObserver((records) => {
    if (!api.triggerValue) return;
    const trigger = document.getElementById(api.triggerValue);
    if (!trigger || records.some((record) => record.target === trigger)) render();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-tooltip', 'aria-label'],
  });
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    observer.disconnect();
    for (const [type, handler] of Object.entries(handlers))
      document.removeEventListener(type, handler);
    window.removeEventListener('pagehide', destroy);
    unsubscribe();
    service.stop();
    cleanPositioner?.();
    cleanTooltip?.();
    describe(activeTrigger, false);
    positioner.remove();
  };
  window.addEventListener('pagehide', destroy, { once: true });
  return destroy;
}

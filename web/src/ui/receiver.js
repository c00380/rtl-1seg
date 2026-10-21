import { messages } from '../messages.js';
import { applyMessages } from './message-bindings.js';
import { SelectMenus, installTooltips } from './controls.js';
import { setText, setAttribute, setAria } from './utils.js';
import {
  activeProgram,
  programSchedule,
  programSummaryMarkup,
  receptionHeaderMarkup,
} from './program.js';
import { receptionMarkup } from './reception.js';
import { stationLogoPath } from './station-logo.js';
import { PictureInPicture } from './picture-in-picture.js';
import {
  signalMonitorMarkup,
  spectrumGeometry,
  SignalQualityHistory,
  renderConstellation,
} from './signal-monitor.js';
import { DataView } from '../data/view.js';
import { recordingTime } from '../media/recording.js';
import { installTransmit } from '../media/transmit.js';
(() => {
  applyMessages(document);
  const app = document.getElementById('rx-cinema');
  installTransmit(app);
  // Shared DOM operations
  const query = (selector) => app.querySelector(selector);
  const control = (id) => document.getElementById(id);
  const receiverControls = {
    start: control('usb'),
    fullscreen: control('fullscreen'),
    caption: control('caption-toggle'),
  };
  const dropdownControls = {
    source: control('input-source'),
    'iq-format': control('iq-format'),
    'transmit-format': control('transmit-format'),
    'transmit-guard': control('transmit-guard'),
    tuner: control('channel'),
    gain: control('gain'),
    audio: control('audio'),
    'audio-dual': control('audio-dual'),
    'recording-format': control('recording-format'),
  };
  const focus = (element) => element.focus({ preventScroll: true });
  const drawer = query('.rx-side');
  const drawerButtons = {
    program: query('.rx-drawer-toggle'),
    settings: query('.rx-settings-toggle'),
    data: query('.rx-data-button'),
  };
  const drawerNames = {
    program: messages.common.overview,
    settings: messages.common.settings,
    data: messages.common.data,
  };
  const drawerEntries = Object.entries(drawerButtons);
  const drawerPanels = [...drawer.querySelectorAll('[data-drawer-panel]')];
  const drawerCloseButtons = Object.fromEntries(
    drawerPanels.map((panel) => [
      panel.dataset.drawerPanel,
      panel.querySelector('.rx-drawer-close'),
    ]),
  );
  const dataButton = query('.rx-data-button');
  const dataView = new DataView(query('[data-drawer-panel="data"]'));
  const logButton = query('.rx-log-toggle');
  const logPanel = query('.rx-log-panel');
  const logCloseButton = query('.rx-log-close');
  const constellationButton = query('.rx-constellation-toggle');
  const constellationPopup = query('.rx-constellation-popup');
  const constellationExpand = query('.rx-constellation-expand');
  const constellationDetails = query('.rx-constellation-details');
  const overviewModal = query('.rx-overview-modal');
  const toastRegion = query('.rx-toast-region');
  const recordButton = query('.rx-record-button');
  const video = query('.rx-video');
  const recordingTimeField = query('[data-receiver="recordingTime"]');
  const volumeButton = query('.rx-volume-button');
  const volumeSlider = query('.rx-volume-slider');
  const receptionButton = query('.rx-reception-button');
  const receptionLock = query('#cinema-lock');
  const remoteChannels = query('.rx-remote-channels');
  const registerChannels = query('.rx-channel-register');
  let remoteSignature = '';
  let remoteButtons = [];
  let scanToast = null;
  registerChannels.addEventListener('click', () => globalThis.receiverUI.onRegisterChannels?.());
  const blockedControls = [drawerButtons.program, constellationButton, dataButton];
  const receptionInformation = query('[data-receiver="receptionInformation"]');
  const programInformation = query('[data-receiver="programInformation"]');
  const headerInformation = query('[data-receiver="headerInformation"]');
  const failedLogos = new Set();
  headerInformation.addEventListener(
    'error',
    (event) => {
      const image = event.target;
      if (image.tagName !== 'IMG' || !image.closest('[data-reception="logo"]')) return;
      failedLogos.add(image.getAttribute('src'));
      program.logoImage = '';
      renderReception();
    },
    true,
  );
  const clockInformation = query('[data-receiver="clockInformation"]');
  let lastProgramMarkup = '',
    lastHeaderMarkup = '';
  const scopePoints = query('[data-receiver="constellation"]');
  const spectrum = query('[data-receiver="spectrum"]');
  const spectrumBand = query('[data-receiver="spectrumBand"]');
  const spectrumTop = query('[data-receiver="spectrumTop"]');
  const spectrumBottom = query('[data-receiver="spectrumBottom"]');
  const spectrumLow = query('[data-receiver="spectrumLow"]');
  const spectrumHigh = query('[data-receiver="spectrumHigh"]');
  const spectrumStatus = query('[data-receiver="spectrumStatus"]');
  const qualityLine = query('[data-receiver="qualityHistory"]');
  const qualityPoint = query('[data-receiver="qualityPoint"]');
  const qualityMaximum = query('[data-receiver="qualityMaximum"]');
  const qualityStatus = query('[data-receiver="qualityStatus"]');
  let qualityHistory = new SignalQualityHistory();
  let inputLevel = null;
  let lastMonitorMarkup = null;
  const levelMeter = query('[data-receiver="snrMeter"]');
  const levelFill = query('[data-receiver="snrFill"]');
  const levelText = query('[data-receiver="snr"]');
  const logList = query('[data-receiver="logs"]');
  const fullscreenButton = query('.rx-fullscreen-button');
  let programTitle = null,
    programTitleText = null;
  let marqueeFrame = 0;
  let marqueeState = '';
  const updateProgramTitleMarquee = () => {
    cancelAnimationFrame(marqueeFrame);
    marqueeFrame = requestAnimationFrame(() => {
      if (!programTitle || !programTitleText) return;
      const distance = Math.max(
        0,
        Math.ceil(programTitleText.scrollWidth - programTitle.clientWidth),
      );
      const state = `${programTitleText.textContent}\n${programTitle.clientWidth}\n${distance}`;
      if (state === marqueeState) return;
      marqueeState = state;
      programTitle.classList.toggle('is-marquee', distance > 1);
      if (distance > 1) {
        programTitle.style.setProperty('--rx-marquee-distance', `${distance}px`);
        programTitle.style.setProperty(
          '--rx-marquee-duration',
          `${Math.max(8, 6 + distance / 32)}s`,
        );
      } else {
        programTitle.style.removeProperty('--rx-marquee-distance');
        programTitle.style.removeProperty('--rx-marquee-duration');
      }
    });
  };
  const marqueeObserver = new ResizeObserver(updateProgramTitleMarquee);
  // ヘッダーの data-reception に使う受信値。番組カードは受信情報から直接描画する。
  const program = Object.create(null);
  const showToast = (message, tone = 'error', duration = 3600) => {
    const toast = document.createElement('div');
    toast.className = 'rx-toast is-entering';
    toast.dataset.tone = tone;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    toastRegion.append(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.remove('is-entering')));
    if (duration > 0)
      setTimeout(() => {
        toast.classList.add('is-leaving');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        setTimeout(() => toast.remove(), 250);
      }, duration);
    return toast;
  };
  globalThis.showReceiverError = (message) => showToast(message || messages.common.receptionError);
  const pictureInPicture = new PictureInPicture(query('.rx-pip-button'), showToast);
  const receptionStopped = () => app.classList.contains('is-reception-stopped');
  const selectMenus = new SelectMenus(app, dropdownControls, () => syncMenus());
  // Panels and dialogs
  let lastDrawerToggle = drawerButtons.program;
  const setDrawer = (mode, restoreFocus = true) => {
    app.classList.toggle('is-drawer-open', Boolean(mode));
    if (mode) app.dataset.drawerMode = mode;
    else delete app.dataset.drawerMode;
    dataView.open(mode === 'data');
    drawerEntries.forEach(([key, button]) => {
      setAria(button, 'expanded', key === mode);
      setAria(
        button,
        'label',
        drawerNames[key] +
          (key === mode ? messages.common.closeSuffix : messages.common.openSuffix),
      );
    });
    setAria(drawer, 'hidden', !mode);
    drawer.inert = !mode;
    selectMenus.close();
    if (mode) {
      drawer.scrollTop = 0;
      lastDrawerToggle = drawerButtons[mode];
      setLog(false, false);
      drawer.setAttribute('aria-label', drawerNames[mode]);
      drawerPanels.forEach((panel) => {
        panel.hidden = panel.dataset.drawerPanel !== mode;
      });
      focus(drawerCloseButtons[mode]);
    } else if (restoreFocus) focus(lastDrawerToggle);
  };
  drawerEntries.forEach(([mode, button]) => {
    button.addEventListener('click', () =>
      setDrawer(app.dataset.drawerMode === mode ? null : mode, false),
    );
  });
  drawer
    .querySelectorAll('.rx-drawer-close')
    .forEach((button) => button.addEventListener('click', () => setDrawer(null)));
  const overviewCloseButton = overviewModal.querySelector('[data-close-modal]');
  const overviewDetailButton = query('.rx-overview-detail-button');
  overviewDetailButton.disabled = true;
  overviewDetailButton.addEventListener('click', () => {
    if (!overviewModal.open) overviewModal.showModal();
    focus(overviewCloseButton);
  });
  overviewCloseButton.addEventListener('click', () => overviewModal.close());
  overviewModal.addEventListener('click', (event) => {
    if (event.target === overviewModal) overviewModal.close();
  });
  const setLog = (open, restoreFocus = true) => {
    if (open) {
      if (app.dataset.drawerMode) setDrawer(null, false);
      selectMenus.close();
    }
    app.classList.toggle('is-log-open', open);
    setAria(logButton, 'expanded', open);
    setAria(logPanel, 'hidden', !open);
    logPanel.inert = !open;
    if (open) focus(logCloseButton);
    else if (restoreFocus) focus(logButton);
  };
  logButton.addEventListener('click', () => setLog(!app.classList.contains('is-log-open'), false));
  logCloseButton.addEventListener('click', () => setLog(false));
  let detailAnimations = [];
  const setConstellationDetails = (expanded) => {
    const animate =
      !constellationPopup.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dimensions = () => {
      const style = getComputedStyle(constellationDetails);
      const visible = !constellationDetails.hidden;
      return {
        height: `${constellationDetails.getBoundingClientRect().height}px`,
        paddingTop: visible ? style.paddingTop : '0px',
        paddingBottom: visible ? style.paddingBottom : '0px',
        borderTopWidth: visible ? style.borderTopWidth : '0px',
      };
    };
    // Capture the current size before cancelling, so rapid toggles reverse smoothly.
    const fromHeight = animate ? constellationPopup.getBoundingClientRect().height : 0;
    const fromDetails = animate ? dimensions() : null;
    detailAnimations.forEach((animation) => animation.cancel());
    detailAnimations = [];
    constellationPopup.classList.toggle('is-expanded', expanded);
    constellationDetails.hidden = !expanded;
    constellationDetails.inert = !expanded;
    setAria(constellationDetails, 'hidden', !expanded);
    setAria(constellationExpand, 'expanded', expanded);
    setAria(
      constellationExpand,
      'label',
      expanded ? messages.common.collapseMonitor : messages.common.expandMonitor,
    );
    if (!animate) return;
    const toHeight = constellationPopup.getBoundingClientRect().height;
    const toDetails = dimensions();
    constellationDetails.hidden = false;
    const duration = parseFloat(getComputedStyle(app).getPropertyValue('--rx-motion-details'));
    const timing = { duration, easing: 'ease', fill: 'both' };
    const popupAnimation = constellationPopup.animate(
      [
        { height: `${fromHeight}px`, maxHeight: `${fromHeight}px` },
        { height: `${toHeight}px`, maxHeight: `${toHeight}px` },
      ],
      timing,
    );
    detailAnimations = [
      popupAnimation,
      constellationDetails.animate([fromDetails, toDetails], timing),
    ];
    popupAnimation.onfinish = () => {
      constellationDetails.hidden = !expanded;
      detailAnimations.forEach((animation) => animation.cancel());
      detailAnimations = [];
    };
  };
  const setConstellation = (open, restoreFocus = true) => {
    constellationPopup.hidden = !open;
    setAria(constellationButton, 'expanded', open);
    if (open) focus(query('.rx-constellation-close'));
    else {
      setConstellationDetails(false);
      if (restoreFocus) focus(constellationButton);
    }
  };
  constellationButton.addEventListener('click', () =>
    setConstellation(constellationPopup.hidden, false),
  );
  query('.rx-constellation-close').addEventListener('click', () => setConstellation(false));
  constellationExpand.addEventListener('click', () =>
    setConstellationDetails(constellationExpand.getAttribute('aria-expanded') !== 'true'),
  );
  // Recording availability follows the media pipeline, not just the connection.
  recordButton.disabled = true;
  recordButton.addEventListener('click', () => globalThis.receiverUI?.onRecord?.());
  fullscreenButton.addEventListener('click', () => receiverControls.fullscreen.click());
  let lastVolume = Number(volumeSlider.value) || 100;
  const renderVolume = () => {
    const value = Number(volumeSlider.value);
    if (value > 0) lastVolume = value;
    const muted = value === 0;
    volumeSlider.style.setProperty('--rx-volume-level', value + '%');
    volumeButton.classList.toggle('is-muted', muted);
    setAria(volumeButton, 'pressed', muted);
    setAria(volumeButton, 'label', muted ? messages.common.unmute : messages.common.mute);
    globalThis.receiverUI?.onVolume?.(value / 100);
  };
  volumeButton.addEventListener('click', () => {
    volumeSlider.value = Number(volumeSlider.value) > 0 ? '0' : String(lastVolume);
    renderVolume();
  });
  volumeSlider.addEventListener('input', renderVolume);
  const renderReception = () => {
    const stopped = receptionStopped();
    const markup = stopped ? '' : receptionHeaderMarkup(program);
    if (markup !== lastHeaderMarkup) {
      marqueeObserver.disconnect();
      headerInformation.innerHTML = markup;
      lastHeaderMarkup = markup;
      programTitle = headerInformation.querySelector('.rx-program-title');
      programTitleText = programTitle?.querySelector('[data-reception="title"]');
      marqueeState = '';
      if (programTitle) marqueeObserver.observe(programTitle);
    }
    updateProgramTitleMarquee();
    renderClock();
  };
  const renderClock = () => {
    const clock = receptionStopped() ? '' : program.clock;
    let clockText = clockInformation.querySelector('[data-reception="clock"]');
    if (!clock) clockInformation.replaceChildren();
    else {
      if (!clockText) {
        clockText = document.createElement('strong');
        clockText.className = 'rx-num';
        clockText.dataset.reception = 'clock';
        clockInformation.append(clockText);
      }
      setText(clockText, clock);
    }
  };
  // Reflect the actual receiver lifecycle, including pending operations and failures.
  const setReception = (receiving) => {
    const stopped = !receiving;
    app.classList.toggle('is-reception-stopped', stopped);
    receptionButton.classList.toggle('is-stopped', stopped);
    receptionButton.textContent = stopped
      ? messages.common.startReception
      : messages.common.stopReception;
    blockedControls.forEach((button) => {
      button.disabled = stopped;
    });
    if (stopped) {
      programInformation.replaceChildren();
      programInformation.hidden = true;
      lastProgramMarkup = '';
      receptionInformation.replaceChildren();
      lastDetailMarkup = '';
      overviewDetailButton.disabled = true;
      setConstellation(false, false);
      if (['program', 'data'].includes(app.dataset.drawerMode)) setDrawer(null, false);
      if (overviewModal.open) overviewModal.close();
    }
    receptionLock.textContent = stopped ? messages.common.stopped : messages.common.receiving;
    renderReception();
  };
  receptionButton.addEventListener('click', () => receiverControls.start.click());
  // Keyboard navigation and initial rendering
  app.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || overviewModal.open) return;
    if (selectMenus.active) return;
    if (!constellationPopup.hidden) setConstellation(false);
    else if (app.classList.contains('is-log-open')) setLog(false);
    else if (app.dataset.drawerMode) setDrawer(null);
  });
  const captionButton = query('.rx-caption-check');
  const nhkCheck = query('.rx-nhk-check');
  nhkCheck.addEventListener('change', () => globalThis.receiverUI.onNHKChange?.(nhkCheck.checked));
  captionButton.addEventListener('change', () => {
    receiverControls.caption.click();
    syncMenus();
  });
  const syncMenus = () => {
    const toggle = receiverControls.caption;
    const enabled = toggle.getAttribute('aria-pressed') === 'true';
    captionButton.disabled = toggle.disabled || receiverControls.start.disabled;
    captionButton.checked = enabled;
    selectMenus.sync();
  };
  let lastDetailMarkup = null;
  globalThis.receiverUI = {
    setNHKReception(enabled, busy = false) {
      nhkCheck.checked = enabled;
      nhkCheck.disabled = !enabled || busy;
    },
    setRecording({
      active = false,
      saving = false,
      elapsed = 0,
      available = false,
      supported = false,
      blocked = false,
    } = {}) {
      recordButton.disabled = saving || (!active && (blocked || !available || !supported));
      const formatDisabled = active || saving;
      if (dropdownControls['recording-format'].disabled !== formatDisabled) {
        dropdownControls['recording-format'].disabled = formatDisabled;
        selectMenus.sync('recording-format');
      }
      setAria(recordButton, 'pressed', active);
      video.classList.toggle('is-recording', active);
      setText(recordingTimeField, saving ? messages.common.saving : recordingTime(elapsed));
      const label = saving
        ? messages.common.recordingSaving
        : active
          ? messages.common.stopRecording
          : messages.common.startRecording;
      setAria(recordButton, 'label', label);
      recordButton.dataset.tooltip =
        blocked && !active
          ? messages.common.recordingProhibited
          : !supported
            ? messages.common.recordingUnsupported
            : !active && !available
              ? ''
              : label;
    },
    receiveData: (messages) => dataView.receive(messages),
    resetData: () => dataView.reset(),
    syncMenus,
    volume: () => Number(volumeSlider.value) / 100,
    setControls(receiving, busy) {
      setReception(receiving);
      receptionButton.disabled = busy;
      receptionButton.textContent = busy
        ? messages.common.busy
        : receiving
          ? messages.common.stopReception
          : messages.common.startReception;
      receptionLock.textContent = busy
        ? messages.common.waiting
        : receiving
          ? messages.common.receiving
          : messages.common.stopped;
      syncMenus();
    },
    setChannels({
      entries = [],
      activeChannel = null,
      busy = false,
      scanning = false,
      fileInput = false,
      progress = null,
    } = {}) {
      const signature = JSON.stringify(entries);
      if (signature !== remoteSignature) {
        remoteButtons.forEach((button) => button.remove());
        remoteButtons = entries.map((entry) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'rx-channel';
          button.textContent = String(entry.remoteKey);
          button.dataset.remoteKey = String(entry.remoteKey);
          button.dataset.channel = String(entry.channel);
          const label = messages.common.remoteChannelLabel(
            entry.remoteKey,
            entry.stationName || messages.common.physicalChannelPrefix + entry.channel,
            entry.channel,
          );
          setAria(button, 'label', label);
          button.dataset.tooltip = label;
          button.addEventListener('click', () =>
            globalThis.receiverUI.onRemoteChannel?.(entry.remoteKey),
          );
          remoteChannels.append(button);
          return button;
        });
        remoteSignature = signature;
      }
      remoteButtons.forEach((button) => {
        button.disabled = busy || fileInput;
        setAria(button, 'pressed', Number(button.dataset.channel) === activeChannel);
      });
      registerChannels.disabled = fileInput || (busy && !scanning);
      const label = scanning ? messages.common.cancelScan : messages.common.scanChannels;
      setAria(registerChannels, 'label', label);
      registerChannels.dataset.tooltip = label;
      setAria(registerChannels, 'pressed', scanning);
      if (scanning) {
        const text = progress
          ? messages.common.scanProgress(
              progress.index,
              progress.total,
              progress.channel,
              progress.found,
            )
          : messages.common.scanPreparing;
        if (scanToast) setText(scanToast, text);
        else scanToast = showToast(text, 'notice', 0);
      } else if (scanToast) {
        scanToast.remove();
        scanToast = null;
      }
    },
    setClock(value) {
      if (program.clock === value) return;
      program.clock = value;
      renderClock();
    },
    setProgram(info, now = Date.now()) {
      const current = activeProgram(info?.current, now),
        next = activeProgram(info?.next, now);
      const currentSchedule = programSchedule(current),
        nextSchedule = programSchedule(next);
      const channel = dropdownControls.tuner.selectedOptions[0];
      const logoImage = stationLogoPath(info);
      Object.assign(program, {
        station: info?.stationName ?? '',
        logo: info?.logo?.text ?? '',
        logoImage: failedLogos.has(logoImage) ? '' : logoImage,
        frequency:
          dropdownControls.source?.value === 'file'
            ? ''
            : info
              ? (channel?.text?.replace(messages.common.physicalChannelPrefix, '') ?? '')
              : '',
        currentLabel: current ? messages.common.onAir : '',
        currentSchedule,
        title: current?.title ?? '',
        nextLabel: next ? messages.common.nextProgramAt(nextSchedule) : '',
        nextTitle: next?.title ?? '',
      });
      renderReception();
      const markup = programSummaryMarkup(info, now);
      if (markup !== lastProgramMarkup) {
        programInformation.innerHTML = markup;
        lastProgramMarkup = markup;
      }
      programInformation.hidden = !markup;
    },
    setReceptionInformation(info, context = {}) {
      const markup = receptionMarkup(info, context);
      overviewDetailButton.disabled = !markup;
      if (markup !== lastDetailMarkup) {
        receptionInformation.innerHTML = markup;
        lastDetailMarkup = markup;
      }
    },
    setScope(points = []) {
      renderConstellation(scopePoints, points);
    },
    setLevel(value = null) {
      const known = Number.isFinite(value);
      inputLevel = known ? value : null;
      const text = known ? `${value.toFixed(1)} dBFS` : '';
      if (known) setAria(levelMeter, 'valuenow', Math.max(-60, Math.min(0, value)));
      else levelMeter.removeAttribute('aria-valuenow');
      setAria(levelMeter, 'valuetext', text);
      levelFill.style.height = known
        ? `${Math.max(0, Math.min(100, ((value + 60) / 60) * 100))}%`
        : '0%';
      setText(levelText, text);
    },
    setSignalMonitor(info = null, context = {}) {
      const now = performance.now();
      const markup = signalMonitorMarkup(info, { ...context, inputLevel });
      if (markup !== lastMonitorMarkup) {
        constellationDetails.innerHTML = markup;
        lastMonitorMarkup = markup;
      }
      if (!info) qualityHistory = new SignalQualityHistory();
      qualityHistory.update(info?.diagnostics, now);
      const quality = qualityHistory.geometry(now);
      setAttribute(qualityLine, 'd', quality?.path ?? '');
      setAttribute(qualityPoint, 'visibility', quality ? 'visible' : 'hidden');
      if (quality) {
        setAttribute(qualityPoint, 'cx', quality.x);
        setAttribute(qualityPoint, 'cy', quality.y);
      }
      setText(qualityMaximum, quality ? String(quality.maximum) : '');
      setText(
        qualityStatus,
        quality ? messages.common.qualityHistory(quality.value.toFixed(1)) : '',
      );
      const geometry = spectrumGeometry(info?.input);
      setAttribute(spectrum, 'd', geometry?.path ?? '');
      setAttribute(spectrumBand, 'visibility', geometry ? 'visible' : 'hidden');
      if (geometry) {
        setAttribute(spectrumBand, 'x', geometry.leftBand);
        setAttribute(spectrumBand, 'width', geometry.rightBand - geometry.leftBand);
      }
      setText(spectrumTop, geometry ? String(geometry.maximum) : '');
      setText(spectrumBottom, geometry ? String(geometry.minimum) : '');
      setText(spectrumLow, geometry ? `−${geometry.halfKhz.toFixed(1)}` : '');
      setText(spectrumHigh, geometry ? `+${geometry.halfKhz.toFixed(1)}` : '');
      setText(spectrumStatus, geometry ? messages.common.spectrumNote : '');
    },
    setLog(entries) {
      logList.replaceChildren(
        ...entries.map((text) => {
          const row = document.createElement('li');
          row.textContent = text;
          return row;
        }),
      );
    },
    showError: showToast,
    setVideoCanvas: (canvas) => pictureInPicture.setCanvas(canvas),
    showNotice: (message) => showToast(message, 'notice'),
    setFullscreen(active) {
      setAria(fullscreenButton, 'pressed', active);
      setAria(
        fullscreenButton,
        'label',
        active ? messages.common.exitFullscreen : messages.common.fullscreen,
      );
    },
  };
  renderVolume();
  setReception(false);
})();

installTooltips();

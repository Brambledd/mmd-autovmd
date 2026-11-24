/**
 * Client half of `@popo/dsh-stage`.
 *
 * The PoPo 3D stage is a separate web process (http://localhost:4000). This module
 * registers it as a right-Sidebar tab type — "PoPo 舞台" — whose body embeds the
 * stage with `?embed=1&zoom=<n>`. In embed mode PoPo hides its site chrome and
 * moves the camera back by the zoom factor, so the character is drawn smaller and
 * stays completely inside a narrow pane. The toolbar changes the zoom live through
 * `postMessage` (no reload) and remembers it in `localStorage`, and replays the last
 * motion — the last one shown, or the latest MCP stage push — the same way.
 *
 * Also contributes a trigger beside Settings at the sidebar foot, a General-settings
 * switch for auto-open, and a guide-page entry capsule.
 */
window.__ModuleLoader__.load({
  id: '@popo/dsh-stage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } = React;

    const PKG = '@popo/dsh-stage';
    const KIND = 'popo-stage';
    const NS = 'popoStage';
    const STYLE_ID = `${PKG}/Stage`;
    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

    /** Fallbacks; the row config (when supplied) and then localStorage win. */
    const DEFAULTS = { stageUrl: 'http://localhost:4000/', zoom: 1.3, autoOpen: true };
    const ZOOM = { min: 1, max: 2.5, step: 0.1 };
    const STORE = { zoom: 'popo-stage.zoom', autoOpen: 'popo-stage.autoOpen', dismissed: 'popo-stage.dismissed' };
    const MESSAGES = {
      zoom: 'popo:stage-zoom',
      ready: 'popo:stage-ready',
      replay: 'popo:stage-replay',
      state: 'popo:stage-state',
    };
    const HEALTH_INTERVAL_MS = 5000;
    const HEALTH_TIMEOUT_MS = 8000;
    const HEALTH_MISSES_OFFLINE = 2;
    /** Scripts and its own origin (so `/api/*` fetches work); no top navigation of the DSH app. */
    const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

    const dictionaries = {
      zh: {
        'tab.title': 'PoPo 舞台',
        'frame.title': 'PoPo 3D 舞台',
        'guide.title': 'PoPo 舞台',
        'guide.description': '在右侧栏里观看 MCP 推送到舞台的 3D 动作',
        'toolbar.smaller': '缩小人物',
        'toolbar.bigger': '放大人物',
        'toolbar.reset': '恢复默认缩放（{zoom}×）',
        'toolbar.replay': '重播上一个动作',
        'toolbar.replayShort': '重播',
        'toolbar.reload': '重新加载舞台',
        'toolbar.open': '在浏览器中打开完整页面',
        'offline.title': '舞台服务没有运行',
        'offline.detail': '请先启动 PoPo（{url}）。服务启动后这里会自动重新连接。',
        'offline.retry': '重试',
        'trigger.label': 'PoPo 舞台',
        'settings.title': 'PoPo 舞台',
        'settings.autoOpen': '打开会话时自动在右侧显示舞台',
        'settings.help': '嵌入 {url}，并按 {zoom}× 缩小人物以保证完整入镜；缩放可在舞台工具栏里调整。',
      },
      en: {
        'tab.title': 'PoPo Stage',
        'frame.title': 'PoPo 3D stage',
        'guide.title': 'PoPo Stage',
        'guide.description': 'Watch MCP-pushed 3D motion in the right sidebar',
        'toolbar.smaller': 'Make character smaller',
        'toolbar.bigger': 'Make character larger',
        'toolbar.reset': 'Reset to default zoom ({zoom}×)',
        'toolbar.replay': 'Replay the last motion',
        'toolbar.replayShort': 'Replay',
        'toolbar.reload': 'Reload stage',
        'toolbar.open': 'Open the full page in a browser',
        'offline.title': 'Stage server is not running',
        'offline.detail': 'Start PoPo at {url}; this panel reconnects on its own.',
        'offline.retry': 'Retry',
        'trigger.label': 'PoPo Stage',
        'settings.title': 'PoPo Stage',
        'settings.autoOpen': 'Show the stage in the right sidebar when a session opens',
        'settings.help': 'Embeds {url} and scales the character down by {zoom}× so it stays in frame; adjust it from the stage toolbar.',
      },
    };

    // ---------- storage & settings ----------

    function readStore(key, fallback) {
      try {
        const value = window.localStorage.getItem(key);
        return value == null ? fallback : value;
      } catch {
        return fallback;
      }
    }

    function writeStore(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage unavailable: keep the in-memory value only */
      }
    }

    function clampZoom(value) {
      if (!Number.isFinite(value)) return DEFAULTS.zoom;
      const clamped = Math.min(ZOOM.max, Math.max(ZOOM.min, value));
      return Math.round(clamped * 100) / 100;
    }

    function resolveSettings(config) {
      const supplied = config && typeof config === 'object' ? config : {};
      const rawUrl = typeof supplied.stageUrl === 'string' && supplied.stageUrl.trim() ? supplied.stageUrl.trim() : DEFAULTS.stageUrl;
      let stageUrl = DEFAULTS.stageUrl;
      try {
        const parsed = new URL(rawUrl);
        stageUrl = parsed.toString();
      } catch {
        stageUrl = DEFAULTS.stageUrl;
      }
      if (!stageUrl.endsWith('/')) stageUrl = `${stageUrl}/`;
      const storedZoom = Number(readStore(STORE.zoom, ''));
      const suppliedZoom = Number(supplied.zoom);
      const zoom = storedZoom > 0 ? clampZoom(storedZoom) : clampZoom(suppliedZoom > 0 ? suppliedZoom : DEFAULTS.zoom);
      const storedAutoOpen = readStore(STORE.autoOpen, '');
      const autoOpen = storedAutoOpen === '0' ? false : storedAutoOpen === '1' ? true : typeof supplied.autoOpen === 'boolean' ? supplied.autoOpen : DEFAULTS.autoOpen;
      const dismissed = readStore(STORE.dismissed, '') === '1';
      return { stageUrl, defaultZoom: DEFAULTS.zoom, zoom, autoOpen, dismissed };
    }

    /** One shared settings snapshot; bodies, the trigger, and the settings row subscribe to slices. */
    function createSettings(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        setZoom(zoom) {
          const next = clampZoom(zoom);
          if (next === state.zoom) return;
          writeStore(STORE.zoom, String(next));
          state = { ...state, zoom: next };
          for (const listener of [...listeners]) listener();
        },
        setAutoOpen(autoOpen) {
          if (autoOpen === state.autoOpen) return;
          writeStore(STORE.autoOpen, autoOpen ? '1' : '0');
          state = { ...state, autoOpen };
          for (const listener of [...listeners]) listener();
        },
        setDismissed(dismissed) {
          if (dismissed === state.dismissed) return;
          writeStore(STORE.dismissed, dismissed ? '1' : '0');
          state = { ...state, dismissed };
          for (const listener of [...listeners]) listener();
        },
      };
    }

    function useSettings(settings, selector) {
      return useSyncExternalStore(settings.subscribe, () => selector(settings.getSnapshot()));
    }

    /** Read a primitive slice of an observable snapshot (`getSnapshot`/`subscribe`) with stable subscriptions. */
    function useSnapshot(source, selector) {
      const subscribe = useMemo(() => (listener) => source.subscribe(listener), [source]);
      const getSnapshot = useMemo(() => () => selector(source.getSnapshot()), [source, selector]);
      return useSyncExternalStore(subscribe, getSnapshot);
    }

    function stageOrigin(stageUrl) {
      return new URL(stageUrl).origin;
    }

    function frameUrl(stageUrl, zoom) {
      const url = new URL(stageUrl);
      url.searchParams.set('embed', '1');
      url.searchParams.set('zoom', zoom.toFixed(2));
      return url.toString();
    }

    // ---------- styles ----------

    function installStyle() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return () => {};
      const style = document.createElement('style');
      style.dataset.plugin = PKG;
      style.dataset.pluginCss = STYLE_ID;
      style.textContent = [
        // Tab body: toolbar + stage frame.
        '.popoStage_root{height:100%;min-height:0;display:flex;flex-direction:column;container:popoStage/inline-size;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
        '.popoStage_toolbar{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:2px;height:34px;padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}',
        '.popoStage_tool{width:26px;height:26px;display:inline-flex;justify-content:center;align-items:center;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.popoStage_tool:hover:not(:disabled),.popoStage_tool:focus-visible{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
        '.popoStage_tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}',
        '.popoStage_tool.popoStage_toolText{width:auto;gap:3px;padding:0 7px;font:var(--dsw-font-xxs-12)}',
        // Narrow panes drop the replay label and keep its icon.
        '@container popoStage (max-width:270px){.popoStage_toolText>span{display:none}}',
        '.popoStage_zoom{box-sizing:border-box;min-width:46px;height:26px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums;cursor:pointer}',
        '.popoStage_zoom:hover,.popoStage_zoom:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
        '.popoStage_spacer{flex:1}',
        '.popoStage_content{position:relative;flex:1;min-height:0;background:#0f172a}',
        '.popoStage_frame{display:block;width:100%;height:100%;border:0;background:#0f172a}',
        '.popoStage_notice{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;text-align:center;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
        '.popoStage_noticeTitle{font-size:14px;font-weight:500;line-height:22px}',
        '.popoStage_noticeText{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
        '.popoStage_noticeAction{height:28px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-brand-primary);color:#fff;font-size:12px;cursor:pointer}',
        // Sidebar-foot trigger (pattern of the shipped Cordis footer action).
        '.popoStage_layer{flex:none;align-items:center;width:100%;height:42px;display:flex;position:relative}',
        '.popoStage_trigger{width:100%;height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}',
        '.popoStage_trigger:hover,.popoStage_trigger:focus-visible,.popoStage_trigger[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
        '.popoStage_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
        '.popoStage_triggerIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}',
        '.popoStage_trigger[data-active="true"] .popoStage_triggerIcon{color:var(--dsw-alias-brand-primary)}',
        '.popoStage_layer.popoStage_rail{width:36px;height:36px}',
        '.popoStage_rail .popoStage_trigger{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}',
        // General-settings row (pattern of the shipped Appearance row) with a switch.
        '.popoStage_setting{border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;padding:16px 0}',
        '.popoStage_settingHead{display:flex;align-items:center;justify-content:space-between;gap:12px}',
        '.popoStage_settingTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
        '.popoStage_settingHelp{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
        '.popoStage_switch{position:relative;flex:none;width:32px;height:18px;padding:0;border:0;border-radius:9px;background:var(--dsw-alias-state-idle-primary);cursor:pointer}',
        '.popoStage_switch[data-on="true"]{background:var(--dsw-alias-brand-primary)}',
        '.popoStage_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
        '.popoStage_knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s ease}',
        '.popoStage_switch[data-on="true"] .popoStage_knob{transform:translateX(14px)}',
      ].join('');
      document.head.append(style);
      return () => style.remove();
    }

    // ---------- icons ----------

    function StageIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 4.8, r: 2.3, fill: 'currentColor' }),
        h('path', { d: 'M8 8c-2.7 0-4.4 1.5-4.6 4h9.2C12.4 9.5 10.7 8 8 8z', fill: 'currentColor' }),
        h('path', { d: 'M2.5 14.2h11', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }));
    }

    function GlyphMinus() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3.5 8h9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
    }

    function GlyphPlus() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3.5 8h9M8 3.5v9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
    }

    function GlyphReload() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.4h-2.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function GlyphReplay() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 8a5 5 0 1 0 1.5-3.6M3 2.8v2.4h2.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function GlyphExternal() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M6.5 3.5H3.5v9h9V9.5M9.5 2.5h4v4M13.2 2.8 7.5 8.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    // ---------- tab body ----------

    function ToolButton({ label, onClick, disabled, labeled, children }) {
      return h('button', {
        type: 'button',
        className: labeled ? 'popoStage_tool popoStage_toolText' : 'popoStage_tool',
        title: label,
        'aria-label': label,
        disabled,
        onClick,
      }, children);
    }

    /** The stage tab body: zoom toolbar over the embedded PoPo stage. */
    function StageBody({ useTabInfo, t, stage }) {
      const { tab } = useTabInfo();
      const visible = tab.visible;
      const zoom = useSettings(stage, (s) => s.zoom);
      const origin = useMemo(() => stageOrigin(stage.getSnapshot().stageUrl), [stage]);
      const frameRef = useRef(null);
      const [epoch, setEpoch] = useState(0);
      // Each mount (first load or reload) reads the zoom current at that moment; later changes go
      // through postMessage without a reload, so `zoom` is deliberately not a dependency here.
      const src = useMemo(() => frameUrl(stage.getSnapshot().stageUrl, stage.getSnapshot().zoom), [stage, epoch]);
      const [online, setOnline] = useState(null);
      const onlineRef = useRef(null);
      // Whether a probe has failed since the frame was last loaded (see the probe effect).
      const missedRef = useRef(false);
      // Whether PoPo has a motion to replay (the last one shown, or the latest MCP stage push).
      const [canReplay, setCanReplay] = useState(false);

      // A fresh frame starts without a replayable motion until PoPo reports otherwise.
      const reload = useCallback(() => {
        setCanReplay(false);
        setEpoch((value) => value + 1);
      }, []);
      const postZoom = useCallback(() => {
        const target = frameRef.current ? frameRef.current.contentWindow : null;
        if (target) target.postMessage({ type: MESSAGES.zoom, zoom }, origin);
      }, [zoom, origin]);
      const replay = useCallback(() => {
        const target = frameRef.current ? frameRef.current.contentWindow : null;
        if (target && canReplay) target.postMessage({ type: MESSAGES.replay }, origin);
      }, [origin, canReplay]);

      useEffect(() => { postZoom(); }, [postZoom]);

      // Page refresh (the tab's own refresh command) reloads the stage.
      useEffect(() => tab.actions.bindCommands({ refresh: reload }), [tab.actions, reload]);

      // PoPo announces itself once its message listener and engine exist; answer with the current
      // zoom. Its ready/state messages carry `canReplay` for the replay button.
      useEffect(() => {
        const onMessage = (event) => {
          if (event.origin !== origin || event.source !== (frameRef.current ? frameRef.current.contentWindow : null)) return;
          const data = event.data;
          if (!data || typeof data !== 'object') return;
          if (data.type === MESSAGES.ready) postZoom();
          if ((data.type === MESSAGES.ready || data.type === MESSAGES.state) && typeof data.canReplay === 'boolean') {
            setCanReplay(data.canReplay);
          }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [origin, postZoom]);

      // While visible, probe the stage server. Two misses in a row show the notice (a dev
      // server can be slow on its first compile). The frame is reloaded once the server answers
      // after any miss: a frame that loaded while the server was down shows the browser's error
      // page, which this is the only way to detect.
      useEffect(() => {
        if (!visible) return undefined;
        let cancelled = false;
        let inFlight = false;
        let misses = 0;
        const probe = async () => {
          if (inFlight) return;
          inFlight = true;
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
          let ok = false;
          try {
            await fetch(`${origin}/api/stage-push?since=${Date.now()}`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
            ok = true;
          } catch {
            ok = false;
          }
          window.clearTimeout(timeout);
          inFlight = false;
          if (cancelled) return;
          const previous = onlineRef.current;
          if (ok) {
            // Back after a miss or after the notice: the frame may not be showing the stage.
            const reloadNeeded = missedRef.current || previous === false;
            missedRef.current = false;
            misses = 0;
            if (previous !== true) {
              onlineRef.current = true;
              setOnline(true);
            }
            if (reloadNeeded) reload();
            return;
          }
          missedRef.current = true;
          misses += 1;
          if (misses >= HEALTH_MISSES_OFFLINE && previous !== false) {
            onlineRef.current = false;
            setOnline(false);
          }
        };
        void probe();
        const timer = window.setInterval(probe, HEALTH_INTERVAL_MS);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, [visible, origin, reload]);

      const changeZoom = useCallback((delta) => stage.setZoom(stage.getSnapshot().zoom + delta), [stage]);
      const resetZoom = useCallback(() => stage.setZoom(stage.getSnapshot().defaultZoom), [stage]);
      const openExternal = useCallback(() => {
        window.open(stage.getSnapshot().stageUrl, '_blank', 'noopener');
      }, [stage]);

      const resetLabel = t('toolbar.reset', { zoom: stage.getSnapshot().defaultZoom.toFixed(1) });
      return h('div', { className: 'popoStage_root' },
        h('div', { className: 'popoStage_toolbar', role: 'toolbar', 'aria-label': t('tab.title') },
          // "+" enlarges the character (camera closer), "−" shrinks it (camera farther).
          h(ToolButton, { label: t('toolbar.smaller'), disabled: zoom >= ZOOM.max, onClick: () => changeZoom(ZOOM.step) }, h(GlyphMinus)),
          h('button', {
            type: 'button', className: 'popoStage_zoom', title: resetLabel, 'aria-label': resetLabel, onClick: resetZoom,
          }, `${zoom.toFixed(1)}×`),
          h(ToolButton, { label: t('toolbar.bigger'), disabled: zoom <= ZOOM.min, onClick: () => changeZoom(-ZOOM.step) }, h(GlyphPlus)),
          h('span', { className: 'popoStage_spacer' }),
          h(ToolButton, { label: t('toolbar.replay'), disabled: !canReplay, onClick: replay, labeled: true },
            h(GlyphReplay), h('span', null, t('toolbar.replayShort'))),
          h(ToolButton, { label: t('toolbar.reload'), onClick: reload }, h(GlyphReload)),
          h(ToolButton, { label: t('toolbar.open'), onClick: openExternal }, h(GlyphExternal))),
        h('div', { className: 'popoStage_content' },
          h('iframe', {
            key: epoch,
            ref: frameRef,
            className: 'popoStage_frame',
            src,
            title: t('frame.title'),
            sandbox: SANDBOX,
            referrerPolicy: 'no-referrer',
            onLoad: postZoom,
          }),
          online === false ? h('div', { className: 'popoStage_notice', role: 'status' },
            h('div', { className: 'popoStage_noticeTitle' }, t('offline.title')),
            h('div', { className: 'popoStage_noticeText' }, t('offline.detail', { url: origin })),
            h('button', { type: 'button', className: 'popoStage_noticeAction', onClick: reload }, t('offline.retry'))) : null));
    }

    // ---------- sidebar-foot trigger ----------

    /** The trigger beside Settings: opens (or reveals) the stage tab of the on-screen session. */
    function StageTrigger({ wide, t, stage, open }) {
      const mounted = useSnapshot(stage.mounted, (value) => value);
      const active = useSnapshot(stage.openTabs, (tabs) => mounted !== undefined && tabs.some((tab) => tab.sessionId === mounted && tab.kind === KIND));
      const label = t('trigger.label');
      return h('div', { className: wide ? 'popoStage_layer' : 'popoStage_layer popoStage_rail' },
        h('button', {
          type: 'button',
          className: 'popoStage_trigger',
          'aria-label': label,
          'title': label,
          'data-active': active ? 'true' : undefined,
          onClick: open,
        },
        h('span', { className: 'popoStage_triggerIcon' }, h(StageIcon, { size: wide ? 16 : 18 })),
        wide ? h('span', { className: 'popoStage_triggerLabel' }, label) : null));
    }

    // ---------- settings row ----------

    /** General-settings switch: open the stage automatically for each session. */
    function AutoOpenRow({ t, stage }) {
      const autoOpen = useSettings(stage, (s) => s.autoOpen);
      const snapshot = stage.getSnapshot();
      return h('div', { className: 'popoStage_setting' },
        h('div', { className: 'popoStage_settingHead' },
          h('span', { className: 'popoStage_settingTitle' }, t('settings.title')),
          h('button', {
            type: 'button',
            className: 'popoStage_switch',
            role: 'switch',
            'aria-checked': autoOpen,
            'aria-label': t('settings.autoOpen'),
            'data-on': autoOpen ? 'true' : 'false',
            onClick: () => stage.setAutoOpen(!autoOpen),
          }, h('span', { className: 'popoStage_knob' }))),
        h('label', { className: 'popoStage_settingHelp' }, t('settings.autoOpen')),
        h('div', { className: 'popoStage_settingHelp' }, t('settings.help', { url: snapshot.stageUrl, zoom: snapshot.defaultZoom.toFixed(1) })));
    }

    // ---------- auto-open ----------

    /**
     * Open the stage for each session that comes on screen, until the user closes the tab.
     * A close is recognised as a stage tab that disappears while its session keeps others;
     * the trigger clears that memory and opens the stage again.
     */
    function setupAutoOpen(ctx, settings) {
      const { mounted, openTabs } = ctx.sidebarRight;
      const attempted = new Set();
      const counts = new Map();

      const stageTabsIn = (sessionId) => openTabs.getSnapshot().filter((tab) => tab.sessionId === sessionId && tab.kind === KIND).length;
      const wanted = () => settings.getSnapshot().autoOpen && !settings.getSnapshot().dismissed;
      const tryOpen = (sessionId, attempt) => {
        if (!wanted() || mounted.getSnapshot() !== sessionId || stageTabsIn(sessionId) > 0) return;
        try {
          ctx.sidebarRight.openTab(KIND);
        } catch {
          // The session's Sidebar store is minted in the commit that shows it; wait and retry.
          if (attempt < 10) window.setTimeout(() => tryOpen(sessionId, attempt + 1), 300);
        }
      };
      const sync = () => {
        const sessionId = mounted.getSnapshot();
        if (sessionId === undefined || attempted.has(sessionId)) return;
        attempted.add(sessionId);
        window.setTimeout(() => tryOpen(sessionId, 0), 0);
      };
      const trackClose = () => {
        const tabs = openTabs.getSnapshot();
        const next = new Map();
        for (const tab of tabs) {
          if (tab.kind !== KIND) continue;
          next.set(tab.sessionId, (next.get(tab.sessionId) ?? 0) + 1);
        }
        for (const [sessionId, previous] of counts) {
          const current = next.get(sessionId) ?? 0;
          if (current >= previous) continue;
          if (tabs.some((tab) => tab.sessionId === sessionId)) settings.setDismissed(true);
        }
        counts.clear();
        for (const [sessionId, count] of next) counts.set(sessionId, count);
      };

      const unsubscribeMounted = mounted.subscribe(sync);
      const unsubscribeTabs = openTabs.subscribe(trackClose);
      sync();
      trackClose();
      return () => {
        unsubscribeMounted();
        unsubscribeTabs();
      };
    }

    // ---------- plugin ----------

    function apply(ctx, config) {
      const settings = createSettings(resolveSettings(config));
      const t = ctx.locale.bind(NS);

      const openStage = () => {
        settings.setDismissed(false);
        try {
          ctx.sidebarRight.openTab(KIND);
        } catch {
          /* no session on screen yet; the next session opens with the stage */
        }
      };

      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'popo-stage: dictionaries');
      ctx.effect(() => installStyle(), 'popo-stage: styles');
      ctx.effect(() => setupAutoOpen(ctx, settings), 'popo-stage: auto-open');
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: PKG,
        kind: KIND,
        keepMounted: true,
        priority: 'extension',
        title: () => t('tab.title'),
        guide: [{
          id: 'open',
          order: 5,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: StageIcon,
        }],
      }), 'popo-stage: tab type');
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: PKG,
        locale: NS,
        inject: () => ({ stage: settings }),
      }, StageBody)), 'popo-stage: tab body');
      const triggerFace = {
        stage: { ...settings, mounted: ctx.sidebarRight.mounted, openTabs: ctx.sidebarRight.openTabs },
        open: openStage,
      };
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'popo-stage',
        order: 10,
        locale: NS,
        inject: () => triggerFace,
      }, StageTrigger)), 'popo-stage: sidebar trigger');
      ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'popo-stage-auto-open',
        order: 12,
        locale: NS,
        inject: () => ({ stage: settings }),
      }, AutoOpenRow)), 'popo-stage: settings row');
    }

    return { inject, apply };
  },
});

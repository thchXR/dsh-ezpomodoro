/**
 * dsh-ezpomodoro — browser half.
 *
 * One frame-wide pill in the "shell.overlay" slot:
 *
 * - 25 minutes of focus, 5 minutes of rest, started/paused/reset by the user.
 * - A chime when a run starts and when it stops or rolls over (Web Audio, no
 *   asset files).
 * - White noise during focus, played through Bilibili's embeddable player.
 *   The source is either one long video or a 收藏夹 (favorites folder): the
 *   folder is read through this package's own Host route (api.bilibili.com has
 *   no CORS headers), and its videos play one after another, advancing on each
 *   video's own duration.
 *
 * - While the clock runs, the countdown is mirrored into the macOS menu bar
 *   through this package's Host half, and the clicks it collects are applied
 *   here (the browser half stays the only timer source).
 *
 * The pill stays out of the way: it collapses to a status pill, and the player
 * stays mounted while collapsed (made transparent instead of unmounted) so the
 * noise keeps playing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ezpomodoro',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-ezpomodoro';
    const FOCUS_MS = 25 * 60 * 1000;
    const BREAK_MS = 5 * 60 * 1000;
    const STORE_KEY = 'dsh-ezpomodoro/v2';
    /** Key written under the old plugin name, read once so the rename loses no state. */
    const PREVIOUS_KEY = 'dsh-pomodoro/v2';
    const LEGACY_KEY = 'dsh-pomodoro/v1';
    const FAV_ROUTE = '/plugin/pomodoro/fav';
    const MENUBAR_ROUTE = '/plugin/pomodoro/menubar';
    const MENUBAR_COMMANDS_ROUTE = '/plugin/pomodoro/menubar/commands';
    const MENUBAR_POLL_MS = 500;
    const PLAYER_URL = 'https://player.bilibili.com/player.html';
    const FALLBACK_DURATION_S = 240;

    const DICTS = {
      zh: {
        title: '番茄钟',
        focus: '专注',
        rest: '休息',
        start: '开始专注',
        resume: '继续',
        pause: '暂停',
        reset: '重置',
        expand: '打开番茄钟',
        collapse: '收起',
        noise: '白噪音',
        noiseOn: '白噪音：开',
        noiseOff: '白噪音：关',
        pickVideo: '白噪音来源',
        addVideo: '添加视频或收藏夹',
        removeVideo: '移除当前来源',
        inputHint: '粘贴 B 站链接、BV 号或收藏夹链接',
        add: '添加',
        cancel: '取消',
        invalid: '没有找到 BV 号或收藏夹 id',
        sourceVideo: '视频',
        sourceFav: '收藏夹',
        favLoading: '正在读取收藏夹…',
        favFailed: '收藏夹读取失败',
        favEmpty: '收藏夹里没有可播放的视频',
        retry: '重试',
        next: '下一集',
      },
      en: {
        title: 'Pomodoro',
        focus: 'Focus',
        rest: 'Rest',
        start: 'Start focus',
        resume: 'Resume',
        pause: 'Pause',
        reset: 'Reset',
        expand: 'Open pomodoro clock',
        collapse: 'Collapse',
        noise: 'White noise',
        noiseOn: 'White noise: on',
        noiseOff: 'White noise: off',
        pickVideo: 'White noise source',
        addVideo: 'Add a video or a favorites folder',
        removeVideo: 'Remove current source',
        inputHint: 'Paste a Bilibili link, a BV id or a favorites link',
        add: 'Add',
        cancel: 'Cancel',
        invalid: 'No BV id or favorites id found',
        sourceVideo: 'Video',
        sourceFav: 'Favorites',
        favLoading: 'Reading favorites…',
        favFailed: 'Could not read that folder',
        favEmpty: 'No playable videos in that folder',
        retry: 'Retry',
        next: 'Next',
      },
    };

    /** Curated long-form ambient videos, used until the user edits the list. */
    const DEFAULT_SOURCES = [
      { kind: 'video', id: 'BV1ad4y1c7ki', title: '雨林雨声 · 9h55m' },
      { kind: 'video', id: 'BV1MNKa6QEbC', title: '篝火 · Study with me · 3h' },
      { kind: 'video', id: 'BV1Sw4nzdEkk', title: '沉浸式白噪音 · 1h' },
    ];

    /** Shared empty favorites value: replaced, never mutated. */
    const EMPTY_FAV = { key: '', loading: false, error: '', items: [] };

    const COLORS = {
      surface: 'var(--dsw-alias-bg-layer-1)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      textSecondary: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    const STYLE_TEXT = [
      '.dsh-pomo-pill:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dsh-pomo-btn:hover:not(:disabled),.dsh-pomo-icon:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-pomo-btn:disabled,.dsh-pomo-icon:disabled{opacity:.45;cursor:default}',
      '.dsh-pomo-pill:focus-visible,.dsh-pomo-btn:focus-visible,.dsh-pomo-icon:focus-visible,.dsh-pomo-select:focus-visible,.dsh-pomo-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '@keyframes dshPomoPulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.dsh-pomo-dot.is-live{animation:dshPomoPulse 1.6s ease-in-out infinite}',
      '@media (prefers-reduced-motion: reduce){.dsh-pomo-dot.is-live{animation:none}}',
    ].join('\n');

    const ROOT_STYLE = {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: 70,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '8px',
      pointerEvents: 'auto',
      fontFamily: 'inherit',
      color: COLORS.text,
    };

    const PILL_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      height: '36px',
      padding: '0 12px',
      borderRadius: '999px',
      border: '1px solid ' + COLORS.border,
      background: COLORS.surface,
      color: COLORS.text,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: 1,
      cursor: 'pointer',
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
      fontVariantNumeric: 'tabular-nums',
    };

    const CARD_STYLE = {
      width: '320px',
      padding: '12px',
      borderRadius: '14px',
      border: '1px solid ' + COLORS.borderStrong,
      background: COLORS.overlay,
      boxShadow: '0 12px 36px rgba(0, 0, 0, 0.28)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      boxSizing: 'border-box',
    };

    const HEADER_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontSize: '12px',
      color: COLORS.textSecondary,
    };

    const CHIP_STYLE = {
      padding: '2px 8px',
      borderRadius: '999px',
      background: COLORS.layer2,
      color: COLORS.textSecondary,
      fontSize: '11px',
      lineHeight: 1.6,
    };

    const CLOCK_STYLE = {
      fontSize: '34px',
      fontWeight: 600,
      lineHeight: 1.1,
      textAlign: 'center',
      letterSpacing: '0.5px',
      fontVariantNumeric: 'tabular-nums',
      color: COLORS.text,
    };

    const BAR_STYLE = {
      height: '4px',
      borderRadius: '999px',
      background: COLORS.layer2,
      overflow: 'hidden',
    };

    const BUTTON_STYLE = {
      height: '32px',
      padding: '0 12px',
      borderRadius: '9px',
      border: '1px solid ' + COLORS.borderStrong,
      background: 'transparent',
      color: COLORS.text,
      fontFamily: 'inherit',
      fontSize: '12.5px',
      lineHeight: 1,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    const PRIMARY_BUTTON_STYLE = Object.assign({}, BUTTON_STYLE, {
      background: COLORS.brand,
      borderColor: COLORS.brand,
      color: '#ffffff',
      flex: '1',
    });

    const MINI_BUTTON_STYLE = {
      height: '22px',
      padding: '0 8px',
      borderRadius: '7px',
      border: '1px solid ' + COLORS.borderStrong,
      background: 'transparent',
      color: COLORS.text,
      fontFamily: 'inherit',
      fontSize: '11px',
      lineHeight: 1,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    const ICON_BUTTON_STYLE = {
      width: '32px',
      height: '32px',
      flex: 'none',
      padding: 0,
      borderRadius: '9px',
      border: '1px solid ' + COLORS.borderStrong,
      background: 'transparent',
      color: COLORS.text,
      fontFamily: 'inherit',
      fontSize: '14px',
      lineHeight: 1,
      cursor: 'pointer',
    };

    const SELECT_STYLE = {
      flex: '1',
      minWidth: 0,
      height: '32px',
      padding: '0 6px',
      borderRadius: '9px',
      border: '1px solid ' + COLORS.borderStrong,
      background: COLORS.layer2,
      color: COLORS.text,
      fontFamily: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    };

    const INPUT_STYLE = {
      flex: '1',
      minWidth: 0,
      height: '32px',
      padding: '0 8px',
      borderRadius: '9px',
      border: '1px solid ' + COLORS.borderStrong,
      background: COLORS.layer2,
      color: COLORS.text,
      fontFamily: 'inherit',
      fontSize: '12px',
    };

    const DOT_STYLE = {
      width: '8px',
      height: '8px',
      flex: 'none',
      borderRadius: '50%',
      background: COLORS.idle,
    };

    const FAV_LINE_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      fontSize: '11px',
      minHeight: '22px',
      color: COLORS.textSecondary,
    };

    const PLAYER_FRAME_STYLE = {
      width: '320px',
      aspectRatio: '16 / 9',
      borderRadius: '10px',
      overflow: 'hidden',
      background: '#000000',
      border: '1px solid ' + COLORS.borderStrong,
    };

    /**
     * While the pill is collapsed the player keeps its real size (a 1px box
     * makes some players pause) and is only made transparent.
     */
    const HIDDEN_PLAYER_STYLE = Object.assign({}, PLAYER_FRAME_STYLE, {
      position: 'absolute',
      right: '0',
      bottom: '44px',
      opacity: 0,
      pointerEvents: 'none',
    });

    const IFRAME_STYLE = {
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block',
    };

    /* ---------------------------------------------------------------- store */

    /** In-memory 收藏夹 cache: mediaId -> { title, items }. */
    const favoritesMemo = new Map();

    function readStore() {
      try {
        for (const key of [STORE_KEY, PREVIOUS_KEY]) {
          const raw = window.localStorage.getItem(key);
          if (raw === null) continue;
          const value = JSON.parse(raw);
          if (value !== null && typeof value === 'object') return value;
        }
        const legacy = window.localStorage.getItem(LEGACY_KEY);
        if (legacy === null) return null;
        const old = JSON.parse(legacy);
        if (old === null || typeof old !== 'object' || !Array.isArray(old.videos)) return null;
        return Object.assign({}, old, {
          sources: old.videos.map((video) => ({ kind: 'video', id: video.id, title: video.title })),
          sourceKey: 'video:' + old.videoId,
        });
      } catch (error) {
        return null;
      }
    }

    function writeStore(value) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(value));
      } catch (error) {
        /* private mode or a full quota: the timer still works for this page */
      }
    }

    function keyOf(source) {
      return source.kind + ':' + source.id;
    }

    function sourceOf(sources, key) {
      return sources.find((source) => keyOf(source) === key) || sources[0];
    }

    function sanitizeSources(input) {
      if (!Array.isArray(input)) return null;
      const seen = {};
      const sources = [];
      for (const item of input) {
        if (item === null || typeof item !== 'object') continue;
        const kind = item.kind === 'fav' ? 'fav' : 'video';
        let id = null;
        if (kind === 'fav' && typeof item.id === 'string' && /^[0-9]{4,20}$/.test(item.id)) id = item.id;
        if (kind === 'video') id = parseBvid(item.id);
        if (id === null) continue;
        const key = kind + ':' + id;
        if (seen[key] === true) continue;
        seen[key] = true;
        const title = typeof item.title === 'string' && item.title !== '' ? item.title : id;
        sources.push({ kind, id, title: title.slice(0, 80) });
      }
      return sources.length > 0 ? sources : null;
    }

    function initialState() {
      const saved = readStore();
      const sources = sanitizeSources(saved === null ? null : saved.sources) || DEFAULT_SOURCES.map((source) => Object.assign({}, source));
      const savedKey = saved === null ? null : saved.sourceKey;
      const state = {
        mode: 'focus',
        status: 'idle',
        endsAt: 0,
        remainingMs: FOCUS_MS,
        sources,
        sourceKey: sources.some((source) => keyOf(source) === savedKey) ? savedKey : keyOf(sources[0]),
        favIndex: 0,
        noise: saved === null || saved.noise !== false,
      };
      if (saved !== null && Number.isInteger(saved.favIndex) && saved.favIndex >= 0) state.favIndex = saved.favIndex;
      if (
        saved !== null &&
        saved.status === 'running' &&
        typeof saved.endsAt === 'number' &&
        saved.endsAt > Date.now() + 1000
      ) {
        state.mode = saved.mode === 'break' ? 'break' : 'focus';
        state.status = 'running';
        state.endsAt = saved.endsAt;
        state.remainingMs = 0;
      }
      return state;
    }

    function parseBvid(input) {
      const text = String(input === null || input === undefined ? '' : input).trim();
      if (text === '') return null;
      const match = text.match(/BV[0-9A-Za-z]{10}/i);
      if (match === null) return null;
      return 'BV' + match[0].slice(2);
    }

    /** Read the 收藏夹 id out of a Bilibili link, or a bare number. */
    function parseFavId(input) {
      const text = String(input === null || input === undefined ? '' : input).trim();
      if (text === '') return null;
      const listed = text.match(/ml([0-9]{4,20})/i);
      if (listed !== null) return listed[1];
      const query = text.match(/media_id=([0-9]{4,20})/);
      if (query !== null) return query[1];
      if (/^[0-9]{4,20}$/.test(text)) return text;
      return null;
    }

    function durationOf(mode) {
      return mode === 'focus' ? FOCUS_MS : BREAK_MS;
    }

    function formatTime(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return (minutes < 10 ? '0' + minutes : String(minutes)) + ':' + (seconds < 10 ? '0' + seconds : String(seconds));
    }

    function playerUrl(bvid) {
      return (
        PLAYER_URL +
        '?isOutside=true&bvid=' +
        encodeURIComponent(bvid) +
        '&p=1&autoplay=1&danmaku=0&high_quality=1'
      );
    }

    /** Read one 收藏夹 through this package's Host route. */
    async function loadFavorites(mediaId) {
      const memo = favoritesMemo.get(mediaId);
      if (memo !== undefined) return memo;

      let response;
      try {
        response = await window.fetch(FAV_ROUTE + '?media_id=' + encodeURIComponent(mediaId), {
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        throw new Error('failed');
      }
      if (!response.ok) throw new Error('failed');

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error('failed');
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) throw new Error('failed');

      const items = [];
      if (Array.isArray(payload.items)) {
        for (const item of payload.items) {
          if (item === null || typeof item !== 'object') continue;
          const bvid = typeof item.bvid === 'string' ? item.bvid : '';
          if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
          const duration = Number(item.duration);
          items.push({
            bvid,
            title: String(item.title === undefined ? bvid : item.title),
            duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
          });
        }
      }
      if (items.length === 0) throw new Error('empty');

      const result = {
        title: typeof payload.title === 'string' && payload.title !== '' ? payload.title : '收藏夹',
        items,
      };
      favoritesMemo.set(mediaId, result);
      return result;
    }

    /* ---------------------------------------------------------------- audio */

    let audioContext = null;

    function ensureAudioContext() {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor === undefined) return null;
      if (audioContext === null) {
        try {
          audioContext = new Ctor();
        } catch (error) {
          return null;
        }
      }
      if (audioContext.state === 'suspended') {
        const resumed = audioContext.resume();
        if (resumed !== undefined && typeof resumed.catch === 'function') resumed.catch(() => {});
      }
      return audioContext;
    }

    const CHIMES = {
      start: [523.25, 783.99],
      end: [659.25, 783.99, 1046.5],
      stop: [523.25, 392.0],
    };

    function playChime(kind) {
      const context = ensureAudioContext();
      if (context === null) return;
      const notes = CHIMES[kind] === undefined ? CHIMES.start : CHIMES[kind];
      const base = context.currentTime + 0.02;
      notes.forEach((frequency, index) => {
        const startsAt = base + index * 0.16;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, startsAt);
        gain.gain.exponentialRampToValueAtTime(0.18, startsAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.26);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startsAt);
        oscillator.stop(startsAt + 0.3);
      });
    }

    /* -------------------------------------------------------------- menubar */

    /** Push the current menu bar state; every failure is silent by design. */
    function postMenubar(payload, signal) {
      try {
        window
          .fetch(MENUBAR_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
          })
          .catch(() => {});
      } catch (error) {
        /* a blocked request must never reach the clock */
      }
    }

    /** Take the actions the Host collected from the menu bar; [] on any failure. */
    async function takeMenubarActions(signal) {
      let response;
      try {
        response = await window.fetch(MENUBAR_COMMANDS_ROUTE, {
          headers: { accept: 'application/json' },
          signal,
        });
      } catch (error) {
        return [];
      }
      if (!response.ok) return [];
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        return [];
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true || !Array.isArray(payload.actions)) {
        return [];
      }
      return payload.actions.filter((action) => typeof action === 'string');
    }

    /* ------------------------------------------------------------ component */

    function Pomodoro(props) {
      const ctx = props.ctx;
      const [, setLocaleRevision] = React.useState(0);
      React.useEffect(() => ctx.locale.subscribe(() => setLocaleRevision((value) => value + 1)), []);
      const t = ctx.locale.bind(NS);

      const [state, setState] = React.useState(initialState);
      const [expanded, setExpanded] = React.useState(false);
      const [now, setNow] = React.useState(() => Date.now());
      const [adding, setAdding] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [fav, setFav] = React.useState(EMPTY_FAV);
      const [favToken, setFavToken] = React.useState(0);
      const menubarShown = React.useRef(false);

      const running = state.status === 'running';
      const total = durationOf(state.mode);
      const remaining = running ? Math.max(0, state.endsAt - now) : state.remainingMs;
      const progress = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));

      const source = sourceOf(state.sources, state.sourceKey);
      const isFav = source.kind === 'fav';
      const favLength = fav.items.length;
      const favIndex = favLength > 0 ? state.favIndex % favLength : 0;
      const favItem = favLength > 0 ? fav.items[favIndex] : null;
      const activeBvid = isFav ? (favItem === null ? null : favItem.bvid) : source.id;
      const playsNoise = state.noise && state.mode === 'focus' && running && activeBvid !== null;

      React.useEffect(() => {
        if (!running) return undefined;
        const interval = window.setInterval(() => setNow(Date.now()), 250);
        const resync = () => setNow(Date.now());
        document.addEventListener('visibilitychange', resync);
        return () => {
          window.clearInterval(interval);
          document.removeEventListener('visibilitychange', resync);
        };
      }, [running]);

      // The title string only changes once per second, so this pushes at most
      // once per second on the chain the clock already drives.
      const menubarTitle = (state.mode === 'focus' ? '🍅' : '🍵') + ' ' + formatTime(remaining);

      React.useEffect(() => {
        if (!running) return undefined;
        menubarShown.current = true;
        postMenubar({
          running: true,
          title: menubarTitle,
          labels: { toggle: t('pause'), reset: t('reset'), panel: t('expand') },
        });
        return undefined;
      }, [running, menubarTitle]);

      // The item exists only while the clock runs: hide it once, on the edge.
      React.useEffect(() => {
        if (running || !menubarShown.current) return undefined;
        menubarShown.current = false;
        postMenubar({ running: false });
        return undefined;
      }, [running]);

      // Unmounting drops the item too, bounded by an abort so nothing is left
      // pending and no rejection escapes.
      React.useEffect(
        () => () => {
          const controller = new AbortController();
          postMenubar({ running: false }, controller.signal);
          window.setTimeout(() => controller.abort(), 1000);
        },
        [],
      );

      // Menu bar clicks arrive as queued actions; the Host empties the queue.
      React.useEffect(() => {
        if (!running) return undefined;
        const controller = new AbortController();
        let busy = false;
        const interval = window.setInterval(() => {
          if (busy) return;
          busy = true;
          takeMenubarActions(controller.signal)
            .then((actions) => {
              busy = false;
              for (const action of actions) {
                if (action === 'toggle') toggleClock();
                else if (action === 'reset') reset();
                else if (action === 'panel') setExpanded(true);
              }
            })
            .catch(() => {});
        }, MENUBAR_POLL_MS);
        return () => {
          window.clearInterval(interval);
          controller.abort();
        };
      }, [running]);

      React.useEffect(() => {
        writeStore({
          mode: state.mode,
          status: state.status,
          endsAt: state.endsAt,
          sources: state.sources,
          sourceKey: state.sourceKey,
          favIndex: state.favIndex,
          noise: state.noise,
        });
      }, [state.mode, state.status, state.endsAt, state.sources, state.sourceKey, state.favIndex, state.noise]);

      React.useEffect(() => {
        if (!running || state.endsAt === 0 || now < state.endsAt) return;
        playChime('end');
        setState((prev) =>
          prev.mode === 'focus'
            ? Object.assign({}, prev, { mode: 'break', status: 'running', endsAt: Date.now() + BREAK_MS, remainingMs: BREAK_MS })
            : Object.assign({}, prev, { mode: 'focus', status: 'idle', endsAt: 0, remainingMs: FOCUS_MS }),
        );
      }, [now, running, state.endsAt]);

      // Read the selected folder once. Dependencies are only the source and an
      // explicit retry token, so recording the loading state cannot cancel the
      // request it belongs to.
      React.useEffect(() => {
        if (!isFav) {
          setFav((prev) => (prev.key === '' && prev.items.length === 0 && !prev.loading && prev.error === '' ? prev : EMPTY_FAV));
          return undefined;
        }
        const memo = favoritesMemo.get(source.id);
        if (memo !== undefined) {
          setFav((prev) =>
            prev.key === source.id && prev.items === memo.items && prev.error === '' && !prev.loading
              ? prev
              : { key: source.id, loading: false, error: '', items: memo.items },
          );
          return undefined;
        }
        let cancelled = false;
        setFav((prev) => (prev.key === source.id && prev.loading ? prev : { key: source.id, loading: true, error: '', items: [] }));
        loadFavorites(source.id).then(
          (result) => {
            if (cancelled) return;
            setFav({ key: source.id, loading: false, error: '', items: result.items });
          },
          (error) => {
            if (cancelled) return;
            setFav({
              key: source.id,
              loading: false,
              error: error instanceof Error && error.message === 'empty' ? 'empty' : 'failed',
              items: [],
            });
          },
        );
        return () => {
          cancelled = true;
        };
      }, [isFav, source.id, favToken]);

      // Auto-advance the favorites folder on each video's own duration.
      React.useEffect(() => {
        if (!running || state.mode !== 'focus' || !isFav || favLength === 0) return undefined;
        const item = fav.items[favIndex];
        if (item === undefined) return undefined;
        const seconds = item.duration > 0 ? item.duration : FALLBACK_DURATION_S;
        const timer = window.setTimeout(() => {
          setState((prev) => Object.assign({}, prev, { favIndex: prev.favIndex + 1 }));
        }, seconds * 1000 + 1200);
        return () => window.clearTimeout(timer);
      }, [running, state.mode, isFav, favIndex, favLength, fav.items]);

      function start() {
        playChime('start');
        setNow(Date.now());
        setState((prev) => {
          const left = prev.remainingMs > 1000 ? prev.remainingMs : durationOf(prev.mode);
          return Object.assign({}, prev, { status: 'running', endsAt: Date.now() + left, remainingMs: left });
        });
      }

      function pause() {
        playChime('stop');
        setState((prev) =>
          Object.assign({}, prev, {
            status: 'paused',
            endsAt: 0,
            remainingMs: Math.max(0, prev.endsAt - Date.now()),
          }),
        );
      }

      function reset() {
        if (state.status !== 'idle') playChime('stop');
        setNow(Date.now());
        setState((prev) => Object.assign({}, prev, { status: 'idle', endsAt: 0, remainingMs: durationOf(prev.mode) }));
      }

      /** The one start/pause rule, shared by the button and the menu bar. */
      function toggleClock() {
        if (running) pause();
        else start();
      }

      function toggleNoise() {
        setState((prev) => Object.assign({}, prev, { noise: !prev.noise }));
      }

      function selectSource(key) {
        setState((prev) => Object.assign({}, prev, { sourceKey: key, favIndex: 0 }));
      }

      function removeSource() {
        setState((prev) => {
          if (prev.sources.length <= 1) return prev;
          const sources = prev.sources.filter((item) => keyOf(item) !== prev.sourceKey);
          if (sources.length === 0) return prev;
          return Object.assign({}, prev, { sources, sourceKey: keyOf(sources[0]), favIndex: 0 });
        });
        setNotice('');
        setAdding(false);
      }

      function nextEpisode() {
        setState((prev) => Object.assign({}, prev, { favIndex: prev.favIndex + 1 }));
      }

      function retryFavorites() {
        if (isFav) favoritesMemo.delete(source.id);
        setFav(EMPTY_FAV);
        setFavToken((value) => value + 1);
      }

      function addVideoSource(bvid, title) {
        setState((prev) =>
          Object.assign({}, prev, {
            sources: prev.sources.some((item) => keyOf(item) === 'video:' + bvid)
              ? prev.sources
              : prev.sources.concat([{ kind: 'video', id: bvid, title }]),
            sourceKey: 'video:' + bvid,
            favIndex: 0,
          }),
        );
      }

      async function addSource() {
        const text = draft.trim();
        const bvid = parseBvid(text);
        if (bvid !== null) {
          const title = text.toUpperCase() === bvid.toUpperCase() ? bvid : text.slice(0, 60);
          addVideoSource(bvid, title);
          setDraft('');
          setAdding(false);
          setNotice('');
          return;
        }
        const favId = parseFavId(text);
        if (favId === null) {
          setNotice(t('invalid'));
          return;
        }
        setNotice('');
        setAdding(false);
        setDraft('');
        try {
          const result = await loadFavorites(favId);
          setState((prev) =>
            Object.assign({}, prev, {
              sources: prev.sources.some((item) => keyOf(item) === 'fav:' + favId)
                ? prev.sources
                : prev.sources.concat([{ kind: 'fav', id: favId, title: result.title }]),
              sourceKey: 'fav:' + favId,
              favIndex: 0,
            }),
          );
        } catch (error) {
          setNotice(error instanceof Error && error.message === 'empty' ? t('favEmpty') : t('favFailed'));
        }
      }

      const player = playsNoise
        ? h(
            'div',
            { key: 'player', style: expanded ? PLAYER_FRAME_STYLE : HIDDEN_PLAYER_STYLE },
            h('iframe', {
              key: activeBvid,
              src: playerUrl(activeBvid),
              title: t('pickVideo'),
              allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
              allowFullScreen: true,
              style: IFRAME_STYLE,
            }),
          )
        : null;

      const dotStyle = Object.assign({}, DOT_STYLE, {
        background: running ? (state.mode === 'focus' ? COLORS.brand : COLORS.success) : COLORS.idle,
      });

      const pill = h(
        'button',
        {
          key: 'pill',
          type: 'button',
          className: 'dsh-pomo-pill',
          style: PILL_STYLE,
          onClick: () => setExpanded(true),
          title: t('expand'),
          'aria-expanded': expanded,
          'aria-label': t('expand'),
        },
        h('span', { className: 'dsh-pomo-dot' + (running ? ' is-live' : ''), style: dotStyle }),
        h('span', null, formatTime(remaining)),
        playsNoise ? h('span', { style: { fontSize: '11px', color: COLORS.textSecondary } }, '♪') : null,
      );

      const videoSources = state.sources.filter((item) => item.kind === 'video');
      const favSources = state.sources.filter((item) => item.kind === 'fav');
      const optionGroups = [];
      if (videoSources.length > 0) {
        optionGroups.push(
          h(
            'optgroup',
            { key: 'videos', label: t('sourceVideo') },
            videoSources.map((item) => h('option', { key: keyOf(item), value: keyOf(item) }, item.title)),
          ),
        );
      }
      if (favSources.length > 0) {
        optionGroups.push(
          h(
            'optgroup',
            { key: 'favorites', label: t('sourceFav') },
            favSources.map((item) => h('option', { key: keyOf(item), value: keyOf(item) }, item.title)),
          ),
        );
      }

      const noiseRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
        h(
          'button',
          {
            key: 'noise-toggle',
            type: 'button',
            className: 'dsh-pomo-icon',
            style: Object.assign({}, ICON_BUTTON_STYLE, {
              color: state.noise ? COLORS.brand : COLORS.textSecondary,
              borderColor: state.noise ? COLORS.brand : COLORS.borderStrong,
            }),
            onClick: toggleNoise,
            title: state.noise ? t('noiseOn') : t('noiseOff'),
            'aria-label': t('noise'),
            'aria-pressed': state.noise,
          },
          '♪',
        ),
        h(
          'select',
          {
            key: 'source',
            className: 'dsh-pomo-select',
            style: SELECT_STYLE,
            value: keyOf(source),
            title: t('pickVideo'),
            'aria-label': t('pickVideo'),
            onChange: (event) => selectSource(event.target.value),
          },
          optionGroups,
        ),
        h(
          'button',
          {
            key: 'add',
            type: 'button',
            className: 'dsh-pomo-icon',
            style: ICON_BUTTON_STYLE,
            onClick: () => {
              setAdding((value) => !value);
              setNotice('');
            },
            title: t('addVideo'),
            'aria-label': t('addVideo'),
          },
          '+',
        ),
        h(
          'button',
          {
            key: 'remove',
            type: 'button',
            className: 'dsh-pomo-icon',
            style: ICON_BUTTON_STYLE,
            onClick: removeSource,
            disabled: state.sources.length <= 1,
            title: t('removeVideo'),
            'aria-label': t('removeVideo'),
          },
          '\u00d7',
        ),
      ]);

      const favLine = isFav
        ? h(
            'div',
            { key: 'fav-line', style: FAV_LINE_STYLE },
            fav.loading || (favLength === 0 && fav.error === '')
              ? h('span', null, t('favLoading'))
              : fav.error !== ''
                ? [
                    h(
                      'span',
                      { key: 'error', style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      fav.error === 'empty' ? t('favEmpty') : t('favFailed'),
                    ),
                    h(
                      'button',
                      { key: 'retry', type: 'button', className: 'dsh-pomo-btn', style: MINI_BUTTON_STYLE, onClick: retryFavorites },
                      t('retry'),
                    ),
                  ]
                : [
                    h(
                      'span',
                      { key: 'progress', style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      favIndex + 1 + '/' + favLength + ' · ' + (favItem === null ? '' : favItem.title),
                    ),
                    h(
                      'button',
                      { key: 'next', type: 'button', className: 'dsh-pomo-btn', style: MINI_BUTTON_STYLE, onClick: nextEpisode },
                      t('next'),
                    ),
                  ],
          )
        : null;

      const addRow = h('div', { style: { display: 'flex', gap: '6px' } }, [
        h('input', {
          key: 'draft',
          className: 'dsh-pomo-input',
          style: INPUT_STYLE,
          value: draft,
          placeholder: t('inputHint'),
          'aria-label': t('inputHint'),
          onChange: (event) => {
            setDraft(event.target.value);
            setNotice('');
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') addSource();
            if (event.key === 'Escape') {
              setAdding(false);
              setDraft('');
            }
          },
        }),
        h(
          'button',
          { key: 'ok', type: 'button', className: 'dsh-pomo-btn', style: BUTTON_STYLE, onClick: addSource },
          t('add'),
        ),
        h(
          'button',
          {
            key: 'cancel',
            type: 'button',
            className: 'dsh-pomo-btn',
            style: BUTTON_STYLE,
            onClick: () => {
              setAdding(false);
              setDraft('');
              setNotice('');
            },
          },
          t('cancel'),
        ),
      ]);

      const card = h('div', { key: 'card', style: CARD_STYLE, role: 'dialog', 'aria-label': t('title') }, [
        h('div', { key: 'header', style: HEADER_STYLE }, [
          h('span', { key: 'title', style: { fontWeight: 600, color: COLORS.text } }, t('title')),
          h('span', { key: 'chip', style: CHIP_STYLE }, t(state.mode === 'focus' ? 'focus' : 'rest')),
          h('span', { key: 'spacer', style: { flex: '1' } }),
          h(
            'button',
            {
              key: 'collapse',
              type: 'button',
              className: 'dsh-pomo-icon',
              style: ICON_BUTTON_STYLE,
              onClick: () => setExpanded(false),
              title: t('collapse'),
              'aria-label': t('collapse'),
            },
            '\u2013',
          ),
        ]),
        h('div', { key: 'clock', style: CLOCK_STYLE }, formatTime(remaining)),
        h(
          'div',
          { key: 'bar', style: BAR_STYLE },
          h('div', {
            style: {
              height: '100%',
              width: progress + '%',
              background: COLORS.brand,
              borderRadius: '999px',
              transition: 'width 250ms linear',
            },
          }),
        ),
        h('div', { key: 'actions', style: { display: 'flex', gap: '8px' } }, [
          h(
            'button',
            {
              key: 'toggle',
              type: 'button',
              className: 'dsh-pomo-btn',
              style: PRIMARY_BUTTON_STYLE,
              onClick: toggleClock,
            },
            t(running ? 'pause' : state.status === 'paused' ? 'resume' : 'start'),
          ),
          h(
            'button',
            {
              key: 'reset',
              type: 'button',
              className: 'dsh-pomo-btn',
              style: BUTTON_STYLE,
              onClick: reset,
              disabled: state.status === 'idle',
            },
            t('reset'),
          ),
        ]),
        noiseRow,
        favLine,
        adding ? addRow : null,
        notice === ''
          ? null
          : h('div', { key: 'notice', style: { fontSize: '11px', color: COLORS.warn } }, notice),
      ]);

      return h('div', { className: 'dsh-pomo-root', style: ROOT_STYLE }, [
        h('style', { key: 'style' }, STYLE_TEXT),
        player,
        expanded ? card : pill,
      ]);
    }

    /* -------------------------------------------------------------- plugin */

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => {
        const disposeZh = ctx.locale.register(NS, 'zh', DICTS.zh);
        const disposeEn = ctx.locale.register(NS, 'en', DICTS.en);
        return () => {
          disposeZh();
          disposeEn();
        };
      }, 'dsh-ezpomodoro: dictionaries');
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-ezpomodoro', order: 1003, label: () => t('title') },
          () => h(Pomodoro, { ctx }),
        ),
      );
    }

    return { inject, apply };
  },
});
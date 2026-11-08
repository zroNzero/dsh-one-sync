/**
 * dsh-one-sync —— 浏览器侧（Client 半身）。
 *
 * 装载格式与 DSH Web 的插件模块一致：window.__ModuleLoader__.load({ id, factory })。
 * 平台模块（react）由注入的 require 解析，本文件不依赖任何构建步骤。
 *
 * 数据面：
 *   GET  /dsh-one-sync/api/status   运行状态
 *   GET  /dsh-one-sync/api/config   读取配置（token / 口令不回显）
 *   POST /dsh-one-sync/api/config   保存配置
 *   POST /dsh-one-sync/api/migrate  收编旧工作区到大仓
 *   POST /dsh-one-sync/api/sync     同步
 */
window.__ModuleLoader__.load({
  id: 'dsh-one-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var API = '/dsh-one-sync/api';

    // ── 小工具 ──────────────────────────────────────────────────────────
    function errText(error) {
      return String((error && error.message) || error || '未知错误');
    }

    function req(path, init) {
      return fetch(API + path, Object.assign({ cache: 'no-store' }, init || {})).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (!res.ok) {
            var message = (body && (body.error || body.text)) || ('HTTP ' + res.status);
            throw new Error(message);
          }
          return body;
        });
      });
    }

    function apiGet(path) {
      return req(path, { method: 'GET' });
    }

    function apiPost(path, body) {
      return req(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }

    function fmtTime(iso) {
      if (!iso) return '未记录';
      var date = new Date(iso);
      if (isNaN(date.getTime())) return String(iso);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
        pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function fmtDuration(ms) {
      var value = Number(ms);
      if (!isFinite(value)) return '';
      if (value < 1000) return Math.round(value) + 'ms';
      var seconds = value / 1000;
      return seconds.toFixed(seconds >= 10 || Math.floor(seconds) === seconds ? 0 : 1) + 's';
    }

    function fmtTimings(timings) {
      if (!timings || typeof timings !== 'object') return '';
      var labels = {
        'Git pull': '拉取代码',
        'State pull': '拉取备份',
        'Git push': '推送代码',
        'State push': '上传备份',
        'State scan': '扫描',
        'State prepare': '准备',
        'State encrypt': '加密',
        'Upload': '上传',
        'Pull snapshot': '读取远端',
        'Pull prepare': '准备拉取',
        'Prefetch': '预取',
        'Total': '总计',
      };
      var order = Object.keys(labels);
      var names = order.filter(function (name) { return timings[name] !== undefined; });
      Object.keys(timings).forEach(function (name) {
        if (names.indexOf(name) < 0) names.push(name);
      });
      return names.map(function (name) {
        return (labels[name] || name) + ': ' + fmtDuration(timings[name]);
      }).join(' / ');
    }

    /** 目录名 → GitHub 仓库名建议。 */
    function suggestRepoName(path) {
      var base = String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'my-project';
      var slug = base.toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/[-._]{2,}/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '')
        .slice(0, 100)
        .replace(/^[-._]+|[-._]+$/g, '');
      return slug || 'my-project';
    }

    // ── 全局同步状态 store（侧栏与设置页共用同一个实例） ────────────────
    function createSyncStore() {
      var state = { status: null, error: null, syncing: false, lastResult: null };
      var listeners = [];
      var refreshPromise = null;
      var syncPromise = null;
      var timer = null;
      var started = false;
      var visibilityHandler = null;

      function emit(patch) {
        state = Object.assign({}, state, patch);
        listeners.slice().forEach(function (listener) {
          try { listener(state); } catch (error) { /* 单个订阅者失败不影响其它 UI */ }
        });
      }

      function getSnapshot() { return state; }

      function subscribe(listener) {
        listeners.push(listener);
        return function () {
          var at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      }

      function busy() {
        return state.syncing || Boolean(state.status && state.status.busy);
      }

      function schedule() {
        if (!started) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
          if (typeof document !== 'undefined' && document.hidden) {
            schedule();
            return;
          }
          refresh();
        }, busy() ? 1000 : 15000);
      }

      function refresh() {
        if (refreshPromise) return refreshPromise;
        var request = apiGet('/status').then(function (snapshot) {
          emit({ status: snapshot, error: null });
          return snapshot;
        }).catch(function (cause) {
          emit({ error: errText(cause) });
          return null;
        });
        refreshPromise = request.then(function (result) {
          refreshPromise = null;
          schedule();
          return result;
        });
        return refreshPromise;
      }

      function refreshAfterCurrent() {
        if (!started) return;
        if (refreshPromise) {
          refreshPromise.then(function () { refresh(); });
        } else {
          refresh();
        }
      }

      function runSync() {
        if (syncPromise) return syncPromise;
        var initialStatus = state.status
          ? Object.assign({}, state.status, { busy: true })
          : null;
        emit({ syncing: true, status: initialStatus, lastResult: null });
        schedule();

        syncPromise = apiPost('/sync', {}).then(function (report) {
          var result = report && typeof report === 'object' ? report : {};
          var text = result.text || result.error || (result.ok ? '同步完成' : '同步失败');
          return {
            ok: Boolean(result.ok),
            text: text,
            error: result.error || '',
            report: result,
            at: Date.now(),
          };
        }).catch(function (cause) {
          var message = errText(cause);
          return {
            ok: false,
            text: '同步失败：' + message,
            error: message,
            report: null,
            at: Date.now(),
          };
        }).then(function (outcome) {
          var nextStatus = state.status ? Object.assign({}, state.status) : null;
          if (nextStatus) {
            nextStatus.busy = Boolean(outcome.report && outcome.report.busy);
            nextStatus.lastSyncAt = (outcome.report && outcome.report.at) || new Date(outcome.at).toISOString();
            nextStatus.lastError = outcome.ok ? null : (outcome.error || outcome.text);
            if (outcome.report && outcome.report.timings) {
              nextStatus.timings = outcome.report.timings;
              nextStatus.lastReport = Object.assign({}, nextStatus.lastReport || {}, {
                timings: outcome.report.timings,
              });
            }
          }
          emit({ syncing: false, status: nextStatus, lastResult: outcome });
          syncPromise = null;
          refreshAfterCurrent();
          return outcome;
        });
        return syncPromise;
      }

      function start() {
        if (started) return;
        started = true;
        if (typeof document !== 'undefined') {
          visibilityHandler = function () {
            if (!document.hidden) refresh();
          };
          document.addEventListener('visibilitychange', visibilityHandler);
        }
        refresh();
      }

      function stop() {
        started = false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (visibilityHandler && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', visibilityHandler);
          visibilityHandler = null;
        }
      }

      return {
        getSnapshot: getSnapshot,
        subscribe: subscribe,
        refresh: refresh,
        runSync: runSync,
        start: start,
        stop: stop,
      };
    }

    var syncStore = createSyncStore();

    function useSyncStore() {
      var pair = useState(syncStore.getSnapshot());
      var snapshot = pair[0];
      var setSnapshot = pair[1];

      useEffect(function () {
        setSnapshot(syncStore.getSnapshot());
        return syncStore.subscribe(setSnapshot);
      }, []);

      return snapshot;
    }

    // ── 样式（只注入一次，前缀 os- 避免污染） ───────────────────────────
    var CSS = [
      '.os-foot-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;',
      'border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;cursor:pointer;white-space:nowrap;}',
      '.os-foot-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));',
      'color:var(--dsw-alias-label-primary,#1f2328);}',
      '.os-foot-btn.os-only-ico{padding:0 7px;}',
      '.os-state-busy{border-color:var(--dsw-alias-state-warn-primary,#bf8700);',
      'color:var(--dsw-alias-state-warn-primary,#bf8700);}',
      '.os-state-ok{border-color:var(--dsw-alias-state-success-primary,#1a7f37);',
      'color:var(--dsw-alias-state-success-primary,#1a7f37);}',
      '.os-state-err{border-color:var(--dsw-alias-state-error-primary,#cf222e);',
      'color:var(--dsw-alias-state-error-primary,#cf222e);}',
      '.os-state-off{opacity:.65;}',
      '.os-ico{font-size:13px;line-height:1;display:inline-block;}',
      '.os-spin{animation:os-spin 1s linear infinite;}',
      '@keyframes os-spin{to{transform:rotate(360deg)}}',
      '.os-page{display:flex;flex-direction:column;gap:14px;padding:2px 0 24px;font-size:13px;',
      'color:var(--dsw-alias-label-primary,#1f2328);}',
      '.os-card{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));padding:12px 14px;}',
      '.os-card h3{margin:0 0 10px;font-size:13px;font-weight:600;',
      'color:var(--dsw-alias-label-primary,#1f2328);}',
      '.os-grid{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:12px;}',
      '.os-grid .k{color:var(--dsw-alias-label-secondary,#57606a);}',
      '.os-grid .v{color:var(--dsw-alias-label-primary,#1f2328);word-break:break-all;}',
      '.os-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;',
      'border-bottom:1px dashed var(--dsw-alias-border-l1,#d0d7de);}',
      '.os-row:last-child{border-bottom:0;}',
      '.os-row-text{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.os-row-text small{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:1.5;}',
      '.os-row-control{display:flex;align-items:center;gap:8px;flex:none;max-width:62%;}',
      '.os-input{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));',
      'border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:7px;',
      'color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;padding:5px 8px;',
      'min-width:210px;max-width:100%;outline:none;box-sizing:border-box;}',
      '.os-input:focus{border-color:var(--dsw-alias-brand-primary,#0969da);}',
      '.os-input.os-num{min-width:80px;width:100px;}',
      '.os-token-row{display:flex;align-items:center;gap:6px;width:100%;}',
      '.os-token-row .os-input{flex:1;}',
      '.os-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;',
      'border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:50%;flex:none;',
      'font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);cursor:help;}',
      '.os-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,#0969da);}',
      '.os-btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '.os-btn{border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));',
      'color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;padding:6px 12px;cursor:pointer;}',
      '.os-btn:hover{border-color:var(--dsw-alias-brand-primary,#0969da);}',
      '.os-btn.primary{background:var(--dsw-alias-brand-primary,#0969da);',
      'border-color:var(--dsw-alias-brand-primary,#0969da);color:#fff;}',
      '.os-btn.danger{color:var(--dsw-alias-state-error-primary,#cf222e);}',
      '.os-btn:disabled{opacity:.5;cursor:default;}',
      '.os-publish-panel{margin-top:10px;padding:10px;border:1px dashed var(--dsw-alias-border-l1,#d0d7de);',
      'border-radius:8px;display:flex;flex-direction:column;gap:8px;',
      'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));}',
      '.os-publish-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.os-publish-row .os-input{flex:1;min-width:180px;}',
      '.os-msg{font-size:12px;padding:7px 10px;border-radius:8px;white-space:pre-wrap;',
      'border:1px solid var(--dsw-alias-border-l1,#d0d7de);}',
      '.os-msg.ok{border-color:var(--dsw-alias-state-success-primary,#1a7f37);',
      'color:var(--dsw-alias-state-success-primary,#1a7f37);}',
      '.os-msg.err{border-color:var(--dsw-alias-state-error-primary,#cf222e);',
      'color:var(--dsw-alias-state-error-primary,#cf222e);}',
      '.os-msg.info{color:var(--dsw-alias-label-secondary,#57606a);}',
      '.os-progress{height:6px;border-radius:999px;overflow:hidden;margin-top:8px;',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));}',
      '.os-progress>i{display:block;height:100%;width:34%;border-radius:999px;',
      'background:var(--dsw-alias-brand-primary,#0969da);animation:os-migrate-bar 1.1s ease-in-out infinite;}',
      '@keyframes os-migrate-bar{0%{transform:translateX(-120%)}100%{transform:translateX(310%)}}',
      '.os-hint{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:1.6;}',
    ].join('');

    function installStyles() {
      if (typeof document === 'undefined') return function () {};
      if (document.querySelector('style[data-dsh-one-sync-css]') !== null) return function () {};
      var tag = document.createElement('style');
      tag.setAttribute('data-dsh-one-sync-css', '1');
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    // ── 侧栏「同步」按钮（sidebar.footer.action） ────────────────────────
    function buildTitle(snapshot, error, flash) {
      if (flash) return flash.text;
      if (error) return '同步不可用';
      if (!snapshot) return '同步加载中';
      var config = snapshot.config || {};
      var lines = ['同步'];
      lines.push('备份：' + (config.stateRepo ? '已配置' : '未配置'));
      lines.push('工作区：' + (config.codeDir ? '已配置' : '未配置'));
      lines.push('上次：' + fmtTime(snapshot.lastSyncAt));
      if (snapshot.lastError) lines.push('错误：' + snapshot.lastError);
      return lines.join('\n');
    }

    function SyncButton(props) {
      var wide = Boolean(props && props.wide);
      var storeState = useSyncStore();
      var flashState = useState(null);
      var flash = flashState[0];
      var setFlash = flashState[1];

      useEffect(function () {
        if (!flash) return undefined;
        var timer = setTimeout(function () { setFlash(null); }, 8000);
        return function () { clearTimeout(timer); };
      }, [flash]);

      var run = function () {
        if (storeState.syncing || (storeState.status && storeState.status.busy)) return;
        setFlash(null);
        syncStore.runSync().then(function (outcome) {
          setFlash({
            kind: outcome.ok ? 'ok' : 'err',
            text: outcome.text || (outcome.ok ? '同步完成' : '同步失败'),
          });
        });
      };

      var snapshot = storeState.status;
      var running = storeState.syncing || Boolean(snapshot && snapshot.busy);
      var state = running ? 'busy'
        : flash ? (flash.kind === 'ok' ? 'ok' : 'err')
          : (snapshot && !snapshot.configured) ? 'off'
            : (snapshot && snapshot.lastError) ? 'err' : '';

      return h('button', {
        type: 'button',
        className: 'os-foot-btn' + (wide ? '' : ' os-only-ico') + (state ? ' os-state-' + state : ''),
        title: buildTitle(snapshot, storeState.error, flash),
        onClick: run,
        disabled: running,
      },
        h('span', { className: 'os-ico' + (running ? ' os-spin' : ''), 'aria-hidden': 'true' }, '⟳'),
        wide ? h('span', null, running ? '同步中...' : '同步') : null,
      );
    }

    // ── 设置页（settings.section） ──────────────────────────────────────
    function Row(props) {
      return h('div', { className: 'os-row' },
        h('div', { className: 'os-row-text' },
          h('span', null, props.title),
          props.hint ? h('small', null, props.hint) : null),
        h('div', { className: 'os-row-control' }, props.children),
      );
    }

    function TextInput(props) {
      return h('input', {
        type: props.type || 'text',
        className: 'os-input' + (props.number ? ' os-num' : ''),
        value: props.value === undefined || props.value === null ? '' : props.value,
        placeholder: props.placeholder || '',
        spellCheck: false,
        autoComplete: props.autoComplete || 'off',
        autoFocus: props.autoFocus === true,
        min: props.min,
        max: props.max,
        step: props.step,
        onKeyDown: props.onKeyDown,
        onChange: function (event) { props.onChange(event.target.value); },
      });
    }

    function StatusCard(props) {
      var snapshot = props.status;
      var syncing = Boolean(props.syncing || (snapshot && snapshot.busy));
      if (!snapshot) {
        return h('div', { className: 'os-card' },
          h('h3', null, '同步状态'),
          h('div', { className: 'os-hint' }, syncing ? '同步中…' : '加载中…'));
      }
      var config = snapshot.config || {};
      var timingText = fmtTimings(snapshot.timings || (snapshot.lastReport && snapshot.lastReport.timings));
      var rows = [
        ['状态', syncing ? '同步中…' : '就绪'],
        ['加密备份', config.stateRepo ? '已配置' : '未配置'],
        ['工作区根目录', config.codeDir ? '已配置' : '未配置'],
        ['分支', snapshot.branch || 'main'],
        ['设备', snapshot.device || '-'],
        ['上次同步', fmtTime(snapshot.lastSyncAt)],
        ['加密', snapshot.hasKey ? '已就绪' : '待设置'],
      ];
      if (timingText) rows.push(['耗时', timingText]);
      if (snapshot.lastError) rows.push(['错误', snapshot.lastError]);

      return h('div', { className: 'os-card' },
        h('h3', null, '同步状态'),
        snapshot.configError
          ? h('div', { className: 'os-msg err', style: { marginBottom: '10px' } }, snapshot.configError)
          : null,
        h('div', { className: 'os-grid' }, rows.map(function (row) {
          return [
            h('span', { className: 'k', key: row[0] + '-k' }, row[0]),
            h('span', { className: 'v', key: row[0] + '-v' }, row[1]),
          ];
        }).reduce(function (all, pair) { return all.concat(pair); }, [])),
      );
    }

    function SettingsPage() {
      var storeState = useSyncStore();
      var st = storeState.status;
      var syncing = storeState.syncing || Boolean(st && st.busy);
      var formState = useState(null);
      var form = formState[0];
      var setForm = formState[1];
      var metaState = useState({ hasToken: false, tokenMasked: '', hasPassphrase: false });
      var meta = metaState[0];
      var setMeta = metaState[1];
      var msgState = useState(null);
      var msg = msgState[0];
      var setMsg = msgState[1];
      var busyState = useState('');
      var busy = busyState[0];
      var setBusy = busyState[1];
      var initializingState = useState(false);
      var initializing = initializingState[0];
      var setInitializing = initializingState[1];
      var loadedRef = useRef(false);
      var publishOpenState = useState(false);
      var publishOpen = publishOpenState[0];
      var setPublishOpen = publishOpenState[1];
      var publishNameState = useState('');
      var publishName = publishNameState[0];
      var setPublishName = publishNameState[1];
      var migrateOpenState = useState(false);
      var migrateOpen = migrateOpenState[0];
      var setMigrateOpen = migrateOpenState[1];
      var migrateRootState = useState('');
      var migrateRoot = migrateRootState[0];
      var setMigrateRoot = migrateRootState[1];
      var migrateRepoState = useState('');
      var migrateRepo = migrateRepoState[0];
      var setMigrateRepo = migrateRepoState[1];
      var migrateTokenState = useState('');
      var migrateToken = migrateTokenState[0];
      var setMigrateToken = migrateTokenState[1];

      var applyConfig = function (config, keepSecrets) {
        var cfg = config || {};
        setForm({
          codeDir: cfg.codeDir || '',
          codeRemote: cfg.codeRemote || '',
          stateRepo: cfg.stateRepo || '',
          branch: cfg.branch || 'main',
          deviceName: cfg.deviceName || '',
          maxFileMb: cfg.maxFileMb === undefined ? 45 : cfg.maxFileMb,
          rememberKey: cfg.rememberKey !== false,
          autoSync: cfg.autoSync === true,
          autoSyncDelaySec: cfg.autoSyncDelaySec === undefined ? 5 : cfg.autoSyncDelaySec,
          token: keepSecrets && form ? form.token : '',
          passphrase: keepSecrets && form ? form.passphrase : '',
        });
        setMeta({
          hasToken: Boolean(cfg.hasToken),
          tokenMasked: cfg.tokenMasked || '',
          hasPassphrase: Boolean(cfg.hasPassphrase),
        });
      };

      var loadConfig = function () {
        return apiGet('/config').then(function (result) {
          if (!result || result.ok === false) {
            throw new Error((result && result.error) || '读取配置失败');
          }
          applyConfig(result.config || {});
          if (result.warning) setMsg({ kind: 'info', text: result.warning });
          return result;
        });
      };

      useEffect(function () {
        if (loadedRef.current) return;
        loadedRef.current = true;
        loadConfig().catch(function (cause) {
          setMsg({ kind: 'err', text: '读取配置失败：' + errText(cause) });
        });
      }, []);

      var patch = function (key, value) {
        setForm(function (current) {
          var next = Object.assign({}, current || {});
          next[key] = value;
          return next;
        });
        setMsg(null);
      };

      var save = function () {
        if (!form || busy || syncing || initializing) return;
        setBusy('save');
        var payload = {
          codeDir: form.codeDir,
          codeRemote: form.codeRemote,
          stateRepo: form.stateRepo,
          branch: form.branch,
          deviceName: form.deviceName,
          maxFileMb: Number(form.maxFileMb) || 45,
          rememberKey: form.rememberKey !== false,
          autoSync: form.autoSync === true,
          autoSyncDelaySec: Number(form.autoSyncDelaySec) || 5,
        };
        if (form.token.trim()) payload.token = form.token.trim();
        if (form.passphrase !== '') payload.passphrase = form.passphrase;

        apiPost('/config', payload).then(function (result) {
          setBusy('');
          if (!result || result.ok === false) {
            if (result && result.saved) {
              setMsg({
                kind: 'err',
                text: result.error || '已保存本地，但校验失败',
              });
              syncStore.refresh();
              return;
            }
            throw new Error((result && result.error) || '保存失败');
          }
          applyConfig(result.config || {}, Boolean(result.warning));
          setMsg({
            kind: result.warning ? 'info' : 'ok',
            text: result.warning || '已保存',
          });
          syncStore.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '保存失败：' + errText(cause) });
        });
      };

      var initialize = function () {
        if (!form || busy || syncing || initializing) return;
        if (!form.passphrase && !meta.hasPassphrase) {
          setMsg({ kind: 'err', text: '请填写加密口令' });
          return;
        }
        if (!String(form.token || '').trim() && !meta.hasToken) {
          setMsg({ kind: 'err', text: '请先填写 Token' });
          return;
        }
        setInitializing(true);
        setMsg({ kind: 'info', text: '正在初始化…' });
        apiPost('/init', {
          codeDir: form.codeDir,
          codeRemote: form.codeRemote,
          stateRepo: form.stateRepo,
          token: form.token,
          passphrase: form.passphrase,
          branch: form.branch,
          deviceName: form.deviceName,
          maxFileMb: Number(form.maxFileMb) || 45,
          rememberKey: form.rememberKey !== false,
          autoSyncDelaySec: Number(form.autoSyncDelaySec) || 5,
        }).then(function (result) {
          if (!result || result.ok === false) {
            throw new Error((result && result.error) || '初始化失败');
          }
          applyConfig(result.config || {});
          setMsg({
            kind: 'ok',
            text: result.createdRepo ? '初始化完成，已创建备份仓库' : '初始化完成',
          });
          syncStore.refresh();
          setInitializing(false);
        }).catch(function (cause) {
          setInitializing(false);
          setMsg({ kind: 'err', text: '初始化失败：' + errText(cause) });
        });
      };

      var syncNow = function () {
        if (busy || syncing || initializing) return;
        setMsg({ kind: 'info', text: '同步中…' });
        syncStore.runSync().then(function (outcome) {
          setMsg({
            kind: outcome.ok ? 'ok' : 'err',
            text: outcome.text || (outcome.ok ? '同步完成' : '同步失败'),
          });
        });
      };

      var clearToken = function () {
        if (busy || syncing || initializing) return;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('清除已保存的 Token？')) return;
        }
        setBusy('token');
        apiPost('/config', { clearToken: true }).then(function (result) {
          setBusy('');
          if (!result || result.ok === false) {
            throw new Error((result && result.error) || '清除失败');
          }
          applyConfig(result.config || {});
          setMsg({ kind: 'ok', text: '已清除保存的 Token。' });
          syncStore.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '清除失败：' + errText(cause) });
        });
      };

      var openPublish = function () {
        if (!form || busy || syncing || initializing) return;
        setPublishName(suggestRepoName(form.codeDir));
        setPublishOpen(true);
        setMsg(null);
      };

      var publishToNewRepo = function () {
        if (!form || busy || syncing || initializing) return;
        var name = String(publishName || '').trim();
        if (!name) {
          setMsg({ kind: 'err', text: '仓库名不能为空' });
          return;
        }
        setBusy('publish');
        setMsg({ kind: 'info', text: '正在发布…' });
        apiPost('/publish', { repoName: name }).then(function (result) {
          setBusy('');
          if (!result || result.ok === false) {
            throw new Error((result && (result.error || result.text)) || '发布失败');
          }
          setPublishOpen(false);
          setPublishName('');
          setMsg({
            kind: 'ok',
            text: result.text || ('已发布到 ' + (result.htmlUrl || result.repoUrl || '') + '；加密备份未修改。'),
          });
          syncStore.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '发布失败：' + errText(cause) });
        });
      };

      var openMigrate = function () {
        if (!form || busy || syncing || initializing) return;
        setMigrateRoot(form.codeDir || '');
        setMigrateRepo('');
        setMigrateToken('');
        setMigrateOpen(true);
        setMsg(null);
      };

      var runMigrate = function () {
        if (!form || busy || syncing || initializing) return;
        var targetRoot = String(migrateRoot || form.codeDir || '').trim();
        if (!targetRoot) {
          setMsg({ kind: 'err', text: '工作区根目录不能为空' });
          return;
        }
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('收编旧工作区？')) return;
        }
        setBusy('migrate');
        setMsg({ kind: 'info', text: '正在收编旧工作区…' });
        var payload = { targetRoot: targetRoot };
        if (String(migrateRepo || '').trim()) payload.repoUrl = String(migrateRepo).trim();
        if (String(migrateToken || '').trim()) payload.token = String(migrateToken).trim();
        apiPost('/migrate', payload).then(function (result) {
          setBusy('');
          if (!result || result.ok === false) {
            throw new Error((result && (result.error || result.text)) || '迁移失败');
          }
          setMigrateOpen(false);
          setMigrateToken('');
          var codeDirChanged = form.codeDir !== targetRoot;
          if (codeDirChanged) {
            setForm(function (current) {
              var next = Object.assign({}, current || {});
              next.codeDir = targetRoot;
              return next;
            });
          }
          var moved = result.moved && result.moved.length ? result.moved.length : 0;
          setMsg({
            kind: 'ok',
            text: (result.text || '迁移完成')
              + (moved ? '（已收编 ' + moved + ' 个旧工作区）' : '')
              + (codeDirChanged ? ' 已填入工作区根目录' : ''),
          });
          syncStore.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '迁移失败：' + errText(cause) });
        });
      };

      if (!form) {
        return h('div', { className: 'os-page' },
          msg ? h('div', { className: 'os-msg ' + (msg.kind || 'info') }, msg.text) : null,
          h('div', { className: 'os-hint' }, '加载中…'),
        );
      }

      var v = function (key) { return form[key]; };
      var tokenPlaceholder = '粘贴你的 GitHub Token';
      var passphrasePlaceholder = '输入加密口令';

      return h('div', { className: 'os-page' },
        h(StatusCard, { status: st, syncing: syncing }),

        h('div', { className: 'os-card' },
          h('h3', null, '操作'),
          h('div', { className: 'os-btns' },
            h('button', {
              type: 'button',
              className: 'os-btn primary',
              onClick: initialize,
              disabled: initializing || syncing,
            }, initializing ? '初始化中' : '一键初始化'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: syncNow,
              disabled: syncing || initializing,
            }, syncing ? '同步中' : '同步'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: save,
              disabled: busy === 'save' || syncing || initializing,
            }, busy === 'save' ? '保存中' : '保存'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: function () { syncStore.refresh(); },
              disabled: syncing || initializing,
            }, '刷新'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: openPublish,
              disabled: busy === 'publish' || syncing || initializing,
            }, busy === 'publish' ? '发布中' : '发布'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: openMigrate,
              disabled: busy === 'migrate' || syncing || initializing,
            }, busy === 'migrate' ? '收编中' : '收编'),
            meta.hasToken ? h('button', {
              type: 'button',
              className: 'os-btn danger',
              onClick: clearToken,
              disabled: busy === 'token' || syncing || initializing,
            }, busy === 'token' ? '清除中' : '清除') : null,
          ),
          msg ? h('div', {
            className: 'os-msg ' + (msg.kind || 'info'),
            style: { marginTop: '10px' },
          }, msg.text) : null,
          publishOpen ? h('div', { className: 'os-publish-panel' },
            h('div', { className: 'os-hint' }, '发布到新的私有仓库'),
            h('div', { className: 'os-publish-row' },
              h(TextInput, {
                value: publishName,
                placeholder: '仓库名',
                autoFocus: true,
                onChange: function (value) { setPublishName(value); },
                onKeyDown: function (event) {
                  if (event && event.key === 'Enter') publishToNewRepo();
                },
              }),
              h('button', {
                type: 'button',
                className: 'os-btn primary',
                onClick: publishToNewRepo,
                disabled: busy === 'publish',
              }, busy === 'publish' ? '发布中' : '发布'),
              h('button', {
                type: 'button',
                className: 'os-btn',
                onClick: function () { setPublishOpen(false); },
                disabled: busy === 'publish',
              }, '取消'),
            ),
          ) : null,
          migrateOpen ? h('div', { className: 'os-publish-panel' },
            h('div', { className: 'os-hint' }, '导入旧工作区'),
            h('div', { className: 'os-publish-row' },
              h(TextInput, {
                value: migrateRoot,
                placeholder: '工作区根目录',
                autoFocus: true,
                onChange: function (value) { setMigrateRoot(value); },
              }),
            ),
            h('div', { className: 'os-publish-row' },
              h(TextInput, {
                value: migrateRepo,
                placeholder: '仓库地址（可选）',
                onChange: function (value) { setMigrateRepo(value); },
              }),
            ),
            h('div', { className: 'os-publish-row' },
              h(TextInput, {
                value: migrateToken,
                placeholder: 'GitHub Token',
                onChange: function (value) { setMigrateToken(value); },
              }),
              h('button', {
                type: 'button',
                className: 'os-btn primary',
                onClick: runMigrate,
                disabled: busy === 'migrate',
              }, busy === 'migrate' ? '收编中' : '收编'),
              h('button', {
                type: 'button',
                className: 'os-btn',
                onClick: function () { setMigrateOpen(false); },
                disabled: busy === 'migrate',
              }, '取消'),
            ),
            busy === 'migrate' ? h('div', { className: 'os-progress' }, h('i')) : null,
          ) : null,
        ),

        h('div', { className: 'os-card' },
          h('h3', null, '工作区与备份'),
          h(Row, {
            title: '工作区根目录',
            hint: '本地大仓的绝对路径',
          }, h(TextInput, {
            value: v('codeDir'),
            placeholder: 'D:\\项目\\仓库',
            onChange: function (value) { return patch('codeDir', value); },
          })),
          h(Row, {
            title: '代码仓库地址',
            hint: '留空使用本地仓库',
          }, h(TextInput, {
            value: v('codeRemote'),
            placeholder: 'https://github.com/<用户名>/<仓库名>.git',
            onChange: function (value) { return patch('codeRemote', value); },
          })),
          h(Row, {
            title: '加密备份仓库',
            hint: '填入你的私有 GitHub 仓库地址',
          }, h(TextInput, {
            value: v('stateRepo'),
            placeholder: 'https://github.com/<用户名>/<仓库名>.git',
            onChange: function (value) { return patch('stateRepo', value); },
          })),
          h(Row, {
            title: '分支',
            hint: '代码和备份使用的分支，通常为 main',
          }, h(TextInput, {
            value: v('branch'),
            placeholder: 'main',
            onChange: function (value) { return patch('branch', value); },
          })),
          h(Row, {
            title: '设备名称',
            hint: '留空自动使用主机名',
          }, h(TextInput, {
            value: v('deviceName'),
            placeholder: '自动',
            onChange: function (value) { return patch('deviceName', value); },
          })),
          h(Row, {
            title: '单文件上限（MB）',
            hint: '超过上限的文件会跳过',
          }, h(TextInput, {
            number: true,
            type: 'number',
            min: 1,
            max: 200,
            value: v('maxFileMb'),
            onChange: function (value) { return patch('maxFileMb', value === '' ? '' : Number(value)); },
          })),
          h(Row, {
            title: 'GitHub Token',
            hint: '需要仓库读写权限',
          }, h('div', { className: 'os-token-row' },
            h(TextInput, {
              type: 'password',
              value: v('token'),
              placeholder: tokenPlaceholder,
              autoComplete: 'new-password',
              onChange: function (value) { return patch('token', value); },
            }),
            h('span', {
              className: 'os-help',
              title: '生成 Fine-grained Token，勾选 Contents 和 Administration（读写）',
              'aria-label': 'Token 帮助',
            }, '?'),
          )),
          h(Row, {
            title: '记住加密密钥',
            hint: '开启后在本机缓存密钥',
          }, h('input', {
            type: 'checkbox',
            className: 'os-check',
            checked: v('rememberKey') !== false,
            onChange: function (event) { return patch('rememberKey', event.target.checked); },
          })),
        ),

        h('div', { className: 'os-card' },
          h('h3', null, '自动同步'),
          h(Row, {
            title: '每轮结束后自动同步',
            hint: '每轮对话结束后触发',
          }, h('input', {
            type: 'checkbox',
            className: 'os-check',
            checked: v('autoSync') === true,
            onChange: function (event) { return patch('autoSync', event.target.checked); },
          })),
          h(Row, {
            title: '延迟（秒）',
            hint: '自动同步等待时间',
          }, h(TextInput, {
            number: true,
            type: 'number',
            min: 2,
            max: 60,
            value: v('autoSyncDelaySec'),
            onChange: function (value) {
              return patch('autoSyncDelaySec', value === '' ? '' : Number(value));
            },
          })),
        ),

        h('div', { className: 'os-card' },
          h('h3', null, '加密'),
          h(Row, {
            title: '加密口令',
            hint: '两台电脑必须一致',
          }, h(TextInput, {
            type: 'password',
            value: v('passphrase'),
            placeholder: passphrasePlaceholder,
            autoComplete: 'new-password',
            onChange: function (value) { return patch('passphrase', value); },
          })),
        ),

      );
    }

    // ── 插件装载 ────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-one-sync: styles');

      ctx.effect(function () {
        syncStore.start();
        return function () { syncStore.stop(); };
      }, 'dsh-one-sync: shared status store');

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-one-sync',
            order: 5,
            label: function () { return '同步'; },
          }, function (props) { return h(SyncButton, props); });
        });
      }, 'dsh-one-sync: sidebar button');

      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-one-sync',
            order: 37,
            label: function () { return '同步'; },
          }, function (props) { return h(SettingsPage, props); });
        });
      }, 'dsh-one-sync: settings section');
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.SyncButton = SyncButton;
    exports.SettingsPage = SettingsPage;

    return module.exports;
  },
});

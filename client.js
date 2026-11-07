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
 *   POST /dsh-one-sync/api/sync     一键同步
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
    var useCallback = React.useCallback;

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

    /** 状态轮询：侧栏按钮和设置页共用。 */
    function useStatus(pollMs) {
      var statusState = useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];
      var errorState = useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var refresh = useCallback(function () {
        return apiGet('/status').then(function (snapshot) {
          setStatus(snapshot);
          setError(null);
          return snapshot;
        }).catch(function (cause) {
          setError(errText(cause));
          return null;
        });
      }, []);

      useEffect(function () {
        refresh();
        if (!pollMs) return undefined;
        var timer = setInterval(refresh, pollMs);
        return function () { clearInterval(timer); };
      }, [refresh, pollMs]);

      return { status: status, error: error, refresh: refresh };
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
      '.os-pre{margin:0;max-height:240px;overflow:auto;font-size:11px;line-height:1.6;',
      'color:var(--dsw-alias-label-secondary,#57606a);white-space:pre-wrap;word-break:break-all;}',
      '.os-hint{color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:1.6;}',
      '.os-list{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.8;',
      'color:var(--dsw-alias-label-secondary,#57606a);}',
      'details.os-details>summary{cursor:pointer;font-size:12px;',
      'color:var(--dsw-alias-label-secondary,#57606a);}',
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

    // ── 侧栏「一键同步」按钮（sidebar.footer.action） ────────────────────
    function buildTitle(snapshot, error, flash) {
      if (flash) return flash.text;
      if (error) return '一键同步：状态读取失败（' + error + '）';
      if (!snapshot) return '一键同步：正在读取状态…';
      var config = snapshot.config || {};
      var lines = [];
      lines.push('一键同步（点击执行：拉取代码 → 拉取状态 → 推送代码 → 上传状态）');
      lines.push('状态仓库：' + (config.stateRepo || '未配置'));
      lines.push('代码目录：' + (config.codeDir || '未配置（只同步 DSH 状态）'));
      lines.push('最近同步：' + fmtTime(snapshot.lastSyncAt));
      if (!snapshot.configured) lines.push('尚未完成配置：请在「设置 → 一键同步」里填写');
      if (snapshot.lastError) lines.push('最近错误：' + snapshot.lastError);
      return lines.join('\n');
    }

    function SyncButton(props) {
      var wide = Boolean(props && props.wide);
      var st = useStatus(30000);
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var flashState = useState(null);
      var flash = flashState[0];
      var setFlash = flashState[1];

      useEffect(function () {
        if (!flash) return undefined;
        var timer = setTimeout(function () { setFlash(null); }, 8000);
        return function () { clearTimeout(timer); };
      }, [flash]);

      var run = function () {
        if (busy) return;
        setBusy(true);
        setFlash(null);
        apiPost('/sync', {}).then(function (result) {
          setBusy(false);
          setFlash({
            kind: result && result.ok ? 'ok' : 'err',
            text: (result && (result.text || result.error)) || '同步完成',
          });
          st.refresh();
        }).catch(function (cause) {
          setBusy(false);
          setFlash({ kind: 'err', text: '一键同步失败：' + errText(cause) });
        });
      };

      var snapshot = st.status;
      var running = busy || Boolean(snapshot && snapshot.busy);
      var state = running ? 'busy'
        : flash ? (flash.kind === 'ok' ? 'ok' : 'err')
          : (snapshot && !snapshot.configured) ? 'off'
            : (snapshot && snapshot.lastError) ? 'err' : '';

      return h('button', {
        type: 'button',
        className: 'os-foot-btn' + (wide ? '' : ' os-only-ico') + (state ? ' os-state-' + state : ''),
        title: buildTitle(snapshot, st.error, flash),
        onClick: run,
        disabled: running,
      },
        h('span', { className: 'os-ico' + (running ? ' os-spin' : ''), 'aria-hidden': 'true' }, '⟳'),
        wide ? h('span', null, '一键同步') : null,
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
      if (!snapshot) {
        return h('div', { className: 'os-card' },
          h('h3', null, '同步状态'),
          h('div', { className: 'os-hint' }, '正在读取…'));
      }
      var config = snapshot.config || {};
      var rows = [
        ['配置', snapshot.configured ? '已配置' : '未完成（需要 stateRepo + token）'],
        ['状态仓库', config.stateRepo || '未配置'],
        ['代码目录', config.codeDir || '未配置（只同步 DSH 状态）'],
        ['分支', snapshot.branch || 'main'],
        ['本机设备', snapshot.device || '-'],
        ['最近同步', fmtTime(snapshot.lastSyncAt)],
        ['密钥', snapshot.hasKey ? '已就绪' : '尚未生成（首次同步需要口令）'],
        ['状态目录', snapshot.stateDir || '-'],
        ['配置文件', snapshot.configPath || '-'],
      ];
      if (snapshot.lastError) rows.push(['最近错误', snapshot.lastError]);

      var report = snapshot.lastReport;
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
        report
          ? h('details', { className: 'os-details', style: { marginTop: '10px' } },
            h('summary', null, '最近一次同步详情'),
            h('pre', { className: 'os-pre', style: { marginTop: '6px' } },
              JSON.stringify(report, null, 2)))
          : null,
      );
    }

    function SettingsPage() {
      var st = useStatus(20000);
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
      var loadedRef = useRef(false);
      var publishOpenState = useState(false);
      var publishOpen = publishOpenState[0];
      var setPublishOpen = publishOpenState[1];
      var publishNameState = useState('');
      var publishName = publishNameState[0];
      var setPublishName = publishNameState[1];

      var applyConfig = function (config) {
        var cfg = config || {};
        setForm({
          codeDir: cfg.codeDir || '',
          stateRepo: cfg.stateRepo || '',
          branch: cfg.branch || 'main',
          deviceName: cfg.deviceName || '',
          maxFileMb: cfg.maxFileMb === undefined ? 45 : cfg.maxFileMb,
          rememberKey: cfg.rememberKey !== false,
          token: '',
          passphrase: '',
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
        if (!form || busy) return;
        setBusy('save');
        var payload = {
          codeDir: form.codeDir,
          stateRepo: form.stateRepo,
          branch: form.branch,
          deviceName: form.deviceName,
          maxFileMb: Number(form.maxFileMb) || 45,
          rememberKey: form.rememberKey !== false,
        };
        if (form.token.trim()) payload.token = form.token.trim();
        if (form.passphrase !== '') payload.passphrase = form.passphrase;

        apiPost('/config', payload).then(function (result) {
          setBusy('');
          if (!result || result.ok === false) {
            throw new Error((result && result.error) || '保存失败');
          }
          applyConfig(result.config || {});
          setMsg({
            kind: result.warning ? 'info' : 'ok',
            text: result.warning || '设置已保存，并立即生效。',
          });
          st.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '保存失败：' + errText(cause) });
        });
      };

      var syncNow = function () {
        if (busy) return;
        setBusy('sync');
        setMsg({ kind: 'info', text: '正在同步…（代码 → 状态 → 代码 → 状态）' });
        apiPost('/sync', {}).then(function (result) {
          setBusy('');
          setMsg({
            kind: result && result.ok ? 'ok' : 'err',
            text: (result && (result.text || result.error)) || '同步完成',
          });
          st.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '同步失败：' + errText(cause) });
        });
      };

      var clearToken = function () {
        if (busy) return;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('确定清除已保存的 GitHub Token 吗？清除后状态同步会停止，直到重新填写。')) return;
        }
        setBusy('token');
        apiPost('/config', { clearToken: true }).then(function (result) {
          setBusy('');
          if (!result || result.ok === false) {
            throw new Error((result && result.error) || '清除失败');
          }
          applyConfig(result.config || {});
          setMsg({ kind: 'ok', text: '已清除保存的 Token。' });
          st.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '清除失败：' + errText(cause) });
        });
      };

      var openPublish = function () {
        if (!form || busy) return;
        setPublishName(suggestRepoName(form.codeDir));
        setPublishOpen(true);
        setMsg(null);
      };

      var publishToNewRepo = function () {
        if (!form || busy) return;
        var name = String(publishName || '').trim();
        if (!name) {
          setMsg({ kind: 'err', text: '请输入新仓库名称。' });
          return;
        }
        setBusy('publish');
        setMsg({ kind: 'info', text: '正在创建 GitHub 仓库并推送 Initial commit…' });
        apiPost('/publish', { repoName: name }).then(function (result) {
          setBusy('');
          if (!result || result.ok === false) {
            throw new Error((result && (result.error || result.text)) || '发布失败');
          }
          setPublishOpen(false);
          setPublishName('');
          setMsg({
            kind: 'ok',
            text: result.text || ('已发布到 ' + (result.htmlUrl || result.repoUrl || '') + '；stateRepo 未修改。'),
          });
          st.refresh();
        }).catch(function (cause) {
          setBusy('');
          setMsg({ kind: 'err', text: '发布失败：' + errText(cause) });
        });
      };

      if (!form) {
        return h('div', { className: 'os-page' },
          msg ? h('div', { className: 'os-msg ' + (msg.kind || 'info') }, msg.text) : null,
          h('div', { className: 'os-hint' }, '正在读取一键同步设置…'),
        );
      }

      var v = function (key) { return form[key]; };
      var tokenPlaceholder = meta.hasToken
        ? '已保存（' + meta.tokenMasked + '），留空保持不变'
        : 'github_pat_…（状态仓库 Contents 读写）';
      var passphrasePlaceholder = meta.hasPassphrase
        ? '已保存，留空保持不变'
        : '首次同步必填；两台电脑必须一致';

      return h('div', { className: 'os-page' },
        h(StatusCard, { status: st.status }),

        h('div', { className: 'os-card' },
          h('h3', null, '操作'),
          h('div', { className: 'os-btns' },
            h('button', {
              type: 'button',
              className: 'os-btn primary',
              onClick: syncNow,
              disabled: busy === 'sync',
            }, busy === 'sync' ? '同步中…' : '立即一键同步'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: save,
              disabled: busy === 'save',
            }, busy === 'save' ? '保存中…' : '保存设置'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: function () { st.refresh(); },
            }, '刷新状态'),
            h('button', {
              type: 'button',
              className: 'os-btn',
              onClick: openPublish,
              disabled: busy === 'publish',
            }, busy === 'publish' ? '发布中…' : '发布当前工作区为新库'),
            meta.hasToken ? h('button', {
              type: 'button',
              className: 'os-btn danger',
              onClick: clearToken,
              disabled: busy === 'token',
            }, busy === 'token' ? '清除中…' : '清除 Token') : null,
          ),
          msg ? h('div', {
            className: 'os-msg ' + (msg.kind || 'info'),
            style: { marginTop: '10px' },
          }, msg.text) : null,
          publishOpen ? h('div', { className: 'os-publish-panel' },
            h('div', { className: 'os-hint' },
              '把当前代码目录初始化为新 Git 仓库，创建为 GitHub 私密仓库，并完成 Initial commit。' +
              '已有 .git 的目录会被拒绝；发布只推送代码，不会修改 stateRepo。' +
              '发布使用已保存的配置，修改上方字段后请先点「保存设置」。'),
            h('div', { className: 'os-publish-row' },
              h(TextInput, {
                value: publishName,
                placeholder: '新仓库名称，例如 my-project',
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
              }, busy === 'publish' ? '发布中…' : '确认发布'),
              h('button', {
                type: 'button',
                className: 'os-btn',
                onClick: function () { setPublishOpen(false); },
                disabled: busy === 'publish',
              }, '取消'),
            ),
            h('div', { className: 'os-hint' },
              'Token 需要创建仓库的权限：classic PAT 用 repo；fine-grained PAT 需要账号级 Repository creation / Administration write。' +
              '仓库名会被规范成 GitHub 可用的 slug。'),
          ) : null,
        ),

        h('div', { className: 'os-card' },
          h('h3', null, '代码与仓库'),
          h(Row, {
            title: '代码目录',
            hint: '当前工作区绝对路径；插件会自动向上寻找 .git 根目录，并以根目录为单位 pull/push。留空 = 只同步 DSH 状态。',
          }, h(TextInput, {
            value: v('codeDir'),
            placeholder: 'D:\\path\\to\\project',
            onChange: function (value) { return patch('codeDir', value); },
          })),
          h(Row, {
            title: 'DSH 状态仓库',
            hint: '只存 DSH 状态（sessions/storages/memories），与代码仓库完全分离。代码同步使用代码目录自己的 Git 根目录和 origin。',
          }, h(TextInput, {
            value: v('stateRepo'),
            placeholder: 'https://github.com/<用户名>/<状态仓库>.git',
            onChange: function (value) { return patch('stateRepo', value); },
          })),
          h(Row, {
            title: '分支',
            hint: '代码和状态共用；Git 根目录必须已检出这个分支，默认 main。',
          }, h(TextInput, {
            value: v('branch'),
            placeholder: 'main',
            onChange: function (value) { return patch('branch', value); },
          })),
          h(Row, {
            title: '设备名',
            hint: '两台电脑应不同；留空使用主机名。',
          }, h(TextInput, {
            value: v('deviceName'),
            placeholder: '自动',
            onChange: function (value) { return patch('deviceName', value); },
          })),
          h(Row, {
            title: '单文件上限（MB）',
            hint: '超过上限的会话日志会被跳过（保留远端旧副本）。',
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
            hint: 'fine-grained PAT：状态仓库 Contents 读写；classic PAT：repo。代码仓库走 HTTPS 时也用它认证。只保存在本机配置，不会上传。',
          }, h(TextInput, {
            type: 'password',
            value: v('token'),
            placeholder: tokenPlaceholder,
            autoComplete: 'new-password',
            onChange: function (value) { return patch('token', value); },
          })),
          h(Row, {
            title: '记住主密钥',
            hint: '开启后把主密钥缓存到本机（~/.dsh/one-sync/key），避免每次同步都跑 scrypt。',
          }, h('input', {
            type: 'checkbox',
            className: 'os-check',
            checked: v('rememberKey') !== false,
            onChange: function (event) { return patch('rememberKey', event.target.checked); },
          })),
        ),

        h('div', { className: 'os-card' },
          h('h3', null, '同步口令'),
          h('div', { className: 'os-hint', style: { marginBottom: '8px' } },
            '两台电脑必须输入同一口令。它只在本机用于生成/解开 key.enc；上传的状态文件全部是 AES-256-GCM 密文。' +
            '第一次同步会用口令生成 key.enc，之后留空即可继续使用已保存的口令。'),
          h(Row, {
            title: '口令',
            hint: '修改口令不会自动重加密远端密钥；如需更换，必须两台电脑一起重置 key.enc。',
          }, h(TextInput, {
            type: 'password',
            value: v('passphrase'),
            placeholder: passphrasePlaceholder,
            autoComplete: 'new-password',
            onChange: function (value) { return patch('passphrase', value); },
          })),
        ),

        h('div', { className: 'os-card' },
          h('h3', null, '同步范围与安全'),
          h('ul', { className: 'os-list' },
            h('li', null, '自动加密同步：~/.dsh/sessions、~/.dsh/storages、~/.dsh/memories。'),
            h('li', null, 'Profile 配置：~/.dsh/profiles/<profile>/package.json、cordis.patch.yml，以及 ~/.dsh/settings.yaml。'),
            h('li', null, 'workspace.json 的 path 会在 gitRoot 相对路径与本机绝对路径之间自动转换。'),
            h('li', null, '加密：AES-256-GCM，确定性 IV；内容没变的文件不会产生新提交。'),
            h('li', null, '冲突：会话双方都改且本机较新时保留本机，远端版本另存为 *.remote.jsonl.zstd。'),
            h('li', null, '代码同步：自动提交未提交改动 → pull →（状态同步）→ push；冲突会中止合并，不强推。'),
            h('li', null, '状态传输统一走 lib/rest.js 的 Git Data API。'),
          ),
          h('div', { className: 'os-hint', style: { marginTop: '8px' } },
            '配置文件：' + ((st.status && st.status.configPath) || '~/.dsh/one-sync.json') +
            '；Token 与口令均为本机明文保存，请确保本机账户安全。'),
        ),
      );
    }

    // ── 插件装载 ────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-one-sync: styles');

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-one-sync',
            order: 5,
            label: function () { return '一键同步'; },
          }, function (props) { return h(SyncButton, props); });
        });
      }, 'dsh-one-sync: sidebar button');

      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-one-sync',
            order: 37,
            label: function () { return '一键同步'; },
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

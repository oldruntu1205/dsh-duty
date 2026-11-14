/**
 * dsh-duty — browser half（客户端半边）：右侧栏「值班」面板
 *
 * 格式（硬约束，别改成 ESM）：DSH 的客户端模块系统是「Lazy CJS 表」，
 * bundle 执行时只注册 factory，宿主不做任何转换 —— 所以这里不能用 import/export，
 * 必须写成 window.__ModuleLoader__.load({ id, factory }) 的形式（与
 * dsh-completion-notify、dsh-better-sidebar 的 lib/client.js 同构）。
 *
 * 面板只做三件事：
 *   1. 显示宿主 /duty/api/state 给的快照（模式、计数、允许名单、工单列表）
 *   2. 让**人**做三个动作：切 observe/act、轮询 GitHub、投递一件事、关单
 *   3. 出错时说清是「连不上宿主」还是「宿主拒绝了这次动作」
 *
 * 不做的：派工（duty_work 需要一个会话，面板没有），以及任何自动动作。
 */

window.__ModuleLoader__.load({
  id: 'dsh-duty',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var h = react.createElement;

    /** tab 类型的身份：type id 与正文 key 必须一致（sidebar 用它把 body 挂到 tab 上）。 */
    var PANEL_ID = 'dsh-duty/panel';
    var PANEL_KIND = 'duty';
    /** 面板轮询间隔：值班状态是低频数据，10s 足够，且不在后台标签页里空转。 */
    var POLL_MS = 10000;

    // ── 与宿主通信 ─────────────────────────────────────────

    /**
     * 把路由解析到**页面自己的目录**下，而不是 origin 根：
     * 反代目录（https://host/prefix/）与桌面端 app://app/ 都靠这一点才能打到宿主。
     */
    function apiUrl(path) {
      var base = (typeof document !== 'undefined' && document.baseURI) || 'http://dsh.internal/';
      var url;
      try {
        url = new URL(base);
      } catch (error) {
        url = new URL('http://dsh.internal/');
      }
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return new URL(String(path).replace(/^\/+/, ''), url.href).href;
    }

    /** 读快照。非 2xx 或信封不合法都抛，由调用方转成可见的错误条。 */
    function fetchState() {
      return fetch(apiUrl('duty/api/state'), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then(function (response) {
        return response.text().then(function (body) {
          var parsed;
          try {
            parsed = JSON.parse(body);
          } catch (error) {
            throw new Error('宿主返回的不是 JSON（HTTP ' + response.status + '）');
          }
          if (!response.ok || !parsed || parsed.ok !== true || !parsed.snapshot) {
            throw new Error((parsed && (parsed.message || parsed.error)) || 'HTTP ' + response.status);
          }
          return parsed.snapshot;
        });
      });
    }

    /** 执行一个动作。宿主把失败包在 { ok:false, code, message } 里；网络错误单独说。 */
    function postAction(action, payload) {
      return fetch(apiUrl('duty/api/action'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: action, payload: payload || {} }),
      })
        .then(function (response) {
          return response.text().then(function (body) {
            var parsed;
            try {
              parsed = JSON.parse(body);
            } catch (error) {
              throw new Error('宿主返回的不是 JSON（HTTP ' + response.status + '）');
            }
            if (!response.ok || !parsed || parsed.ok !== true) {
              var failure = new Error((parsed && parsed.message) || 'HTTP ' + response.status);
              failure.code = (parsed && parsed.code) || 'http-' + response.status;
              throw failure;
            }
            return parsed;
          });
        })
        .catch(function (error) {
          if (error && error.code) throw error;
          throw new Error(
            '连不上宿主：' + (error && error.message ? error.message : String(error)) +
              '（插件升级后需要托盘退出 DSH 再打开）',
          );
        });
    }

    // ── 展示用的小工具 ──────────────────────────────────────

    var MUTED = 'rgba(127,127,127,1)';
    var HAIRLINE = '1px solid rgba(127,127,127,0.25)';
    var SOFT = 'rgba(127,127,127,0.12)';

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** 相对时间：面板里「多久之前」比绝对时间戳有用。 */
    function ago(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
      if (ms < 60000) return Math.round(ms / 1000) + ' 秒前';
      if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟前';
      if (ms < 86400000) return Math.round(ms / 3600000) + ' 小时前';
      return Math.round(ms / 86400000) + ' 天前';
    }

    function clock(at) {
      if (typeof at !== 'number' || at <= 0) return '—';
      var d = new Date(at);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function shortId(id) {
      var text = String(id || '');
      return text.length > 12 ? text.slice(0, 9) + '…' : text;
    }

    function chip(label, tone) {
      var palette = {
        act: ['rgba(46,160,67,0.16)', 'rgba(46,160,67,0.55)'],
        observe: ['rgba(127,127,127,0.14)', 'rgba(127,127,127,0.35)'],
        ready: ['rgba(56,132,255,0.16)', 'rgba(56,132,255,0.5)'],
        running: ['rgba(255,163,0,0.16)', 'rgba(255,163,0,0.5)'],
        observed: ['rgba(127,127,127,0.14)', 'rgba(127,127,127,0.32)'],
        ended: ['rgba(127,127,127,0.1)', 'rgba(127,127,127,0.22)'],
        warn: ['rgba(255,163,0,0.16)', 'rgba(255,163,0,0.5)'],
      };
      var colors = palette[tone] || palette.observe;
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '1px 7px',
            borderRadius: '999px',
            fontSize: '11px',
            lineHeight: '16px',
            whiteSpace: 'nowrap',
            background: colors[0],
            border: '1px solid ' + colors[1],
          },
        },
        label,
      );
    }

    function button(label, onClick, options) {
      var opts = options || {};
      return h(
        'button',
        {
          type: 'button',
          onClick: onClick,
          disabled: opts.disabled === true,
          title: opts.title,
          style: {
            appearance: 'none',
            cursor: opts.disabled ? 'default' : 'pointer',
            opacity: opts.disabled ? 0.5 : 1,
            fontSize: '11.5px',
            lineHeight: '18px',
            padding: '2px 9px',
            borderRadius: '7px',
            color: 'inherit',
            background: opts.primary ? 'rgba(56,132,255,0.16)' : SOFT,
            border: opts.primary ? '1px solid rgba(56,132,255,0.5)' : HAIRLINE,
            whiteSpace: 'nowrap',
          },
        },
        label,
      );
    }

    function stat(label, value, tone) {
      return h(
        'div',
        { key: label, style: { display: 'flex', alignItems: 'baseline', gap: '4px' } },
        h('span', { style: { fontSize: '14px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, String(value)),
        h('span', { style: { fontSize: '11px', color: tone || MUTED } }, label),
      );
    }

    function sectionTitle(text, right) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: '4px',
            fontSize: '11px',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: MUTED,
          },
        },
        h('span', null, text),
        h('span', { style: { flex: 1 } }),
        right || null,
      );
    }

    function emptyLine(text) {
      return h(
        'div',
        { style: { fontSize: '11.5px', color: MUTED, padding: '6px 2px' } },
        text,
      );
    }

    function ticketCard(ticket, handlers) {
      var running = ticket.running;
      var tone = running ? 'running' : ticket.dispatch === 'ready' ? 'ready' : ticket.dispatch === 'observed' ? 'observed' : 'ended';
      var label = ticket.state === 'ended' ? '已结' : running ? '在跑' : ticket.dispatch === 'ready' ? '可派' : '仅记录';
      var canClose = ticket.state !== 'ended';
      return h(
        'div',
        {
          key: ticket.id,
          style: {
            border: HAIRLINE,
            borderRadius: '9px',
            padding: '8px 9px',
            display: 'flex',
            flexDirection: 'column',
            gap: '5px',
            background: 'rgba(127,127,127,0.05)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          chip(label, tone),
          h(
            'span',
            {
              title: ticket.id,
              style: {
                flex: 1,
                fontSize: '12px',
                fontWeight: 550,
                lineHeight: '16px',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              },
            },
            ticket.title || '(无标题)',
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', fontSize: '10.5px', color: MUTED, flexWrap: 'wrap' } },
          h('span', null, (ticket.source || '?') + ' · ' + (ticket.actor || '?')),
          h('span', null, shortId(ticket.id)),
          h('span', null, ticket.state === 'ended' ? '结束于 ' + clock(ticket.endedAt) + ' · ' + (ticket.endedReason || '—') : ago(ticket.ageMs)),
          running && running.executorId ? h('span', null, '执行器 ' + shortId(running.childId || running.executorId)) : null,
        ),
        canClose
          ? h(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              button('关闭', function () { handlers.close(ticket.id, 'done'); }, { title: '标记为完成并关单' }),
              button('丢弃', function () { handlers.close(ticket.id, 'dropped'); }, { title: '不做了，丢弃这张单' }),
            )
          : null,
      );
    }

    // ── 面板正文 ───────────────────────────────────────────

    /**
     * 值班面板。
     *
     * 首屏用 `initialSnapshot`（预览/SSR 用），运行时为 undefined →
     * 挂载后立刻读一次，然后每 POLL_MS 读一次（后台标签页不读）。
     */
    function DutyPanel(props) {
      var options = props || {};
      var first = options.initialSnapshot || null;

      var snapshotState = react.useState(first);
      var snapshot = snapshotState[0];
      var setSnapshot = snapshotState[1];

      var busyState = react.useState(null);
      var busy = busyState[0];
      var setBusy = busyState[1];
      /** 定时器闭包读不到最新 busy；用 ref 记住，动作期间不让轮询覆盖结果。 */
      var busyRef = react.useRef(null);
      busyRef.current = busy;

      var errorState = react.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var flashState = react.useState(null);
      var flash = flashState[0];
      var setFlash = flashState[1];

      var draftState = react.useState('');
      var draft = draftState[0];
      var setDraft = draftState[1];

      var endedState = react.useState(false);
      var showEnded = endedState[0];
      var setShowEnded = endedState[1];

      var aliveRef = react.useRef(true);
      react.useEffect(function () {
        aliveRef.current = true;
        return function () {
          aliveRef.current = false;
        };
      }, []);

      var load = react.useCallback(function () {
        return fetchState()
          .then(function (next) {
            if (!aliveRef.current) return;
            setSnapshot(next);
            setError(null);
          })
          .catch(function (failure) {
            if (!aliveRef.current) return;
            setError(failure && failure.message ? failure.message : String(failure));
          });
      }, []);

      react.useEffect(
        function () {
          if (!options.initialSnapshot) load();
          var timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.hidden === true) return;
            if (busyRef.current) return;
            load();
          }, POLL_MS);
          return function () {
            clearInterval(timer);
          };
        },
        [load, options.initialSnapshot],
      );

      // 定时器闭包读不到最新 busy，用 ref 兜住，避免动作期间被轮询覆盖。
      var run = react.useCallback(
        function (name, work) {
          setBusy(name);
          setError(null);
          return work()
            .then(function (result) {
              if (!aliveRef.current) return result;
              if (result && result.snapshot) setSnapshot(result.snapshot);
              if (result && result.message) setFlash(result.message);
              return result;
            })
            .catch(function (failure) {
              if (!aliveRef.current) return undefined;
              setError(failure && failure.message ? failure.message : String(failure));
              return undefined;
            })
            .then(function (result) {
              if (aliveRef.current) setBusy(null);
              return result;
            });
        },
        [],
      );

      var handlers = {
        close: function (ticketId, outcome) {
          run('report', function () {
            return postAction('report', { ticketId: ticketId, outcome: outcome });
          });
        },
      };

      if (!snapshot) {
        return h(
          'div',
          { style: { padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px' } },
          error
            ? h(
                'div',
                { style: { color: '#d9534f', lineHeight: '18px' } },
                error,
              )
            : h('div', { style: { color: MUTED } }, '正在读取值班状态…'),
          h('div', null, button('重试', function () { run('state', load); })),
        );
      }

      var counts = snapshot.counts || {};
      var github = snapshot.github || {};
      var inbox = (snapshot.allowed || []).find(function (source) { return source.id === 'inbox'; });
      var githubSource = (snapshot.allowed || []).find(function (source) { return source.id === 'github'; });
      var openTickets = (snapshot.tickets || []).filter(function (t) { return t.state !== 'ended'; });
      var endedTickets = (snapshot.tickets || []).filter(function (t) { return t.state === 'ended'; });
      // needsPerson 区块已经把「仅记录」的单列过了，开放工单列表别再重复列一遍。
      var hasNeedsPerson = (snapshot.needsPerson || []).length > 0;
      var listedOpen = hasNeedsPerson
        ? openTickets.filter(function (ticket) { return ticket.dispatch !== 'observed'; })
        : openTickets;
      var inboxAllowed = ((inbox && inbox.allowed) || []).map(function (entry) {
        return typeof entry === 'string' ? entry : entry && entry.id;
      }).filter(Boolean);
      var githubAllowed = (github.allowed || []).filter(Boolean);

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '9px',
            padding: '12px 12px 20px',
            fontSize: '12px',
            lineHeight: '18px',
            color: 'inherit',
            height: '100%',
            overflowY: 'auto',
            boxSizing: 'border-box',
          },
        },
        // 头部：标题 + 模式 + 刷新
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('div', { style: { fontSize: '13px', fontWeight: 650 } }, '值班'),
          chip(snapshot.mode === 'act' ? 'act · 可派工' : 'observe · 只记录', snapshot.mode === 'act' ? 'act' : 'observe'),
          h('span', { style: { flex: 1 } }),
          button(busy === 'state' ? '…' : '刷新', function () {
            run('state', load);
          }, { disabled: busy !== null }),
        ),

        error
          ? h(
              'div',
              {
                style: {
                  border: '1px solid rgba(217,83,79,0.5)',
                  background: 'rgba(217,83,79,0.1)',
                  borderRadius: '8px',
                  padding: '7px 9px',
                  fontSize: '11.5px',
                  lineHeight: '17px',
                },
              },
              error,
            )
          : null,

        flash && !error
          ? h('div', { style: { fontSize: '11px', color: MUTED } }, flash)
          : null,

        // 计数条
        h(
          'div',
          { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
          stat('开放', counts.open ?? 0),
          stat('可派', counts.ready ?? 0),
          stat('在跑', counts.running ?? 0),
          stat('仅记录', counts.observed ?? 0),
          stat('已结', counts.ended ?? 0),
        ),

        // 策略与来源
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              fontSize: '11px',
              color: MUTED,
              borderTop: HAIRLINE,
              paddingTop: '8px',
            },
          },
          h('div', null, '策略 ' + shortId(snapshot.policyVersion) + ' · 允许名单 ' + (inboxAllowed.length ? inboxAllowed.join(', ') : '（空，谁也调用不动）')),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h(
              'span',
              { style: { flex: 1 } },
              'GitHub ' +
                (github.enabled ? (github.mode || 'mentions') : '关') +
                ' · ' +
                (githubAllowed.length === 0 ? '名单为空（不轮询）' : githubAllowed.join(', ')),
            ),
            button(busy === 'poll' ? '轮询中…' : '轮询', function () {
              run('poll', function () {
                return postAction('poll', {});
              });
            }, { disabled: busy !== null }),
          ),
        ),

        // 模式切换
        h(
          'div',
          { style: { display: 'flex', gap: '6px' } },
          button(snapshot.mode === 'act' ? '切到 observe' : '切到 act', function () {
            run('policy', function () {
              return postAction('policy', { mode: snapshot.mode === 'act' ? 'observe' : 'act' });
            });
          }, { primary: snapshot.mode !== 'act', disabled: busy !== null }),
          h(
            'span',
            { style: { fontSize: '10.5px', color: MUTED, alignSelf: 'center' } },
            snapshot.mode === 'act' ? '新投递可派工；已受理的不追认' : '只记录「本来会做」',
          ),
        ),

        // 需要人处理
        (snapshot.needsPerson || []).length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              sectionTitle('需要人处理 ' + snapshot.needsPerson.length),
              openTickets.filter(function (t) { return t.dispatch === 'observed'; }).map(function (ticket) {
                return ticketCard(ticket, handlers);
              }),
            )
          : null,

        // 开放工单（observed 的单已经在「需要人处理」里出现过，不再重复）
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          sectionTitle('开放工单 ' + listedOpen.length),
          listedOpen.length === 0
            ? emptyLine(hasNeedsPerson ? '其余的都已列出；没有可派工的工单。' : '没有开放工单。把 .md 丢进收件箱，或用下面的投递框。')
            : listedOpen.map(function (ticket) { return ticketCard(ticket, handlers); }),
        ),

        // 已结（折叠）
        endedTickets.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              sectionTitle(
                '已结束 ' + endedTickets.length,
                button(showEnded ? '收起' : '展开', function () { setShowEnded(!showEnded); }),
              ),
              showEnded
                ? endedTickets.map(function (ticket) { return ticketCard(ticket, handlers); })
                : null,
            )
          : null,

        // 投递
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px', borderTop: HAIRLINE, paddingTop: '9px' } },
          sectionTitle('投递一件事'),
          h('textarea', {
            value: draft,
            onChange: function (event) { setDraft(event.target.value); },
            rows: 3,
            placeholder: '要做什么，自然语言。走同一套门禁（允许名单 / 冷静期 / 频率上限）。',
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              fontSize: '12px',
              lineHeight: '17px',
              padding: '7px 8px',
              borderRadius: '8px',
              color: 'inherit',
              background: 'rgba(127,127,127,0.08)',
              border: HAIRLINE,
              fontFamily: 'inherit',
            },
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            button(busy === 'submit' ? '投递中…' : '投递', function () {
              if (draft.trim() === '') return;
              run('submit', function () {
                return postAction('submit', { text: draft }).then(function (result) {
                  setDraft('');
                  return result;
                });
              });
            }, { primary: true, disabled: busy !== null || draft.trim() === '' }),
            h('span', { style: { fontSize: '10.5px', color: MUTED } }, '收件箱 ' + shortId(snapshot.inboxDir)),
          ),
        ),

        // 页脚：最近策略变更
        (snapshot.policyChanges || []).length > 0
          ? h(
              'div',
              { style: { fontSize: '10.5px', color: MUTED, borderTop: HAIRLINE, paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '2px' } },
              h('div', null, '策略变更'),
              snapshot.policyChanges.map(function (change) {
                return h(
                  'div',
                  { key: change.at + ':' + (change.ticketId || '') },
                  clock(change.at) + ' · ' + shortId(change.from) + ' → ' + shortId(change.to) +
                    (change.ticketId ? ' · ' + shortId(change.ticketId) : '') +
                    (change.stillAllowed ? '' : ' · 投递人已不在名单'),
                );
              }),
            )
          : null,
      );
    }

    // ── 插件入口 ──────────────────────────────────────────

    /**
     * 注册 tab 类型 + 正文席位。
     *
     * `guide` 里的入口是用户找到面板的唯一路径：右侧栏的「开始」页按注册项列胶囊。
     */
    function apply(ctx) {
      var title = function () { return '值班'; };
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: PANEL_ID,
          kind: PANEL_KIND,
          priority: 'extension',
          title: title,
          keepMounted: true,
          guide: [
            {
              id: 'duty',
              title: title,
              description: function () { return '值班状态、工单与投递'; },
              order: 60,
            },
          ],
        });
      }, 'dsh-duty: panel tab type');

      ctx.effect(function () {
        return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, DutyPanel);
      }, 'dsh-duty: panel body');
    }

    exports.name = 'dsh-duty';
    exports.inject = ['slots', 'sidebarRightTabs'];
    exports.apply = apply;
    /** 面板组件本身：给 preview harness 与单测用，运行时无人调用。 */
    exports.panel = DutyPanel;
    return module.exports;
  },
});

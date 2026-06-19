(function () {
  const hasVsCode = typeof acquireVsCodeApi === 'function';
  const vscode = hasVsCode
    ? acquireVsCodeApi()
    : {
        postMessage(message) {
          console.log('[taproot mock postMessage]', message);
          mockBackend(message);
        },
        getState() {
          return undefined;
        },
        setState() {},
      };

  const app = document.getElementById('app');
  let state = hydrate(vscode.getState && vscode.getState());
  let toastTimer = 0;

  window.addEventListener('message', (event) => {
    receive(event.data);
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const actionEl = target && target.closest('[data-action]');
    if (!actionEl) {
      if (state) {
        state.showFilter = false;
        state.ctx = null;
        render();
      }
      return;
    }
    event.preventDefault();
    handleAction(actionEl);
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !state) {
      return;
    }
    const bind = target.dataset.bind;
    const field = target.dataset.field;
    if (!bind || !field) {
      return;
    }
    if (bind === 'default') {
      state.defaults[field] = target.value;
      state.dirty = true;
      render();
      return;
    }
    if (bind === 'node') {
      const node = findNodeById(Number(target.dataset.id));
      if (!node) {
        return;
      }
      const oldName = node.name;
      node[field] = target.value;
      if (field === 'name' && state.selected === oldName) {
        state.selected = target.value;
      }
      state.dirty = true;
      render();
      return;
    }
    if (bind === 'draft') {
      state.drafts[target.dataset.id] = target.value;
    }
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !state || target.dataset.bind !== 'draft') {
      return;
    }
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    const node = findNodeById(Number(target.dataset.id));
    const value = target.value.trim();
    if (node && value && !node.tags.includes(value)) {
      node.tags.push(value);
      state.drafts[target.dataset.id] = '';
      state.dirty = true;
      render();
    }
  });

  document.addEventListener('contextmenu', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target && target.closest('[data-node-row]');
    if (!row || !state) {
      return;
    }
    event.preventDefault();
    state.ctx = {
      name: row.getAttribute('data-node-row'),
      x: event.clientX,
      y: Math.min(event.clientY, window.innerHeight - 200),
    };
    state.tip = null;
    render();
  });

  document.addEventListener('mouseover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target && target.closest('[data-node-row]');
    if (!row || !state || row.contains(event.relatedTarget)) {
      return;
    }
    const node = findNode(row.getAttribute('data-node-row'));
    if (!node) {
      return;
    }
    state.tip = buildTip(node, event.clientX, event.clientY);
    render();
  });

  document.addEventListener('mouseout', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target && target.closest('[data-node-row]');
    if (!row || !state || row.contains(event.relatedTarget)) {
      return;
    }
    state.tip = null;
    render();
  });

  render();
  vscode.postMessage({ type: 'ready' });

  function receive(message) {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'state') {
      applyBackendState(message.state, true);
      return;
    }
    if (message.type === 'saved') {
      applyBackendState(message.state, true);
      if (state) {
        state.dirty = false;
      }
      showToast(message.message || '已保存 nodes.yaml');
      return;
    }
    if (message.type === 'testResults') {
      applyBackendState(message.state, true);
      showToast(message.message || '连接测试完成');
      return;
    }
    if (message.type === 'validation') {
      showToast((message.errors || []).join('；') || '配置校验失败', 'error');
      return;
    }
    if (message.type === 'error') {
      showToast(message.message || '操作失败', 'error');
      return;
    }
    if (message.type === 'toast') {
      showToast(message.message || '完成');
    }
  }

  function applyBackendState(next, keepUi) {
    const ui = keepUi && state ? pickUi(state) : {};
    state = normalizeState(next, ui);
    persist();
    render();
  }

  function hydrate(saved) {
    if (saved && saved.state) {
      return normalizeState(saved.state, saved.ui || {});
    }
    return null;
  }

  function pickUi(current) {
    return {
      theme: current.theme,
      statusStyle: current.statusStyle,
      view: current.view,
      selected: current.selected,
      filterTag: current.filterTag,
      showFilter: current.showFilter,
      pwd: current.pwd,
      drafts: current.drafts,
      tests: current.tests,
      dirty: current.dirty,
    };
  }

  function normalizeState(next, ui) {
    const nodes = (next && Array.isArray(next.nodes) ? next.nodes : []).map((node, index) => ({
      id: node.id || index + 1,
      name: node.name || `node-${index + 1}`,
      host: node.host || '',
      user: node.user || '',
      port: node.port || '',
      pwd: node.pwd || '',
      sudo: node.sudo || '',
      tags: Array.isArray(node.tags) ? node.tags : [],
      status: node.status || 'inactive',
      error: node.error || '',
      extra: node.extra || {},
    }));
    const selected = ui.selected && nodes.some((node) => node.name === ui.selected)
      ? ui.selected
      : (nodes[0] && nodes[0].name) || '';
    return {
      configPath: (next && next.configPath) || '',
      defaults: {
        user: next && next.defaults ? next.defaults.user || 'admin' : 'admin',
        port: next && next.defaults ? next.defaults.port || '22' : '22',
        pwd: next && next.defaults ? next.defaults.pwd || '' : '',
        sudo: next && next.defaults ? next.defaults.sudo || '' : '',
        extra: next && next.defaults ? next.defaults.extra || {} : {},
        pwdShow: false,
        sudoShow: false,
      },
      nodes,
      backend: next && next.backend ? next.backend : { connected: false, message: 'taproot-mcp 状态未知' },
      theme: ui.theme || 'dark',
      statusStyle: ui.statusStyle || 'dot',
      view: ui.view || 'config',
      selected,
      filterTag: ui.filterTag || null,
      showFilter: !!ui.showFilter,
      ctx: null,
      tip: null,
      pwd: ui.pwd || {},
      drafts: ui.drafts || {},
      tests: ui.tests || {},
      toast: null,
      toastTone: 'success',
      dirty: !!ui.dirty,
    };
  }

  function persist() {
    if (!state || !vscode.setState) {
      return;
    }
    vscode.setState({ state: toWireState(), ui: pickUi(state) });
  }

  function handleAction(el) {
    if (!state) {
      return;
    }
    const action = el.getAttribute('data-action');
    switch (action) {
      case 'refreshAll':
      case 'testAll':
        testConnections();
        break;
      case 'toggleFilter':
        state.showFilter = !state.showFilter;
        state.ctx = null;
        render();
        break;
      case 'filter':
        state.filterTag = el.getAttribute('data-filter') || null;
        state.showFilter = false;
        render();
        break;
      case 'clearFilter':
        state.filterTag = null;
        render();
        break;
      case 'openConfig':
      case 'showConfig':
        state.view = 'config';
        state.ctx = null;
        render();
        break;
      case 'showDetail':
        if (!state.selected && state.nodes[0]) {
          state.selected = state.nodes[0].name;
        }
        state.view = 'detail';
        state.ctx = null;
        render();
        break;
      case 'selectNode':
        state.selected = el.getAttribute('data-node') || state.selected;
        state.view = 'detail';
        state.showFilter = false;
        state.ctx = null;
        render();
        break;
      case 'addNode':
        addNode();
        break;
      case 'deleteNode':
        deleteNode(Number(el.getAttribute('data-id')));
        break;
      case 'removeTag':
        removeTag(Number(el.getAttribute('data-id')), Number(el.getAttribute('data-index')));
        break;
      case 'toggleSecret':
        toggleSecret(el.getAttribute('data-key'));
        break;
      case 'saveCfg':
        vscode.postMessage({ type: 'saveConfig', state: toWireState() });
        break;
      case 'resetCfg':
        vscode.postMessage({ type: 'resetConfig' });
        break;
      case 'copySsh':
        vscode.postMessage({ type: 'copySsh', state: toWireState(), nodeName: actionNode(el) });
        state.ctx = null;
        render();
        break;
      case 'openTerminal':
        vscode.postMessage({ type: 'openTerminal', state: toWireState(), nodeName: actionNode(el) });
        state.ctx = null;
        render();
        break;
      case 'refreshNode':
        testConnections();
        state.ctx = null;
        break;
      case 'closeOverlays':
        state.ctx = null;
        state.showFilter = false;
        render();
        break;
      case 'theme':
        state.theme = el.getAttribute('data-value') || 'dark';
        persist();
        render();
        break;
      case 'statusStyle':
        state.statusStyle = el.getAttribute('data-value') || 'dot';
        persist();
        render();
        break;
      default:
        break;
    }
  }

  function actionNode(el) {
    return el.getAttribute('data-node') || state.selected;
  }

  function addNode() {
    const id = Math.max(0, ...state.nodes.map((node) => node.id)) + 1;
    const node = {
      id,
      name: `new-node-${id}`,
      host: '',
      user: '',
      port: '',
      pwd: '',
      sudo: '',
      tags: [],
      status: 'inactive',
      error: '',
      extra: {},
    };
    state.nodes.push(node);
    state.selected = node.name;
    state.view = 'config';
    state.dirty = true;
    render();
  }

  function deleteNode(id) {
    const node = findNodeById(id);
    state.nodes = state.nodes.filter((item) => item.id !== id);
    if (node && state.selected === node.name) {
      state.selected = (state.nodes[0] && state.nodes[0].name) || '';
    }
    state.dirty = true;
    render();
  }

  function removeTag(id, index) {
    const node = findNodeById(id);
    if (!node) {
      return;
    }
    node.tags.splice(index, 1);
    state.dirty = true;
    render();
  }

  function toggleSecret(key) {
    if (!key) {
      return;
    }
    state.pwd[key] = !state.pwd[key];
    render();
  }

  function testConnections() {
    state.nodes = state.nodes.map((node) => ({ ...node, status: 'checking', error: '' }));
    state.tests = Object.fromEntries(state.nodes.map((node) => [node.id, 'checking']));
    render();
    vscode.postMessage({ type: 'testConnections', state: toWireState() });
  }

  function showToast(message, tone) {
    clearTimeout(toastTimer);
    if (!state) {
      return;
    }
    state.toast = message;
    state.toastTone = tone || 'success';
    render();
    toastTimer = setTimeout(() => {
      if (state) {
        state.toast = null;
        render();
      }
    }, tone === 'error' ? 4200 : 2200);
  }

  function render() {
    if (!app) {
      return;
    }
    if (!state) {
      app.innerHTML = '<div class="loading">加载 Taproot 配置…</div>';
      return;
    }
    app.innerHTML = `
      <div class="shell" data-theme="${escAttr(state.theme)}">
        ${renderTitleBar()}
        <div class="main">
          ${renderActivityBar()}
          ${renderSidebar()}
          ${renderEditor()}
        </div>
        ${renderStatusBar()}
        ${renderTooltip()}
        ${renderContextMenu()}
        ${renderToast()}
        ${renderPrototypeControls()}
      </div>
    `;
  }

  function renderTitleBar() {
    return `
      <div class="titlebar">
        <div class="title-left">
          <span class="codicon codicon-vscode" style="color:#3794ff"></span>
          <div class="title-menu"><span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Terminal</span><span>Help</span></div>
        </div>
        <div class="title-center">nodes.yaml — taproot — Visual Studio Code</div>
        <div class="title-actions">
          <span class="codicon codicon-chrome-minimize"></span>
          <span class="codicon codicon-chrome-maximize"></span>
          <span class="codicon codicon-chrome-close"></span>
        </div>
      </div>
    `;
  }

  function renderActivityBar() {
    return `
      <div class="activitybar">
        <div class="activity-group">
          <div class="activity-item active" title="Taproot">${taprootSvg()}</div>
          ${['files', 'search', 'source-control', 'debug-alt', 'extensions'].map((name) => `<div class="activity-item"><span class="codicon codicon-${name}"></span></div>`).join('')}
        </div>
        <div class="activity-group">
          <div class="activity-item"><span class="codicon codicon-account"></span></div>
          <div class="activity-item"><span class="codicon codicon-settings-gear"></span></div>
        </div>
      </div>
    `;
  }

  function renderSidebar() {
    const filter = state.showFilter ? renderFilterBox() : '';
    const activeFilter = state.filterTag
      ? `<div class="active-filter"><span class="codicon codicon-filter-filled"></span><span>${esc(`过滤: ${state.filterTag}`)}</span><span class="codicon codicon-close" data-action="clearFilter"></span></div>`
      : '';
    return `
      <aside class="sidebar">
        <div class="sidebar-head">
          <span class="sidebar-title">Taproot Nodes</span>
          <div class="toolbar">
            <span title="刷新全部" data-action="refreshAll" class="codicon codicon-refresh icon-action"></span>
            <span title="按标签过滤" data-action="toggleFilter" class="codicon codicon-filter icon-action"></span>
            <span title="打开配置编辑器" data-action="openConfig" class="codicon codicon-gear icon-action"></span>
          </div>
        </div>
        ${filter}
        ${activeFilter}
        <div class="tree">${visibleNodes().map(renderTreeRow).join('')}</div>
      </aside>
    `;
  }

  function renderFilterBox() {
    const tags = uniqueTags();
    const options = [
      `<div class="filter-option" data-action="filter"><span class="codicon codicon-clear-all"></span><span>全部节点</span></div>`,
      ...tags.map((tag) => `<div class="filter-option" data-action="filter" data-filter="${escAttr(tag)}"><span class="codicon codicon-tag"></span><span>${esc(tag)}</span></div>`),
    ];
    return `<div class="filter-box"><div class="filter-title">按标签过滤</div>${options.join('')}</div>`;
  }

  function renderTreeRow(node) {
    const meta = statusMeta(node.status);
    const selected = state.selected === node.name && state.view === 'detail';
    const style = state.statusStyle === 'bar' ? `style="border-left-color:${meta.hex}"` : '';
    const indicator = state.statusStyle === 'icon'
      ? `<span class="codicon ${meta.icon} status-icon" style="color:${meta.hex}"></span>`
      : (state.statusStyle === 'dot' ? `<span class="status-dot" style="background:${meta.hex}"></span>` : '');
    return `
      <div class="row ${selected ? 'selected' : ''}" ${style} data-action="selectNode" data-node="${escAttr(node.name)}" data-node-row="${escAttr(node.name)}">
        ${indicator}
        <span class="row-name">${esc(node.name)}</span>
        <span class="row-user">${esc(effectiveUser(node))}@${esc(node.host || '未配置')}</span>
        ${node.status === 'error' ? `<span class="row-error">${esc(node.error || '连接失败')}</span>` : ''}
        <div class="row-tags">${node.tags.map((tag) => `<span class="chip small">${esc(tag)}</span>`).join('')}</div>
      </div>
    `;
  }

  function renderEditor() {
    const detail = selectedNode() || state.nodes[0] || null;
    return `
      <main class="editor">
        <div class="tabs">
          <div class="tab ${state.view === 'config' ? 'active' : ''}" data-action="showConfig">
            <span class="codicon codicon-settings" style="color:var(--accent)"></span><span>Nodes 配置编辑器</span><span class="codicon codicon-close"></span>
          </div>
          <div class="tab ${state.view === 'detail' ? 'active' : ''}" data-action="showDetail">
            <span class="codicon codicon-server" style="color:var(--accent)"></span><span>${esc(detail ? detail.name : '节点')} · 详情</span><span class="codicon codicon-close"></span>
          </div>
        </div>
        <div class="breadcrumb">
          <span class="codicon codicon-root-folder"></span><span>taproot</span><span class="codicon codicon-chevron-right"></span><span>${state.view === 'config' ? 'nodes.yaml' : esc(detail ? detail.name : '节点')}</span>
        </div>
        <div class="content">${state.view === 'detail' ? renderDetail(detail) : renderConfig()}</div>
        ${state.view === 'config' ? renderFooter() : ''}
      </main>
    `;
  }

  function renderConfig() {
    return `
      <section class="config-page">
        <div class="page-head">
          <div>
            <h1>节点配置编辑器</h1>
            <div class="subtitle">可视化编辑 <span class="mono">${esc(state.configPath || 'nodes.yaml')}</span>，保存后写回配置文件并刷新侧边栏。</div>
          </div>
          <div class="backend-state ${state.backend.connected ? '' : 'error'}">
            <span class="codicon ${state.backend.connected ? 'codicon-plug' : 'codicon-warning'}"></span>${esc(state.backend.message)}
          </div>
        </div>
        ${renderDefaults()}
        <div class="nodes-head">
          <span class="nodes-head-title">节点 <span style="color:var(--fg-muted);font-weight:400">(${state.nodes.length})</span></span>
          <span class="override-help">蓝色圆点 = 覆盖了默认值</span>
        </div>
        ${state.nodes.length === 0 ? renderEmpty() : `<div class="cards">${state.nodes.map(renderNodeCard).join('')}</div><button class="button add-wide" data-action="addNode"><span class="codicon codicon-add"></span>添加节点</button>`}
      </section>
    `;
  }

  function renderDefaults() {
    return `
      <div class="panel">
        <div class="section-title"><span class="codicon codicon-globe" style="color:var(--accent)"></span><span>全局默认值 (defaults)</span></div>
        <div class="section-desc">以下值为所有节点的默认配置，单个节点可覆盖。</div>
        <div class="grid-defaults">
          ${textField('SSH 用户名', state.defaults.user, 'default', 'user')}
          ${textField('SSH 端口', state.defaults.port, 'default', 'port')}
          ${secretField('密码', state.defaults.pwd, 'default', 'pwd', 'defaultPwd', '••••••••')}
          ${secretField('sudo 密码', state.defaults.sudo, 'default', 'sudo', 'defaultSudo', '继承密码')}
        </div>
      </div>
    `;
  }

  function renderEmpty() {
    return `
      <div class="empty">
        <span class="codicon codicon-server-environment" style="font-size:38px;color:var(--fg-muted);opacity:.7"></span>
        <div style="color:var(--fg);font-size:15px;font-weight:500">还没有配置任何节点</div>
        <div style="color:var(--fg-muted);font-size:13px;max-width:360px">添加一个远端节点开始构建你的集群。</div>
        <button class="button" data-action="addNode"><span class="codicon codicon-add"></span>添加节点</button>
      </div>
    `;
  }

  function renderNodeCard(node) {
    const duplicate = duplicateNames().has(node.name.trim());
    const fail = node.status === 'error' || !node.host || duplicate;
    const checking = node.status === 'checking';
    return `
      <article class="node-card ${fail ? 'invalid' : ''}">
        <div class="node-card-head">
          <span class="codicon ${node.tags.includes('dev') ? 'codicon-vm' : 'codicon-server'}" style="font-size:17px;color:var(--accent)"></span>
          <input class="ghost-input node-name-input" value="${escAttr(node.name)}" data-bind="node" data-id="${node.id}" data-field="name">
          ${duplicate ? '<span class="test-result fail"><span class="codicon codicon-error"></span>名称重复</span>' : ''}
          <div class="inline-actions">
            ${checking ? '<span class="test-result"><span class="codicon codicon-sync codicon-modifier-spin"></span>测试中</span>' : ''}
            ${node.status === 'online' ? '<span class="test-result pass"><span class="codicon codicon-pass-filled"></span>连接成功</span>' : ''}
            ${node.status === 'error' ? `<span class="test-result fail"><span class="codicon codicon-error"></span>${esc(node.error || '连接失败')}</span>` : ''}
            <span title="删除节点" data-action="deleteNode" data-id="${node.id}" class="codicon codicon-trash icon-action"></span>
          </div>
        </div>
        <div class="node-fields">
          ${textField('Host / IP 地址 *', node.host, 'node', 'host', node.id, '192.168.1.x', !node.host)}
          ${overrideField('SSH 用户名', node.user, 'user', node.id, `继承默认值: ${state.defaults.user}`)}
          ${overrideField('SSH 端口', node.port, 'port', node.id, `继承默认值: ${state.defaults.port}`)}
        </div>
        <div class="node-secret-fields">
          ${secretField('密码', node.pwd, 'node', 'pwd', `p${node.id}`, '继承默认值', node.id, !!node.pwd)}
          ${secretField('sudo 密码', node.sudo, 'node', 'sudo', `s${node.id}`, '继承默认值', node.id, !!node.sudo)}
        </div>
        ${renderTags(node)}
      </article>
    `;
  }

  function renderTags(node) {
    return `
      <div class="field">
        <label>Tags</label>
        <div class="tags-box">
          ${node.tags.map((tag, index) => `<span class="chip">${esc(tag)}<span data-action="removeTag" data-id="${node.id}" data-index="${index}" class="codicon codicon-close icon-action" style="padding:0"></span></span>`).join('')}
          <input value="${escAttr(state.drafts[node.id] || '')}" data-bind="draft" data-id="${node.id}" placeholder="输入标签后回车…">
        </div>
      </div>
    `;
  }

  function renderDetail(node) {
    if (!node) {
      return `<section class="detail-page"><h1>未选择节点</h1><div class="subtitle">请先添加或选择一个节点。</div></section>`;
    }
    const meta = statusMeta(node.status);
    const command = sshCommand(node);
    return `
      <section class="detail-page">
        <div class="detail-head">
          <span class="detail-status-dot" style="background:${meta.hex}"></span>
          <h1>${esc(node.name)}</h1>
          <div class="detail-tags">${node.tags.map((tag) => `<span class="chip">${esc(tag)}</span>`).join('')}</div>
          <span class="detail-status-text">${esc(meta.text)}</span>
        </div>
        <div class="info-grid">
          <div class="info-cell"><div class="info-label">Host / IP</div><div class="mono">${esc(node.host || '未配置')}</div></div>
          <div class="info-cell"><div class="info-label">SSH 用户</div><div>${esc(effectiveUser(node) || '未配置')}</div></div>
          <div class="info-cell"><div class="info-label">SSH 端口</div><div>${esc(effectivePort(node) || '22')}</div></div>
        </div>
        ${node.status === 'error' ? `<div class="error-box"><span class="codicon codicon-error" style="font-size:18px"></span><div><div style="font-weight:600">连接失败</div><div style="font-size:12px;margin-top:2px">${esc(node.error || '连接失败')}</div></div></div>` : ''}
        <div class="detail-card">
          <div class="info-label">SSH 命令</div>
          <div class="ssh-line">
            <code class="mono">${esc(command)}</code>
            <span title="复制" data-action="copySsh" data-node="${escAttr(node.name)}" class="codicon codicon-copy icon-action"></span>
          </div>
        </div>
        <div class="detail-actions">
          <button class="button" data-action="openTerminal" data-node="${escAttr(node.name)}"><span class="codicon codicon-terminal"></span>在终端中 SSH</button>
          <button class="button secondary" data-action="openConfig"><span class="codicon codicon-edit"></span>编辑配置</button>
        </div>
      </section>
    `;
  }

  function renderFooter() {
    return `
      <div class="footer">
        <button class="button secondary" data-action="testAll"><span class="codicon codicon-plug"></span>测试全部连接</button>
        <div class="inline-actions">
          <button class="button ghost" data-action="resetCfg">重置</button>
          <button class="button" data-action="saveCfg"><span class="codicon codicon-save"></span>保存</button>
        </div>
      </div>
    `;
  }

  function renderStatusBar() {
    return `
      <div class="statusbar">
        <div class="status-left">
          <span class="status-item"><span class="codicon codicon-remote"></span>Taproot</span>
          <span class="status-item"><span class="codicon codicon-pass"></span>${esc(statusSummary())}</span>
          ${state.dirty ? '<span class="status-item"><span class="codicon codicon-circle-filled"></span>未保存</span>' : ''}
        </div>
        <div class="status-right"><span>YAML</span><span>Spaces: 2</span><span>UTF-8</span></div>
      </div>
    `;
  }

  function renderTooltip() {
    if (!state.tip) {
      return '';
    }
    return `
      <div class="tooltip" style="left:${state.tip.x}px;top:${state.tip.y}px">
        <div class="tooltip-title"><span class="status-dot" style="background:${state.tip.color};margin:0"></span>${esc(state.tip.name)}</div>
        ${state.tip.rows.map((row) => `<div class="tooltip-row"><span style="color:var(--fg-muted)">${esc(row.k)}</span><span class="mono">${esc(row.v)}</span></div>`).join('')}
      </div>
    `;
  }

  function renderContextMenu() {
    if (!state.ctx) {
      return '';
    }
    const nodeName = escAttr(state.ctx.name);
    return `
      <div class="overlay" data-action="closeOverlays"></div>
      <div class="context-menu" style="left:${state.ctx.x}px;top:${state.ctx.y}px">
        <div class="menu-item" data-action="openTerminal" data-node="${nodeName}"><span class="codicon codicon-terminal"></span>在终端中 SSH 连接</div>
        <div class="menu-item" data-action="openConfig" data-node="${nodeName}"><span class="codicon codicon-edit"></span>编辑节点配置</div>
        <div class="menu-item" data-action="refreshNode" data-node="${nodeName}"><span class="codicon codicon-refresh"></span>刷新状态</div>
        <div class="menu-sep"></div>
        <div class="menu-item" data-action="copySsh" data-node="${nodeName}"><span class="codicon codicon-copy"></span>复制 SSH 命令</div>
      </div>
    `;
  }

  function renderToast() {
    if (!state.toast) {
      return '';
    }
    const icon = state.toastTone === 'error' ? 'codicon-error' : 'codicon-check-all';
    const color = state.toastTone === 'error' ? 'var(--red)' : 'var(--green)';
    return `<div class="toast" style="border-left-color:${color}"><span class="codicon ${icon}" style="color:${color}"></span>${esc(state.toast)}</div>`;
  }

  function renderPrototypeControls() {
    return `
      <div class="prototype-controls">
        <div class="proto-title"><span class="codicon codicon-beaker"></span>原型控制</div>
        <div class="proto-row"><span class="proto-label">主题</span><div class="segmented">
          ${segment('theme', 'dark', 'Dark+', state.theme === 'dark')}
          ${segment('theme', 'light', 'Light+', state.theme === 'light')}
        </div></div>
        <div class="proto-row"><span class="proto-label">状态</span><div class="segmented">
          ${segment('statusStyle', 'dot', '<span class="codicon codicon-circle-filled"></span>圆点', state.statusStyle === 'dot')}
          ${segment('statusStyle', 'bar', '色条', state.statusStyle === 'bar')}
          ${segment('statusStyle', 'icon', '<span class="codicon codicon-pass-filled"></span>图标', state.statusStyle === 'icon')}
        </div></div>
        <div class="proto-row"><span class="proto-label">视图</span><div class="segmented">
          <button class="segment ${state.view === 'config' ? 'active' : ''}" data-action="showConfig">配置编辑</button>
          <button class="segment ${state.view === 'detail' ? 'active' : ''}" data-action="showDetail">节点详情</button>
        </div></div>
      </div>
    `;
  }

  function segment(action, value, label, active) {
    return `<button class="segment ${active ? 'active' : ''}" data-action="${action}" data-value="${value}">${label}</button>`;
  }

  function textField(label, value, bind, field, id, placeholder, invalid) {
    const idAttrs = id ? ` data-id="${id}"` : '';
    return `
      <div class="field">
        <label>${esc(label)}</label>
        <input class="input" value="${escAttr(value || '')}" data-bind="${bind}"${idAttrs} data-field="${field}" placeholder="${escAttr(placeholder || '')}" ${invalid ? 'style="border-color:var(--red)"' : ''}>
      </div>
    `;
  }

  function overrideField(label, value, field, id, placeholder) {
    const active = !!value;
    return `
      <div class="field">
        <div class="field-label-with-dot ${active ? 'active' : ''}"><span class="dot"></span><label>${esc(label)}</label></div>
        <input class="input" value="${escAttr(value || '')}" data-bind="node" data-id="${id}" data-field="${field}" placeholder="${escAttr(placeholder || '')}">
      </div>
    `;
  }

  function secretField(label, value, bind, field, key, placeholder, id, active) {
    const idAttrs = id ? ` data-id="${id}"` : '';
    const shown = !!state.pwd[key];
    const labelHtml = active
      ? `<div class="field-label-with-dot active"><span class="dot"></span><label>${esc(label)}</label></div>`
      : `<label>${esc(label)}</label>`;
    return `
      <div class="field">
        ${labelHtml}
        <div class="password-box">
          <input type="${shown ? 'text' : 'password'}" value="${escAttr(value || '')}" data-bind="${bind}"${idAttrs} data-field="${field}" placeholder="${escAttr(placeholder || '')}">
          <span data-action="toggleSecret" data-key="${escAttr(key)}" class="codicon ${shown ? 'codicon-eye-closed' : 'codicon-eye'}"></span>
        </div>
      </div>
    `;
  }

  function visibleNodes() {
    return state.nodes.filter((node) => !state.filterTag || node.tags.includes(state.filterTag));
  }

  function uniqueTags() {
    return [...new Set(state.nodes.flatMap((node) => node.tags || []))].sort();
  }

  function duplicateNames() {
    const seen = new Set();
    const dupes = new Set();
    for (const name of state.nodes.map((node) => node.name.trim()).filter(Boolean)) {
      if (seen.has(name)) {
        dupes.add(name);
      }
      seen.add(name);
    }
    return dupes;
  }

  function selectedNode() {
    return findNode(state.selected);
  }

  function findNode(name) {
    return state.nodes.find((node) => node.name === name);
  }

  function findNodeById(id) {
    return state.nodes.find((node) => node.id === id);
  }

  function statusMeta(status) {
    if (status === 'online') {
      return { hex: 'var(--green)', icon: 'codicon-pass-filled', text: '已连接' };
    }
    if (status === 'warn') {
      return { hex: 'var(--yellow)', icon: 'codicon-warning', text: '负载高' };
    }
    if (status === 'error') {
      return { hex: 'var(--red)', icon: 'codicon-error', text: '连接失败' };
    }
    if (status === 'checking') {
      return { hex: 'var(--accent)', icon: 'codicon-sync codicon-modifier-spin', text: '测试中' };
    }
    return { hex: 'var(--gray)', icon: 'codicon-circle-outline', text: '未激活' };
  }

  function buildTip(node, x, y) {
    const meta = statusMeta(node.status);
    const rows = [
      { k: 'Host', v: node.host || '未配置' },
      { k: 'User', v: effectiveUser(node) || '未配置' },
      { k: 'Port', v: effectivePort(node) || '22' },
      { k: 'Tags', v: node.tags.join(', ') || '-' },
      { k: 'Status', v: meta.text },
    ];
    if (node.error) {
      rows.push({ k: 'Error', v: node.error });
    }
    return {
      name: node.name,
      color: meta.hex,
      rows,
      x: Math.min(x + 14, window.innerWidth - 300),
      y: y + 14,
    };
  }

  function effectiveUser(node) {
    return node.user || state.defaults.user || '';
  }

  function effectivePort(node) {
    return node.port || state.defaults.port || '22';
  }

  function sshCommand(node) {
    const user = effectiveUser(node);
    const destination = user ? `${user}@${node.host}` : node.host;
    return `ssh -p ${effectivePort(node)} ${destination}`;
  }

  function statusSummary() {
    const counts = state.nodes.reduce((acc, node) => {
      acc[node.status] = (acc[node.status] || 0) + 1;
      return acc;
    }, {});
    const online = (counts.online || 0) + (counts.warn || 0);
    const failed = counts.error || 0;
    return `${online}/${state.nodes.length} 在线${failed ? ` · ${failed} 失败` : ''}`;
  }

  function toWireState() {
    return {
      configPath: state.configPath,
      defaults: {
        user: state.defaults.user,
        port: state.defaults.port,
        pwd: state.defaults.pwd,
        sudo: state.defaults.sudo,
        extra: state.defaults.extra || {},
      },
      nodes: state.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        host: node.host,
        user: node.user,
        port: node.port,
        pwd: node.pwd,
        sudo: node.sudo,
        tags: node.tags,
        status: node.status,
        error: node.error,
        extra: node.extra || {},
      })),
      backend: state.backend,
    };
  }

  function taprootSvg() {
    return `
      <svg class="taproot-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="4.4" r="2.1"></circle>
        <path d="M12 6.5V12"></path>
        <path d="M12 12C12 16 6.5 16.5 5.5 21"></path>
        <path d="M12 12C12 16 17.5 16.5 18.5 21"></path>
        <path d="M12 12V21"></path>
        <path d="M8.8 17.5L7.6 20.4"></path>
        <path d="M15.2 17.5L16.4 20.4"></path>
      </svg>
    `;
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, '&#96;');
  }

  function mockBackend(message) {
    if (message.type === 'ready' || message.type === 'resetConfig') {
      setTimeout(() => receive({ type: 'state', state: mockState() }), 30);
      return;
    }
    if (message.type === 'saveConfig') {
      setTimeout(() => receive({ type: 'saved', state: message.state, message: '已保存 nodes.yaml' }), 80);
      return;
    }
    if (message.type === 'testConnections') {
      const next = JSON.parse(JSON.stringify(message.state));
      next.nodes = next.nodes.map((node) => node.host
        ? { ...node, status: node.name.includes('bad') || node.name.endsWith('-3') ? 'error' : 'online', error: node.name.includes('bad') || node.name.endsWith('-3') ? (node.error || 'Connection refused') : '' }
        : { ...node, status: 'error', error: 'Host 必填' });
      setTimeout(() => receive({ type: 'testResults', state: next, message: `已测试 ${next.nodes.length} 个节点` }), 180);
      return;
    }
    if (message.type === 'copySsh' || message.type === 'openTerminal') {
      setTimeout(() => receive({ type: 'toast', message: message.type === 'copySsh' ? '已复制 SSH 命令' : '终端执行 SSH 命令' }), 40);
    }
  }

  function mockState() {
    return {
      configPath: '/tmp/taproot-nodes.localhost.yaml',
      defaults: { user: 'admin', port: '22', pwd: '', sudo: '', extra: { key: '~/.ssh/id_rsa' } },
      backend: { connected: true, message: 'taproot-mcp 已连接' },
      nodes: [
        { id: 1, name: 'gpu-node-1', host: '192.168.1.101', user: '', port: '', pwd: '', sudo: '', tags: ['gpu', 'h200', 'vllm'], status: 'online', extra: {} },
        { id: 2, name: 'gpu-node-2', host: '192.168.1.102', user: '', port: '', pwd: '', sudo: '', tags: ['gpu', 'h200', 'vllm'], status: 'online', extra: {} },
        { id: 3, name: 'gpu-node-3', host: '192.168.1.103', user: '', port: '', pwd: '', sudo: '', tags: ['gpu', 'h200', 'vllm'], status: 'error', error: 'Connection refused', extra: {} },
        { id: 4, name: 'dev-vm', host: '192.168.1.200', user: 'deploy', port: '2222', pwd: '', sudo: '', tags: ['dev', 'build'], status: 'warn', extra: {} },
      ],
    };
  }
})();

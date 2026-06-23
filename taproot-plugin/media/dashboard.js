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
  let revealNodeId = 0;
  let focusNodeId = 0;
  let tabTransition = null;

  window.addEventListener('message', (event) => {
    receive(event.data);
  });

  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    focusEditableTarget(target);
  }, true);

  document.addEventListener('mousedown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    focusEditableTarget(target);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target && focusEditableTarget(target)) {
      return;
    }
    const actionEl = target && target.closest('[data-action]');
    if (!actionEl) {
      if (state) {
        state.showFilter = false;
        state.ctx = null;
        render({ preserveScroll: true });
      }
      return;
    }
    event.preventDefault();
    handleAction(actionEl);
  });

  function isEditableTarget(target) {
    return !!editableTarget(target);
  }

  function editableTarget(target) {
    if (!target) {
      return null;
    }
    const direct = target.closest('input, textarea, select, [contenteditable="true"]');
    if (direct) {
      return direct;
    }
    if (target.closest('[data-action]')) {
      return null;
    }
    const fieldShell = target.closest('.tags-box, .password-box');
    return fieldShell ? fieldShell.querySelector('input, textarea, select, [contenteditable="true"]') : null;
  }

  function focusEditableTarget(target) {
    const editable = editableTarget(target);
    if (!editable) {
      return false;
    }
    if (editable instanceof HTMLElement && document.activeElement !== editable) {
      editable.focus({ preventScroll: true });
    }
    return true;
  }

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
    if (bind === 'detailSearch') {
      state.detailQuery = target.value;
      state.showFilter = false;
      persist();
      replaceDetailResults();
      return;
    }
    if (bind === 'default') {
      state.defaults[field] = target.value;
      state.dirty = true;
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
    render({ preserveScroll: true });
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
    if (message.type === 'selectNode') {
      const nodeName = message.nodeName || '';
      const node = state && findNode(nodeName);
      if (state && node) {
        state.selected = node.name;
        if (message.view === 'config') {
          setView('config');
          openConfigNode(node, { reveal: true, collapseOthers: true });
        } else {
          setView('detail');
          state.detailOpen[node.name] = true;
        }
        state.showFilter = false;
        state.ctx = null;
        persist();
        render();
      }
      return;
    }
    if (message.type === 'showConfig') {
      if (state) {
        setView('config');
        ensureConfigSelectionOpen();
        state.ctx = null;
        persist();
        render();
      }
      return;
    }
    if (message.type === 'saved') {
      applyBackendState(message.state, true, { preserveScroll: true });
      if (state) {
        state.dirty = false;
        state.pendingNewNodeId = 0;
        persist();
      }
      showToast(message.message || '已保存 nodes.yaml');
      return;
    }
    if (message.type === 'backendInstalled') {
      if (state) {
        state.installingBackend = false;
      }
      applyBackendState(message.state, true, { preserveScroll: true });
      if (state) {
        state.installingBackend = false;
        persist();
      }
      showToast(message.message || '后端已安装/更新');
      return;
    }
    if (message.type === 'testResults') {
      mergeTestResults(message.state);
      showToast(message.message || '连接测试完成');
      return;
    }
    if (message.type === 'statusUpdate') {
      mergeStatusUpdate(message.state);
      return;
    }
    if (message.type === 'validation') {
      showToast((message.errors || []).join('；') || '配置校验失败', 'error');
      return;
    }
    if (message.type === 'error') {
      if (state) {
        state.installingBackend = false;
        persist();
      }
      showToast(message.message || '操作失败', 'error');
      return;
    }
    if (message.type === 'toast') {
      showToast(message.message || '完成');
    }
  }

  function applyBackendState(next, keepUi, renderOptions = {}) {
    const ui = keepUi && state ? pickUi(state) : {};
    state = normalizeState(next, ui);
    persist();
    render(renderOptions);
  }

  function mergeTestResults(next) {
    if (!state) {
      applyBackendState(next, true);
      return;
    }
    const incoming = normalizeState(next, pickUi(state));
    const byName = new Map(incoming.nodes.map((node) => [node.name, node]));
    state.nodes = state.nodes.map((node) => {
      const checked = byName.get(node.name);
      return checked ? { ...node, status: checked.status, error: checked.error || '' } : node;
    });
    state.backend = incoming.backend;
    state.activities = incoming.activities;
    persist();
    render({ preserveScroll: true });
  }

  function mergeStatusUpdate(next) {
    if (!state) {
      applyBackendState(next, true, { preserveScroll: true });
      return;
    }
    const incoming = normalizeState(next, pickUi(state));
    const byName = new Map(incoming.nodes.map((node) => [node.name, node]));
    state.nodes = state.nodes.map((node) => {
      const checked = byName.get(node.name);
      return checked ? { ...node, status: checked.status, error: checked.error || '' } : node;
    });
    state.backend = incoming.backend;
    persist();
    render({ preserveScroll: true });
  }

  function hydrate(saved) {
    if (saved && saved.state) {
      return normalizeState(saved.state, saved.ui || {});
    }
    return null;
  }

  function pickUi(current) {
    return {
      statusStyle: current.statusStyle,
      view: current.view,
      selected: current.selected,
      filterTag: current.filterTag,
      detailQuery: current.detailQuery,
      showFilter: current.showFilter,
      pwd: current.pwd,
      drafts: current.drafts,
      tests: current.tests,
      detailOpen: current.detailOpen,
      activityOpen: current.activityOpen,
      configOpen: current.configOpen,
      pendingNewNodeId: current.pendingNewNodeId,
      dirty: current.dirty,
      installingBackend: current.installingBackend,
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
    const activities = normalizeActivities(next && next.activities);
    const sourceOpen = ui.detailOpen && typeof ui.detailOpen === 'object' ? ui.detailOpen : {};
    const detailOpen = {};
    for (const node of nodes) {
      if (Object.prototype.hasOwnProperty.call(sourceOpen, node.name)) {
        detailOpen[node.name] = !!sourceOpen[node.name];
      }
    }
    if (!Object.keys(sourceOpen).length && selected) {
      detailOpen[selected] = true;
    }
    const sourceActivityOpen = ui.activityOpen && typeof ui.activityOpen === 'object' ? ui.activityOpen : {};
    const activityOpen = {};
    for (const item of activities) {
      if (Object.prototype.hasOwnProperty.call(sourceActivityOpen, item.id)) {
        activityOpen[item.id] = !!sourceActivityOpen[item.id];
      }
    }
    const sourceConfigOpen = ui.configOpen && typeof ui.configOpen === 'object' ? ui.configOpen : {};
    const configOpen = {};
    for (const node of nodes) {
      if (Object.prototype.hasOwnProperty.call(sourceConfigOpen, node.id)) {
        configOpen[node.id] = !!sourceConfigOpen[node.id];
      }
    }
    if (!Object.keys(sourceConfigOpen).length && nodes.length) {
      const openNode = nodes.find((node) => node.name === selected) || nodes[0];
      configOpen[openNode.id] = true;
    }
    const pendingNewNodeId = Number(ui.pendingNewNodeId) || 0;
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
      statusStyle: ui.statusStyle || 'dot',
      view: ui.view === 'config' ? 'config' : 'detail',
      selected,
      filterTag: ui.filterTag || null,
      detailQuery: ui.detailQuery || '',
      showFilter: !!ui.showFilter,
      ctx: null,
      pwd: ui.pwd || {},
      drafts: ui.drafts || {},
      tests: ui.tests || {},
      detailOpen,
      activityOpen,
      configOpen,
      pendingNewNodeId: nodes.some((node) => node.id === pendingNewNodeId) ? pendingNewNodeId : 0,
      activities,
      toast: null,
      toastTone: 'success',
      dirty: !!ui.dirty,
      installingBackend: !!ui.installingBackend,
    };
  }

  function persist() {
    if (!state || !vscode.setState) {
      return;
    }
    vscode.setState({ state: toWireState(), ui: pickUi(state) });
  }

  function normalizeActivities(activities) {
    if (!Array.isArray(activities)) {
      return [];
    }
    return activities
      .filter((item) => item && item.summary)
      .map((item) => ({
        id: item.id || `${item.timestamp || Date.now()}-${Math.random().toString(16).slice(2)}`,
        node: item.node || '',
        tool: item.tool || '',
        action: item.action || 'operation',
        ok: item.ok !== false,
        summary: item.summary || item.tool || '操作',
        detail: item.detail && typeof item.detail === 'object' ? item.detail : {},
        error: item.error || '',
        timestamp: item.timestamp || '',
      }))
      .slice(0, 200);
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
      case 'installBackend':
        state.installingBackend = true;
        persist();
        render({ preserveScroll: true });
        vscode.postMessage({ type: 'installBackend' });
        break;
      case 'openConfig':
      case 'showConfig':
        setView('config');
        ensureConfigSelectionOpen(action === 'openConfig' ? actionNode(el) : undefined, {
          reveal: action === 'openConfig',
          collapseOthers: action === 'openConfig',
        });
        state.ctx = null;
        render();
        break;
      case 'showDetail':
        if (!state.selected && state.nodes[0]) {
          state.selected = state.nodes[0].name;
        }
        if (state.selected && state.detailOpen[state.selected] === undefined) {
          state.detailOpen[state.selected] = true;
        }
        setView('detail');
        state.ctx = null;
        render();
        break;
	      case 'toggleDetailNode': {
	        const nodeName = actionNode(el);
	        if (nodeName) {
	          state.selected = nodeName;
	          state.detailOpen[nodeName] = !state.detailOpen[nodeName];
          persist();
          render({ preserveScroll: true });
	        }
	        break;
	      }
	      case 'toggleActivity': {
	        const id = el.getAttribute('data-id');
	        if (id) {
	          state.activityOpen[id] = !state.activityOpen[id];
	          persist();
	          render({ preserveScroll: true });
	        }
	        break;
	      }
      case 'expandAllDetailNodes':
        setAllDetailNodesOpen(true);
        break;
      case 'collapseAllDetailNodes':
        setAllDetailNodesOpen(false);
        break;
      case 'toggleConfigNode':
        toggleConfigNode(Number(el.getAttribute('data-id')));
        break;
      case 'toggleFilter':
        state.showFilter = !state.showFilter;
        state.ctx = null;
        persist();
        render({ preserveScroll: true });
        break;
      case 'filter':
        state.filterTag = el.getAttribute('data-filter') || null;
        state.showFilter = false;
        persist();
        render({ preserveScroll: true });
        break;
      case 'clearFilter':
        state.filterTag = null;
        state.detailQuery = '';
        state.showFilter = false;
        persist();
        render({ preserveScroll: true });
        break;
      case 'selectNode':
        state.selected = el.getAttribute('data-node') || state.selected;
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
        render({ preserveScroll: true });
        break;
      case 'openTerminal':
        vscode.postMessage({ type: 'openTerminal', state: toWireState(), nodeName: actionNode(el) });
        state.ctx = null;
        render({ preserveScroll: true });
        break;
      case 'refreshNode':
        testNode(actionNode(el));
        state.ctx = null;
        break;
      case 'closeOverlays':
        state.ctx = null;
        state.showFilter = false;
        render({ preserveScroll: true });
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

  function setView(nextView) {
    if (!state || state.view === nextView) {
      return;
    }
    tabTransition = { from: state.view, to: nextView };
    state.view = nextView;
  }

  function actionNode(el) {
    return el.getAttribute('data-node') || state.selected;
  }

  function ensureConfigSelectionOpen(nodeName, options = {}) {
    const node = (nodeName && findNode(nodeName)) || selectedNode() || state.nodes[0];
    if (!node) {
      return;
    }
    openConfigNode(node, options);
  }

  function openConfigNode(node, options = {}) {
    state.selected = node.name;
    if (options.collapseOthers) {
      for (const item of state.nodes) {
        state.configOpen[item.id] = false;
      }
    }
    state.configOpen[node.id] = true;
    if (options.reveal) {
      revealNodeId = node.id;
    }
    if (options.focus) {
      focusNodeId = node.id;
    }
  }

  function setAllDetailNodesOpen(open) {
    for (const node of state.nodes) {
      state.detailOpen[node.name] = open;
    }
    state.ctx = null;
    state.showFilter = false;
    persist();
    render({ preserveScroll: true });
  }

  function toggleConfigNode(id) {
    const node = findNodeById(id);
    if (!node) {
      return;
    }
    state.selected = node.name;
    state.configOpen[id] = !state.configOpen[id];
    persist();
    const patched = replaceConfigNodeCard(id);
    if (!patched) {
      render({ preserveScroll: true });
    }
  }

  function replaceConfigNodeCard(id) {
    const card = app && app.querySelector(`[data-node-card-id="${id}"]`);
    const node = findNodeById(id);
    if (!card || !node) {
      return false;
    }
    const content = app.querySelector('.content');
    const scrollTop = content ? content.scrollTop : 0;
    const template = document.createElement('template');
    template.innerHTML = renderNodeCard(node).trim();
    const nextCard = template.content.firstElementChild;
    if (!nextCard) {
      return false;
    }
    card.replaceWith(nextCard);
    if (content) {
      content.scrollTop = scrollTop;
    }
    return true;
  }

  function addNode() {
    const pendingNode = state.pendingNewNodeId ? findNodeById(state.pendingNewNodeId) : null;
    if (pendingNode) {
      state.selected = pendingNode.name;
      state.view = 'config';
      state.ctx = null;
      state.configOpen[pendingNode.id] = true;
      focusNodeId = pendingNode.id;
      persist();
      render();
      return;
    }
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
    state.pendingNewNodeId = node.id;
    state.view = 'config';
    state.ctx = null;
    state.configOpen[node.id] = true;
    focusNodeId = node.id;
    state.dirty = true;
    persist();
    render();
  }

  function deleteNode(id) {
    const node = findNodeById(id);
    state.nodes = state.nodes.filter((item) => item.id !== id);
    if (state.pendingNewNodeId === id) {
      state.pendingNewNodeId = 0;
    }
    delete state.configOpen[id];
    if (node && state.selected === node.name) {
      state.selected = (state.nodes[0] && state.nodes[0].name) || '';
    }
    state.dirty = true;
    render({ preserveScroll: true });
  }

  function removeTag(id, index) {
    const node = findNodeById(id);
    if (!node) {
      return;
    }
    node.tags.splice(index, 1);
    state.dirty = true;
    render({ preserveScroll: true });
  }

  function toggleSecret(key) {
    if (!key) {
      return;
    }
    state.pwd[key] = !state.pwd[key];
    render({ preserveScroll: true });
  }

  function testConnections() {
    state.nodes = state.nodes.map((node) => ({ ...node, status: 'checking', error: '' }));
    state.tests = Object.fromEntries(state.nodes.map((node) => [node.id, 'checking']));
    render({ preserveScroll: true });
    vscode.postMessage({ type: 'testConnections', state: toWireState() });
  }

  function testNode(nodeName) {
    const name = nodeName || state.selected;
    const node = findNode(name);
    if (!node) {
      return;
    }
    state.nodes = state.nodes.map((item) =>
      item.name === node.name ? { ...item, status: 'checking', error: '' } : item,
    );
    state.tests = { ...state.tests, [node.id]: 'checking' };
    state.ctx = null;
    render({ preserveScroll: true });
    vscode.postMessage({ type: 'testNode', state: toWireState(), nodeName: node.name });
  }

  function showToast(message, tone) {
    clearTimeout(toastTimer);
    if (!state) {
      return;
    }
    state.toast = message;
    state.toastTone = tone || 'success';
    render({ preserveScroll: true });
    toastTimer = setTimeout(() => {
      if (state) {
        state.toast = null;
        render({ preserveScroll: true });
      }
    }, tone === 'error' ? 4200 : 2200);
  }

  function render(options = {}) {
    if (!app) {
      return;
    }
    if (!state) {
      app.innerHTML = '<div class="loading">加载 Taproot 配置…</div>';
      return;
    }
    const previousContent = options.preserveScroll ? app.querySelector('.content') : null;
    const previousScrollTop = previousContent ? previousContent.scrollTop : 0;
    app.innerHTML = `
      <div class="taproot-workbench">
        ${renderEditor()}
        ${renderContextMenu()}
        ${renderToast()}
      </div>
    `;
    tabTransition = null;
    if (options.preserveScroll) {
      const nextContent = app.querySelector('.content');
      if (nextContent) {
        nextContent.scrollTop = previousScrollTop;
      }
    }
    revealPendingNodeCard();
  }

  function revealPendingNodeCard() {
    const id = focusNodeId || revealNodeId;
    const shouldFocus = !!focusNodeId;
    focusNodeId = 0;
    revealNodeId = 0;
    if (!id) {
      return;
    }
    setTimeout(() => {
      const card = app && app.querySelector(`[data-node-card-id="${id}"]`);
      if (!card) {
        return;
      }
      if (typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
      if (!shouldFocus) {
        return;
      }
      const input = card.querySelector('input[data-field="name"]') || card.querySelector('input');
      if (input && typeof input.focus === 'function') {
        input.focus({ preventScroll: true });
      }
      if (input && typeof input.select === 'function') {
        input.select();
      }
    }, 0);
  }

  function renderFilterBox() {
    const tags = uniqueTags();
    const options = [
      `<div class="filter-option" data-action="filter"><span class="codicon codicon-clear-all"></span><span>全部节点</span></div>`,
      ...tags.map((tag) => `<div class="filter-option" data-action="filter" data-filter="${escAttr(tag)}"><span class="codicon codicon-tag"></span><span>${esc(tag)}</span></div>`),
    ];
    return `<div class="filter-box"><div class="filter-title">按标签过滤</div>${options.join('')}</div>`;
  }

  function renderEditor() {
    const detail = selectedNode() || state.nodes[0] || null;
    const transition = tabTransition && tabTransition.to === state.view
      ? `${tabTransition.from}-${tabTransition.to}`
      : '';
    const transitionAttr = transition ? ` data-transition="${transition}"` : '';
    const contentClass = transition ? 'content view-transition' : 'content';
    return `
      <main class="editor editor-standalone">
        <div class="product-header">
          <div>
            <div class="product-kicker">${taprootMark()}<span>taproot-mcp</span></div>
          </div>
          <div class="header-actions">
            <button class="button secondary compact" data-action="installBackend" title="安装或更新 taproot-mcp 后端" ${state.installingBackend ? 'disabled' : ''}>
              <span class="codicon codicon-cloud-download"></span><span>${state.installingBackend ? '安装中…' : '安装/更新后端'}</span>
            </button>
            <div class="backend-state ${state.backend.connected ? '' : 'error'}">
              <span class="codicon ${state.backend.connected ? 'codicon-plug' : 'codicon-warning'}"></span>${esc(state.backend.message)}
            </div>
          </div>
        </div>
        <div class="tabs" data-view="${state.view}"${transitionAttr} role="tablist">
          <div class="tabs-indicator" aria-hidden="true"></div>
          <div class="tab ${state.view === 'config' ? 'active' : ''}" data-action="showConfig" role="tab" aria-selected="${state.view === 'config'}">
            <span class="codicon codicon-settings" style="color:var(--icon-accent)"></span><span>节点配置</span>
          </div>
          <div class="tab ${state.view === 'detail' ? 'active' : ''}" data-action="showDetail" role="tab" aria-selected="${state.view === 'detail'}">
            <span class="codicon codicon-server" style="color:var(--icon-accent)"></span><span>节点详情</span>
          </div>
        </div>
        <div class="${contentClass}">${state.view === 'config' ? renderConfig() : renderDetail()}</div>
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
          </div>
        </div>
        <div class="nodes-head">
          <span class="nodes-head-title">节点 <span style="color:var(--fg-muted);font-weight:400">(${state.nodes.length})</span></span>
        </div>
        ${state.nodes.length === 0 ? renderEmpty() : `<div class="cards">${state.nodes.map(renderNodeCard).join('')}</div><button class="button add-wide" data-action="addNode"><span class="codicon codicon-add"></span>添加节点</button>`}
      </section>
    `;
  }

  function taprootMark() {
    return `
      <svg class="taproot-mark" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 6.5V12M12 12V21M12 12C12 16 6.5 16.5 5.5 21M12 12C12 16 17.5 16.5 18.5 21M8.8 17.5L7.6 20.4M15.2 17.5L16.4 20.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="12" cy="4.4" r="2.1" stroke="currentColor" stroke-width="1.6"/>
      </svg>
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
    const open = !!state.configOpen[node.id];
    const meta = statusMeta(node.status);
    if (!open) {
      return `
        <article class="node-card collapsed ${fail ? 'invalid' : ''} ${state.pendingNewNodeId === node.id ? 'pending-new' : ''}" data-node-card-id="${node.id}">
          ${renderConfigSummary(node, duplicate, meta, open)}
        </article>
      `;
    }
    return `
      <article class="node-card open ${fail ? 'invalid' : ''} ${state.pendingNewNodeId === node.id ? 'pending-new' : ''}" data-node-card-id="${node.id}">
        ${renderConfigSummary(node, duplicate, meta, open)}
        <div class="node-fields name-row">
          ${textField('节点名称 *', node.name, 'node', 'name', node.id, 'node-name', duplicate)}
        </div>
        <div class="node-fields">
          ${textField('Host / IP 地址 *', node.host, 'node', 'host', node.id, '192.168.1.x', !node.host)}
          ${textField('SSH 用户名', node.user, 'node', 'user', node.id, 'xiaoxiao')}
          ${textField('SSH 端口', node.port, 'node', 'port', node.id, '22')}
        </div>
        <div class="node-secret-fields">
          ${secretField('密码', node.pwd, 'node', 'pwd', `p${node.id}`, '可留空', node.id, !!node.pwd)}
          ${secretField('sudo 密码', node.sudo, 'node', 'sudo', `s${node.id}`, '可留空', node.id, !!node.sudo)}
        </div>
        ${renderTags(node)}
      </article>
    `;
  }

  function renderConfigSummary(node, duplicate, meta, open) {
    return `
      <div class="config-node-summary-wrap">
        <button class="node-card-collapse" data-action="toggleConfigNode" data-id="${node.id}" aria-label="${open ? '折叠' : '展开'} ${escAttr(node.name)}">
          <span class="codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'}"></span>
        </button>
        <button class="config-node-summary" data-action="toggleConfigNode" data-id="${node.id}">
          <span class="codicon ${node.tags.includes('dev') ? 'codicon-vm' : 'codicon-server'}" style="font-size:17px;color:var(--icon-accent)"></span>
          <span class="detail-node-main">
            <span class="detail-node-name">${esc(node.name)}</span>
            <span class="detail-node-tags">${node.tags.map((tag) => `<span class="chip small">${esc(tag)}</span>`).join('')}</span>
          </span>
          <span class="detail-node-field"><span>IP</span><strong class="mono">${esc(node.host || '未配置')}</strong></span>
          <span class="detail-node-field"><span>端口</span><strong>${esc(effectivePort(node) || '22')}</strong></span>
          <span class="detail-node-field"><span>用户</span><strong>${esc(effectiveUser(node) || '未配置')}</strong></span>
          <span class="detail-node-state" style="color:${duplicate ? 'var(--red)' : meta.hex}">${duplicate ? '名称重复' : esc(meta.text)}</span>
        </button>
        <span title="删除节点" data-action="deleteNode" data-id="${node.id}" class="codicon codicon-trash icon-action"></span>
      </div>
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

  function renderDetail() {
    if (!state.nodes.length) {
      return `<section class="detail-page"><h1>节点详情</h1><div class="subtitle">请先添加节点。</div></section>`;
    }
    const nodes = filteredDetailNodes();
    return `
      <section class="detail-page activity-page">
        <div class="detail-head">
          <div class="detail-title">
            <span class="codicon codicon-server" style="color:var(--icon-accent);font-size:18px"></span>
            <h1>节点详情</h1>
            <div class="detail-bulk-actions" aria-label="节点详情折叠控制">
              <button class="button secondary detail-bulk-button" data-action="expandAllDetailNodes" title="全部展开">
                <span class="codicon codicon-expand-all"></span><span>全部展开</span>
              </button>
              <button class="button secondary detail-bulk-button" data-action="collapseAllDetailNodes" title="全部折叠">
                <span class="codicon codicon-collapse-all"></span><span>全部折叠</span>
              </button>
            </div>
          </div>
          <div class="detail-tools">
            <label class="detail-search">
              <span class="codicon codicon-search"></span>
              <input value="${escAttr(state.detailQuery || '')}" data-bind="detailSearch" data-field="query" placeholder="按名称/标签搜索">
            </label>
            <button class="button secondary detail-filter-button ${state.filterTag ? 'active' : ''}" data-action="toggleFilter">
              <span class="codicon codicon-filter"></span>
              <span>${state.filterTag ? esc(state.filterTag) : '按标签筛选'}</span>
            </button>
            ${(state.filterTag || state.detailQuery) ? '<button class="icon-action detail-clear" data-action="clearFilter" title="清空筛选"><span class="codicon codicon-close"></span></button>' : ''}
            ${state.showFilter ? renderDetailFilterMenu() : ''}
          </div>
          <button class="button secondary detail-refresh-button" data-action="refreshAll" title="刷新节点状态">
            <span class="codicon codicon-refresh"></span>
            <span>刷新</span>
          </button>
        </div>
        <div class="detail-stack" data-detail-stack>
          ${nodes.length ? nodes.map(renderDetailNodePanel).join('') : renderDetailNoResults()}
        </div>
      </section>
    `;
  }

  function renderDetailFilterMenu() {
    const tags = uniqueTags();
    return `
      <div class="detail-filter-menu">
        <button class="filter-option ${state.filterTag ? '' : 'active'}" data-action="filter">
          <span class="codicon codicon-clear-all"></span><span>全部标签</span>
        </button>
        ${tags.length
          ? tags.map((tag) => `
            <button class="filter-option ${state.filterTag === tag ? 'active' : ''}" data-action="filter" data-filter="${escAttr(tag)}">
              <span class="codicon codicon-tag"></span><span>${esc(tag)}</span>
            </button>
          `).join('')
          : '<div class="filter-empty">暂无标签</div>'}
      </div>
    `;
  }

  function renderDetailNoResults() {
    return `
      <div class="detail-empty-results">
        <span class="codicon codicon-search"></span>
        <span>没有匹配的节点</span>
      </div>
    `;
  }

  function replaceDetailResults() {
    const stack = app && app.querySelector('[data-detail-stack]');
    if (!stack) {
      render({ preserveScroll: true });
      return;
    }
    const nodes = filteredDetailNodes();
    stack.innerHTML = nodes.length ? nodes.map(renderDetailNodePanel).join('') : renderDetailNoResults();
    if (!state.showFilter) {
      const menu = app && app.querySelector('.detail-filter-menu');
      if (menu) {
        menu.remove();
      }
    }
  }

  function renderDetailNodePanel(node) {
    const meta = statusMeta(node.status);
    const activities = recentActivitiesFor(node);
    const open = !!state.detailOpen[node.name];
    return `
      <article class="detail-node ${open ? 'open' : ''}" data-detail-node="${escAttr(node.name)}" data-node-row="${escAttr(node.name)}">
        <button class="detail-node-head" data-action="toggleDetailNode" data-node="${escAttr(node.name)}">
          <span class="detail-status-dot" style="background:${meta.hex}"></span>
          <span class="detail-node-main">
            <span class="detail-node-name">${esc(node.name)}</span>
            <span class="detail-node-tags">${node.tags.map((tag) => `<span class="chip small">${esc(tag)}</span>`).join('')}</span>
          </span>
          <span class="detail-node-field"><span>IP</span><strong class="mono">${esc(node.host || '未配置')}</strong></span>
          <span class="detail-node-field"><span>端口</span><strong>${esc(effectivePort(node) || '22')}</strong></span>
          <span class="detail-node-field"><span>用户</span><strong>${esc(effectiveUser(node) || '未配置')}</strong></span>
          <span class="detail-node-state" style="color:${meta.hex}">${esc(meta.text)}</span>
          <span class="detail-node-count">${activities.length} 条操作</span>
          <span class="codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'}"></span>
        </button>
        ${open ? `<div class="detail-node-body">${activities.length ? `<div class="activity-list">${activities.map(renderActivityItem).join('')}</div>` : renderEmptyActivity()}</div>` : ''}
      </article>
    `;
  }

  function recentActivitiesFor(node) {
    return (state.activities || [])
      .filter((item) => item.node === node.name)
      .sort(compareActivities)
      .slice(0, 24);
  }

  function compareActivities(a, b) {
    const timeA = Date.parse(a.timestamp || '') || 0;
    const timeB = Date.parse(b.timestamp || '') || 0;
    if (timeA !== timeB) {
      return timeB - timeA;
    }
    return activitySortWeight(b) - activitySortWeight(a);
  }

  function activitySortWeight(item) {
    if (item.action === 'write' || item.tool === 'cluster_write_file') {
      return 50;
    }
    if (item.action === 'edit' || item.tool === 'cluster_edit_file') {
      return 45;
    }
    if (item.action === 'upload') {
      return 40;
    }
    if (item.action === 'download') {
      return 35;
    }
    if (item.action === 'exec') {
      return 30;
    }
    if (item.action === 'read') {
      return 20;
    }
    return 0;
  }

  function renderActivityItem(item) {
    const meta = activityMeta(item.action);
    const detail = activityDetail(item);
    const open = !!state.activityOpen[item.id];
    return `
      <article class="activity-item ${item.ok ? '' : 'failed'} ${open ? 'open' : ''}" data-activity-id="${escAttr(item.id)}">
        <button class="activity-summary" data-action="toggleActivity" data-id="${escAttr(item.id)}">
          <span class="codicon ${meta.icon} activity-icon ${meta.tone}"></span>
          <span class="activity-copy">
            <span class="activity-title"><span class="activity-title-label">${esc(activityTitle(item))}</span>${item.ok ? '' : '<span class="activity-fail">失败</span>'}</span>
            ${detail ? `<span class="activity-detail">${esc(detail)}</span>` : ''}
          </span>
          <time class="activity-time">${esc(formatActivityTime(item.timestamp))}</time>
          <span class="codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} activity-chevron"></span>
        </button>
        ${open ? renderActivityExpanded(item) : ''}
      </article>
    `;
  }

  function activityTitle(item) {
    const summary = (item.summary || '').trim();
    if (summary && !isBackendToolName(summary)) {
      return summary.replace(/\bcluster_[a-z0-9_]+\b/ig, activityKindLabel(item) || '操作');
    }
    return activityKindLabel(item) || '操作';
  }

  function activityKindLabel(item) {
    const byTool = {
      cluster_exec: '命令执行',
      cluster_read_file: '文件读取',
      cluster_edit_file: '文件编辑',
      cluster_write_file: '文件写入',
      cluster_list_dir: '目录查看',
      cluster_glob: '文件查找',
      cluster_system_info: '系统信息',
      cluster_service: '服务管理',
      cluster_upload: '文件上传',
      cluster_download: '文件下载',
      cluster_session_open: '会话打开',
      cluster_session_exec: '会话命令',
      cluster_session_read: '会话读取',
      cluster_session_interrupt: '会话中断',
      cluster_session_close: '会话关闭',
    };
    if (byTool[item.tool]) {
      return byTool[item.tool];
    }
    return {
      exec: '命令执行',
      read: '读取',
      edit: '编辑',
      write: '写入',
      list: '目录查看',
      glob: '文件查找',
      system: '系统信息',
      service: '服务管理',
      upload: '文件上传',
      download: '文件下载',
      interrupt: '中断',
      session: '会话',
      operation: '操作',
    }[item.action] || '';
  }

  function isBackendToolName(value) {
    return /^cluster_[a-z0-9_]+$/i.test(value);
  }

  function renderActivityExpanded(item) {
    const rows = activityExpandedRows(item);
    const content = activityWrittenContent(item);
    const rowsHtml = rows.length
      ? `<dl class="activity-expanded-grid">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`
      : '';
    const contentHtml = content === null
      ? ''
      : `<div class="activity-content-block"><div class="activity-content-title">写入内容${item.detail && item.detail.content_truncated ? '（已截断）' : ''}</div><pre>${esc(content)}</pre></div>`;
    if (!rowsHtml && !contentHtml) {
      return '';
    }
    return `<div class="activity-expanded">${rowsHtml}${contentHtml}</div>`;
  }

  function activityExpandedRows(item) {
    const detail = item.detail || {};
    const rows = [];
    const keys = [
      ['command', '命令'],
      ['cwd', '工作目录'],
      ['path', '路径'],
      ['remote_path', '远端路径'],
      ['local_path', '本地路径'],
      ['backup_path', '备份路径'],
      ['service', '服务'],
      ['action', '服务动作'],
      ['pattern', '匹配模式'],
      ['bytes', '写入字节'],
      ['mode', '权限'],
      ['sudo', 'sudo'],
      ['backup', '备份'],
    ];
    for (const [key, label] of keys) {
      if (detail[key] !== undefined && detail[key] !== null && detail[key] !== '') {
        rows.push([label, String(detail[key])]);
      }
    }
    if (item.error) {
      rows.unshift(['错误', item.error]);
    }
    return rows;
  }

  function activityWrittenContent(item) {
    const detail = item.detail || {};
    if (detail.content_preview !== undefined && detail.content_preview !== null) {
      return String(detail.content_preview);
    }
    if (detail.content !== undefined && detail.content !== null) {
      return String(detail.content);
    }
    return null;
  }

  function renderEmptyActivity() {
    return `
      <div class="activity-empty">
        <span class="codicon codicon-history"></span>
        <div>暂无通过 taproot-mcp 执行的操作记录</div>
      </div>
    `;
  }

  function activityMeta(action) {
    if (action === 'upload') {
      return { icon: 'codicon-cloud-upload', tone: 'accent' };
    }
    if (action === 'download') {
      return { icon: 'codicon-cloud-download', tone: 'accent' };
    }
    if (action === 'exec') {
      return { icon: 'codicon-terminal', tone: 'green' };
    }
    if (action === 'read' || action === 'list' || action === 'glob') {
      return { icon: 'codicon-file-code', tone: 'muted' };
    }
    if (action === 'service' || action === 'system') {
      return { icon: 'codicon-server-process', tone: 'green' };
    }
    if (action === 'interrupt') {
      return { icon: 'codicon-trash', tone: 'red' };
    }
    return { icon: 'codicon-edit', tone: 'accent' };
  }

  function activityDetail(item) {
    const parts = [];
    if (item.error) {
      parts.push(item.error);
    }
    const detail = item.detail || {};
    for (const key of ['command', 'path', 'remote_path', 'local_path', 'service', 'pattern']) {
      if (detail[key]) {
        parts.push(`${key}: ${detail[key]}`);
      }
    }
    return parts.join(' · ');
  }

  function formatActivityTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function renderFooter() {
    return `
      <div class="footer">
        <button class="button" data-action="saveCfg"><span class="codicon codicon-save"></span>保存</button>
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

  function filteredDetailNodes() {
    const query = (state.detailQuery || '').trim().toLowerCase();
    return state.nodes.filter((node) => {
      if (state.filterTag && !node.tags.includes(state.filterTag)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return node.name.toLowerCase().includes(query) || node.tags.some((tag) => tag.toLowerCase().includes(query));
    });
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
      return { hex: 'var(--icon-accent)', icon: 'codicon-sync codicon-modifier-spin', text: '测试中' };
    }
    return { hex: 'var(--gray)', icon: 'codicon-circle-outline', text: '未激活' };
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

  function testResultMessage(nodes, nodeName) {
    const scopedNodes = nodeName ? nodes.filter((node) => node.name === nodeName) : nodes;
    const successCount = scopedNodes.filter((node) => node.status === 'online').length;
    return `${nodeName ? '刷新完成' : '测试完成'}：成功 ${successCount} / 共 ${scopedNodes.length} 个节点`;
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
      setTimeout(() => receive({ type: 'testResults', state: next, message: testResultMessage(next.nodes) }), 180);
      return;
    }
    if (message.type === 'testNode') {
      const next = JSON.parse(JSON.stringify(message.state));
      next.nodes = next.nodes.map((node) => {
        if (node.name !== message.nodeName) {
          return node;
        }
        return node.host
          ? { ...node, status: node.name.includes('bad') || node.name.endsWith('-3') ? 'error' : 'online', error: node.name.includes('bad') || node.name.endsWith('-3') ? (node.error || 'Connection refused') : '' }
          : { ...node, status: 'error', error: 'Host 必填' };
      });
      setTimeout(() => receive({ type: 'testResults', state: next, message: testResultMessage(next.nodes, message.nodeName) }), 120);
      return;
    }
    if (message.type === 'copySsh' || message.type === 'openTerminal') {
      setTimeout(() => receive({ type: 'toast', message: message.type === 'copySsh' ? '已复制 SSH 命令' : '终端执行 SSH 命令' }), 40);
      return;
    }
    if (message.type === 'installBackend') {
      const next = mockState();
      next.backend = { connected: true, message: 'taproot-mcp 已连接' };
      setTimeout(() => receive({ type: 'backendInstalled', state: next, message: '后端已安装/更新' }), 240);
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
      activities: [
        {
          id: 'mock-read-1',
          timestamp: '2026-06-20T01:16:00.000Z',
          node: 'gpu-node-1',
          tool: 'cluster_read_file',
          action: 'read',
          ok: true,
          summary: '读取文件: 1.txt',
          detail: { path: '1.txt' },
        },
        {
          id: 'mock-write-1',
          timestamp: '2026-06-20T01:16:00.000Z',
          node: 'gpu-node-1',
          tool: 'cluster_write_file',
          action: 'write',
          ok: true,
          summary: '写入文件: 1.txt',
          detail: { path: '1.txt', bytes: 3, content_preview: 'hi\n', content_truncated: false },
        },
        {
          id: 'mock-exec-1',
          timestamp: '2026-06-19T12:00:00.000Z',
          node: 'gpu-node-1',
          tool: 'cluster_exec',
          action: 'exec',
          ok: true,
          summary: '执行 bash: nvidia-smi -L',
          detail: { command: 'nvidia-smi -L' },
        },
      ],
    };
  }
})();

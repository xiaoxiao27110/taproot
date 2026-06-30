import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';

const root = path.resolve(__dirname, '..', '..');

test('dashboard webview renders as a real extension surface and supports core interactions', async () => {
  const html = await readFile(path.join(root, 'test', 'harness.html'), 'utf8');
  const css = await readFile(path.join(root, 'media', 'dashboard.css'), 'utf8');

  assert.match(css, /--vscode-editor-background/);
  assert.match(css, /body\.vscode-light/);
  assert.match(css, /--icon-accent/);
  assert.match(css, /--icon-bg/);
  assert.match(css, /\.codicon\s*\{/);
  assert.match(css, /\.taproot-mark\b/);
  assert.match(css, /color:\s*var\(--icon-accent\)/);
  assert.match(css, /\.content\s*\{[\s\S]*?overflow-y:\s*scroll/);
  assert.match(css, /\.content\s*\{[\s\S]*?scrollbar-gutter:\s*stable/);
  assert.match(css, /\.content\s*\{[\s\S]*?overflow-anchor:\s*none/);
  assert.doesNotMatch(css, /\.node-card\.open \.node-card-collapse\s*\{/);
  assert.match(css, /\.node-card\.open \.name-row\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(css, /\.config-node-summary-wrap:hover\s*\{[\s\S]*?background:\s*var\(--list-hover\)/);
  assert.match(css, /\.config-node-summary-wrap \.config-node-summary:hover,\s*\.config-node-summary-wrap \.node-card-collapse:hover\s*\{[\s\S]*?background:\s*transparent/);
  assert.doesNotMatch(css, /\.config-node-summary:hover\s*\{\s*background:\s*var\(--list-hover\)/);
  assert.match(css, /\.detail-search\b/);
  assert.match(css, /\.detail-filter-menu\b/);
  assert.match(css, /\.detail-bulk-actions\b/);
  assert.match(css, /\.detail-bulk-button\b/);
  assert.match(css, /\.activity-summary\s*\{[\s\S]*?min-height:\s*52px/);
  assert.match(css, /\.activity-title-text\s*\{[\s\S]*?text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /\.activity-detail\b/);
  assert.match(css, /\.approval-panel\b/);
  assert.match(css, /\.approval-item\b/);
  assert.match(css, /\.approval-actions\b/);
  assert.doesNotMatch(css, /\.agent-setup\b/);
  assert.doesNotMatch(css, /\.agent-setup-actions\b/);
  assert.doesNotMatch(css, /\.agent-setup-row code\b/);
  assert.match(css, /\.tabs-indicator\b/);
  assert.match(css, /@keyframes tab-indicator-slide/);
  assert.match(css, /\.content\.view-transition\b/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /\[data-theme=/);
  assert.doesNotMatch(css, /\.tooltip\b/);
  assert.doesNotMatch(css, /\.node-table-row\.selected\b/);

  const dom = new JSDOM(html, {
    url: pathToFileURL(path.join(root, 'test', 'harness.html')).toString(),
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  const scrolledCards: string[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolledCards.push(this.dataset.nodeCardId || '');
  };
  const postedMessages: Array<{
    type?: string;
    nodeName?: string;
    state?: any;
    approvalId?: string;
    approvalDecision?: string;
  }> = [];
  const originalLog = dom.window.console.log.bind(dom.window.console);
  dom.window.console.log = (...args: unknown[]) => {
    if (args[0] === '[taproot mock postMessage]' && args[1] && typeof args[1] === 'object') {
      postedMessages.push(args[1] as { type?: string; nodeName?: string; state?: any });
    }
    originalLog(...args);
  };
  await waitFor(() => dom.window.document.body.textContent?.includes('taproot-mcp'));

  assert.match(dom.window.document.body.textContent || '', /gpu-node-1/);
  assert.match(dom.window.document.body.textContent || '', /节点详情/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /Taproot 节点/);
  assert.equal(dom.window.document.querySelector('.breadcrumb'), null);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /\/tmp\/taproot-nodes\.localhost\.yaml/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /配置已同步/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /工作台/);
  assert.equal(dom.window.document.querySelector('[data-action="showOverview"]'), null);
  assert.equal(dom.window.document.querySelector('.summary-grid'), null);
  assert.equal(dom.window.document.querySelector('.node-preview'), null);
  assert.equal(dom.window.document.querySelectorAll('[data-detail-node]').length, 4);
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 4);
  assert.match(dom.window.document.body.textContent || '', /待审批危险操作/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /安装后端，然后复制提示词给你的 Agent/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /复制 Agent 提示词/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /安装\/更新后端/);
  assert.match(dom.window.document.body.textContent || '', /允许一次/);
  assert.match(dom.window.document.body.textContent || '', /允许并记住/);
  assert.match(dom.window.document.body.textContent || '', /拒绝/);
  assert(dom.window.document.querySelector('[data-approval-id="appr-build-1"]'));
  const approvalMessagesBefore = postedMessages.filter((item) => item.type === 'approvalAction').length;
  click(dom, '[data-approval-id="appr-build-1"] [data-decision="remember"]');
  const approvalMessages = postedMessages.filter((item) => item.type === 'approvalAction');
  assert.equal(approvalMessages.length, approvalMessagesBefore + 1);
  const approvalMessage = approvalMessages.at(-1);
  assert.equal(approvalMessage?.approvalId, 'appr-build-1');
  assert.equal(approvalMessage?.approvalDecision, 'remember');
  assert.equal(dom.window.document.querySelector('.titlebar'), null);
  assert.equal(dom.window.document.querySelector('.activitybar'), null);
  assert.equal(dom.window.document.querySelector('.sidebar'), null);
  assert.equal(dom.window.document.querySelector('.prototype-controls'), null);
  assert(dom.window.document.querySelector('.product-kicker .taproot-mark'));
  assert.equal(dom.window.document.querySelector('.product-kicker .codicon-remote'), null);
  const initialTabs = dom.window.document.querySelector<HTMLElement>('.tabs');
  assert(initialTabs);
  assert.equal(initialTabs.dataset.view, 'detail');
  assert(initialTabs.querySelector('.tabs-indicator'));
  const tabActions = [...initialTabs.querySelectorAll<HTMLElement>('.tab')].map((tab) => tab.dataset.action);
  assert.deepEqual(tabActions, ['showConfig', 'showDetail']);
  const headerActions = dom.window.document.querySelector<HTMLElement>('.header-actions');
  assert(headerActions);
  assert.equal(headerActions.querySelector('[data-action="testAll"]'), null);
  assert.equal(headerActions.querySelector('[data-action="showConfig"]'), null);
  assert.equal(headerActions.querySelector('[data-action="installBackend"]'), null);
  assert.equal(dom.window.document.querySelector('[data-action="copyAgentPrompt"]'), null);
  const workbench = dom.window.document.querySelector('.taproot-workbench');
  assert(workbench);
  assert.equal(workbench.hasAttribute('data-theme'), false);
  dispatchMouseOver(dom, '[data-node-row="gpu-node-1"]');
  assert.equal(dom.window.document.querySelector('.tooltip'), null);
  let detailSearch = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="detailSearch"]');
  assert(detailSearch);
  assert.equal(detailSearch.placeholder, '按名称/标签搜索');
  detailSearch = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="detailSearch"]');
  assert(detailSearch);
  assert(dom.window.document.querySelector('[data-action="toggleFilter"]'));
  assert.match(dom.window.document.querySelector('[data-action="expandAllDetailNodes"]')?.textContent || '', /全部展开/);
  assert.match(dom.window.document.querySelector('[data-action="collapseAllDetailNodes"]')?.textContent || '', /全部折叠/);
  assert.equal(dom.window.document.querySelector('[data-detail-count]'), null);
  assert.match(dom.window.document.querySelector('[data-action="refreshAll"]')?.textContent || '', /刷新/);
  detailSearch.value = 'dev';
  detailSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.querySelectorAll('[data-detail-node]').length, 1);
  assert.match(dom.window.document.querySelector('[data-action="refreshAll"]')?.textContent || '', /刷新/);
  assert.match(dom.window.document.body.textContent || '', /dev-vm/);
  detailSearch.value = '';
  detailSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.querySelectorAll('[data-detail-node]').length, 4);
  click(dom, '[data-action="toggleFilter"]');
  assert(dom.window.document.querySelector('.detail-filter-menu'));
  clickByText(dom, '.detail-filter-menu .filter-option', 'vllm');
  assert.equal(dom.window.document.querySelectorAll('[data-detail-node]').length, 3);
  assert.equal(dom.window.document.querySelector('[data-detail-count]'), null);
  click(dom, '[data-action="clearFilter"]');
  assert.equal(dom.window.document.querySelectorAll('[data-detail-node]').length, 4);
  assert.match(dom.window.document.querySelector('[data-detail-node="gpu-node-1"]')?.textContent || '', /192\.168\.1\.101/);
  assert.match(dom.window.document.querySelector('[data-detail-node="gpu-node-1"]')?.textContent || '', /22/);
  assert.match(dom.window.document.querySelector('[data-detail-node="gpu-node-1"]')?.textContent || '', /admin/);
  assert.match(dom.window.document.querySelector('[data-detail-node="gpu-node-2"]')?.textContent || '', /gpu-node-2/);
  sendWebviewMessage(dom, {
    type: 'statusUpdate',
    message: '后台轮询完成',
    state: {
      configPath: '/tmp/taproot-nodes.localhost.yaml',
      defaults: { user: 'admin', port: '22', pwd: '', sudo: '', extra: {} },
      backend: { connected: true, message: 'taproot-mcp 已连接' },
      nodes: [
        {
          id: 2,
          name: 'dev-vm',
          host: '192.168.1.200',
          user: 'deploy',
          port: '2222',
          pwd: '',
          sudo: '',
          tags: ['dev'],
          status: 'error',
          error: 'silent failure',
          extra: {},
        },
      ],
    },
  });
  assert.match(dom.window.document.querySelector('[data-detail-node="dev-vm"]')?.textContent || '', /连接失败/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /后台轮询完成/);
  const detailContentBefore = dom.window.document.querySelector<HTMLElement>('.content');
  assert(detailContentBefore);
  detailContentBefore.scrollTop = 77;
  click(dom, '[data-action="toggleDetailNode"][data-node="dev-vm"]');
  const detailContentAfter = dom.window.document.querySelector<HTMLElement>('.content');
  assert(detailContentAfter);
  assert.equal(detailContentAfter.scrollTop, 77);
  assert.match(dom.window.document.querySelector('[data-detail-node="dev-vm"]')?.textContent || '', /暂无通过 taproot-mcp 执行的操作记录/);
  detailContentAfter.scrollTop = 64;
  click(dom, '[data-action="collapseAllDetailNodes"]');
  assert.equal(dom.window.document.querySelectorAll('.detail-node.open').length, 0);
  assert.equal((dom.window.document.querySelector<HTMLElement>('.content'))?.scrollTop, 64);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /执行 bash: nvidia-smi -L/);
  click(dom, '[data-action="expandAllDetailNodes"]');
  assert.equal(dom.window.document.querySelectorAll('.detail-node.open').length, 4);
  assert.equal((dom.window.document.querySelector<HTMLElement>('.content'))?.scrollTop, 64);
  const execSummary = dom.window.document.querySelector<HTMLElement>('[data-activity-id="mock-exec-1"] .activity-summary');
  assert(execSummary);
  assert.match(execSummary.textContent || '', /执行 bash/);
  assert.match(execSummary.textContent || '', /nvidia-smi -L/);
  assert.equal(dom.window.document.querySelector('.info-grid'), null);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /Host \/ IP/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /cluster_(exec|read_file|write_file)/);
  assert.equal(dom.window.document.querySelector('.activity-kind'), null);
  assert(dom.window.document.querySelector('.activity-title-label'));
  assert(dom.window.document.querySelector('.activity-title-text'));
  assert.equal(dom.window.document.querySelector('.activity-detail'), null);
  click(dom, '[data-activity-id="mock-exec-1"] .activity-summary');
  const expandedExec = dom.window.document.querySelector<HTMLElement>('[data-activity-id="mock-exec-1"]');
  assert(expandedExec);
  assert.doesNotMatch(expandedExec.querySelector<HTMLElement>('.activity-summary')?.textContent || '', /nvidia-smi -L/);
  assert.match(expandedExec.textContent || '', /命令/);
  assert.match(expandedExec.textContent || '', /nvidia-smi -L/);
  const gpuActivities = [...dom.window.document.querySelectorAll<HTMLElement>('[data-detail-node="gpu-node-1"] .activity-title')].map((item) => item.textContent || '');
  assert.match(gpuActivities[0], /写入文件/);
  assert.match(gpuActivities[0], /1\.txt/);
  assert.doesNotMatch(gpuActivities[0], /文件写入/);
  assert(gpuActivities.findIndex((item) => item.includes('写入文件') && item.includes('1.txt')) < gpuActivities.findIndex((item) => item.includes('读取文件') && item.includes('1.txt')));
  assert.doesNotMatch(dom.window.document.querySelector('[data-detail-node="gpu-node-1"]')?.textContent || '', /写入内容/);
  click(dom, '[data-activity-id="mock-write-1"] .activity-summary');
  const expandedWrite = dom.window.document.querySelector<HTMLElement>('[data-activity-id="mock-write-1"]');
  assert(expandedWrite);
  assert.match(expandedWrite.textContent || '', /写入内容/);
  assert.match(expandedWrite.textContent || '', /hi/);
  assert.equal(dom.window.document.querySelector('[data-action="recordUpload"]'), null);
  assert.equal(dom.window.document.querySelector('[data-action="recordDownload"]'), null);

  sendWebviewMessage(dom, { type: 'selectNode', nodeName: 'dev-vm' });
  assert.match(dom.window.document.body.textContent || '', /节点详情/);
  assert.match(dom.window.document.querySelector('[data-detail-node="dev-vm"]')?.textContent || '', /192\.168\.1\.200/);

  dispatchContextMenu(dom, '[data-node-row="dev-vm"]');
  clickByText(dom, '.menu-item', '在终端中 SSH 连接');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('终端执行 SSH 命令'));

  dispatchContextMenu(dom, '[data-node-row="dev-vm"]');
  assert.match(dom.window.document.body.textContent || '', /编辑节点配置/);
  clickByText(dom, '.menu-item', '刷新状态');
  const refreshMessage = [...postedMessages].reverse().find((item) => item.type === 'testNode');
  assert(refreshMessage);
  assert.equal(refreshMessage.nodeName, 'dev-vm');
  assert.equal(refreshMessage.state?.nodes.find((node: { name: string }) => node.name === 'dev-vm')?.status, 'checking');
  assert.notEqual(refreshMessage.state?.nodes.find((node: { name: string }) => node.name === 'gpu-node-1')?.status, 'checking');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('刷新完成：成功 1 / 共 1 个节点'));
  assert.doesNotMatch(dom.window.document.body.textContent || '', /已刷新 dev-vm|已测试 \d+ 个节点/);

  dispatchContextMenu(dom, '[data-node-row="dev-vm"]');
  clickByText(dom, '.menu-item', '复制 SSH 命令');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('已复制 SSH 命令'));

  const connectionMessagesBefore = postedMessages.filter((item) => item.type === 'testConnections').length;
  click(dom, '[data-action="refreshAll"]');
  await waitFor(() => postedMessages.filter((item) => item.type === 'testConnections').length > connectionMessagesBefore);
  const refreshAllMessage = [...postedMessages].reverse().find((item) => item.type === 'testConnections');
  assert(refreshAllMessage);
  assert(refreshAllMessage.state?.nodes.every((node: { status: string }) => node.status === 'checking'));
  await waitFor(() => (dom.window.document.body.textContent || '').includes('测试完成：成功'));

  scrolledCards.length = 0;
  sendWebviewMessage(dom, { type: 'selectNode', nodeName: 'dev-vm', view: 'config' });
  await waitFor(() => (dom.window.document.body.textContent || '').includes('节点配置编辑器') && scrolledCards.includes('4'));
  const configTabs = dom.window.document.querySelector<HTMLElement>('.tabs');
  assert(configTabs);
  assert.equal(configTabs.dataset.view, 'config');
  assert.equal(configTabs.dataset.transition, 'detail-config');
  const selectedConfigCard = dom.window.document.querySelector<HTMLElement>('[data-node-card-id="4"]');
  assert(selectedConfigCard);
  assert(selectedConfigCard.classList.contains('open'));
  assert.equal(dom.window.document.querySelectorAll('.node-card.open').length, 1);
  assert(dom.window.document.querySelector<HTMLElement>('[data-node-card-id="1"]')?.classList.contains('collapsed'));
  assert(dom.window.document.querySelector<HTMLInputElement>('input[data-bind="node"][data-id="4"][data-field="host"]'));
  assert(dom.window.document.querySelector('.content.view-transition'));
  const configTab = dom.window.document.querySelector<HTMLElement>('[data-action="showConfig"]');
  assert(configTab);
  assert.match(configTab.textContent || '', /节点配置/);
  assert.doesNotMatch(configTab.textContent || '', /nodes\.yaml/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /可视化编辑/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /保存后写回配置文件/);
  const configPage = dom.window.document.querySelector<HTMLElement>('.config-page');
  assert(configPage);
  assert.equal(configPage.querySelector('.page-head .backend-state'), null);
  const footer = dom.window.document.querySelector<HTMLElement>('.footer');
  assert(footer);
  assert.equal(footer.querySelector('.footer-actions-left'), null);
  assert.equal(footer.querySelector('[data-action="testAll"]'), null);
  assert.equal(footer.querySelector('[data-action="resetCfg"]'), null);
  assert(footer.querySelector('[data-action="saveCfg"]'));
  assert.doesNotMatch(dom.window.document.body.textContent || '', /全局默认值/);
  assert.equal(dom.window.document.querySelector('[data-bind="default"]'), null);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /继承默认值/);
  assert(dom.window.document.querySelector('.config-node-summary'));
  assert(dom.window.document.querySelectorAll('.node-card.collapsed').length >= 1);
  const collapsedCard = dom.window.document.querySelector<HTMLElement>('.node-card.collapsed');
  assert(collapsedCard);
  assert(collapsedCard.querySelector('.config-node-summary-wrap > .node-card-collapse .codicon-chevron-right'));
  assert.equal(collapsedCard.querySelector('.config-node-summary > .codicon-chevron-right'), null);
  const configContentBefore = dom.window.document.querySelector<HTMLElement>('.content');
  assert(configContentBefore);
  configContentBefore.scrollTop = 123;
  const firstCardBefore = dom.window.document.querySelector<HTMLElement>('[data-node-card-id="1"]');
  const secondCardBefore = dom.window.document.querySelector<HTMLElement>('[data-node-card-id="2"]');
  assert(firstCardBefore);
  assert(secondCardBefore);
  click(dom, '[data-action="toggleConfigNode"][data-id="2"]');
  const configContentAfterOpen = dom.window.document.querySelector<HTMLElement>('.content');
  assert(configContentAfterOpen);
  assert.equal(configContentAfterOpen, configContentBefore);
  assert.equal(dom.window.document.querySelector<HTMLElement>('[data-node-card-id="1"]'), firstCardBefore);
  assert.notEqual(dom.window.document.querySelector<HTMLElement>('[data-node-card-id="2"]'), secondCardBefore);
  assert.equal(configContentAfterOpen.scrollTop, 123);
  assert(dom.window.document.querySelector('.node-card.open > .config-node-summary-wrap > .node-card-collapse .codicon-chevron-down'));
  assert(dom.window.document.querySelector('.node-card.open > .config-node-summary-wrap > .config-node-summary'));
  assert(dom.window.document.querySelector<HTMLInputElement>('input[data-bind="node"][data-id="2"][data-field="name"]'));
  assert(dom.window.document.querySelector<HTMLInputElement>('input[data-bind="node"][data-id="2"][data-field="host"]'));
  configContentAfterOpen.scrollTop = 91;
  const secondCardOpen = dom.window.document.querySelector<HTMLElement>('[data-node-card-id="2"]');
  assert(secondCardOpen);
  click(dom, '[data-action="toggleConfigNode"][data-id="2"]');
  const configContentAfterClose = dom.window.document.querySelector<HTMLElement>('.content');
  assert(configContentAfterClose);
  assert.equal(configContentAfterClose, configContentBefore);
  assert.equal(dom.window.document.querySelector<HTMLElement>('[data-node-card-id="1"]'), firstCardBefore);
  assert.notEqual(dom.window.document.querySelector<HTMLElement>('[data-node-card-id="2"]'), secondCardOpen);
  assert.equal(configContentAfterClose.scrollTop, 91);
  assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[data-bind="node"][data-id="2"][data-field="host"]'), null);

  click(dom, '[data-action="toggleConfigNode"][data-id="1"]');
  assert(dom.window.document.querySelector<HTMLElement>('[data-node-card-id="1"]')?.classList.contains('open'));
  const firstHost = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="node"][data-id="1"][data-field="host"]');
  assert(firstHost);
  firstHost.click();
  assert.equal(dom.window.document.body.contains(firstHost), true);
  firstHost.focus();
  firstHost.value = 'localhost-edited';
  firstHost.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.activeElement, firstHost);
  assert.equal(firstHost.value, 'localhost-edited');

  const firstUser = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="node"][data-id="1"][data-field="user"]');
  assert(firstUser);
  firstUser.focus();
  firstUser.value = 'tester';
  firstUser.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(dom.window.document.activeElement, firstUser);
  assert.equal(firstUser.value, 'tester');

  const firstDraft = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="draft"][data-id="1"]');
  assert(firstDraft);
  const firstTagsBox = firstDraft.closest<HTMLElement>('.tags-box');
  assert(firstTagsBox);
  firstTagsBox.click();
  assert.equal(dom.window.document.activeElement, firstDraft);
  firstHost.focus();
  assert.equal(dom.window.document.activeElement, firstHost);
  firstTagsBox.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(dom.window.document.activeElement, firstDraft);
  firstDraft.value = 'newtag';
  firstDraft.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  firstDraft.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.match(dom.window.document.body.textContent || '', /newtag/);
  const newTagRemove = [...dom.window.document.querySelectorAll<HTMLElement>('[data-action="removeTag"][data-id="1"]')]
    .at(-1);
  assert(newTagRemove);
  newTagRemove.click();
  assert.doesNotMatch(dom.window.document.body.textContent || '', /newtag/);

  click(dom, '[data-action="addNode"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('节点 (5)'));
  assert.match(dom.window.document.body.textContent || '', /节点 \(5\)/);
  await waitFor(() => (dom.window.document.activeElement as HTMLElement | null)?.dataset?.field === 'name');
  const pendingNameInput = dom.window.document.activeElement as HTMLInputElement;
  assert.equal(pendingNameInput.dataset.id, '5');

  click(dom, '[data-action="addNode"]');
  await waitFor(() => (dom.window.document.activeElement as HTMLElement | null)?.dataset?.id === '5');
  assert.match(dom.window.document.body.textContent || '', /节点 \(5\)/);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /节点 \(6\)/);
  assert.equal(dom.window.document.querySelectorAll('.node-card').length, 5);

  const newestHost = [...dom.window.document.querySelectorAll<HTMLInputElement>('input[data-bind="node"][data-field="host"]')].at(-1);
  assert(newestHost);
  newestHost.value = 'localhost';
  newestHost.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const saveContentBefore = dom.window.document.querySelector<HTMLElement>('.content');
  assert(saveContentBefore);
  saveContentBefore.scrollTop = 456;
  click(dom, '[data-action="saveCfg"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('已保存 nodes.yaml'));
  const saveContentAfter = dom.window.document.querySelector<HTMLElement>('.content');
  assert(saveContentAfter);
  assert.equal(saveContentAfter.scrollTop, 456);

  click(dom, '[data-action="deleteNode"][data-id="5"]');
  assert.match(dom.window.document.body.textContent || '', /节点 \(4\)/);

  click(dom, '[data-action="showDetail"]');
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 4);
  const detailTabs = dom.window.document.querySelector<HTMLElement>('.tabs');
  assert(detailTabs);
  assert.equal(detailTabs.dataset.view, 'detail');
  assert.equal(detailTabs.dataset.transition, 'config-detail');

  dom.window.close();
});

function click(dom: JSDOM, selector: string): void {
  const element = dom.window.document.querySelector<HTMLElement>(selector);
  assert(element, `missing ${selector}`);
  element.click();
}

function clickByText(dom: JSDOM, selector: string, text: string): void {
  const element = [...dom.window.document.querySelectorAll<HTMLElement>(selector)].find((item) =>
    (item.textContent || '').includes(text),
  );
  assert(element, `missing ${selector} with text ${text}`);
  element.click();
}

function dispatchContextMenu(dom: JSDOM, selector: string): void {
  const element = dom.window.document.querySelector<HTMLElement>(selector);
  assert(element, `missing ${selector}`);
  element.dispatchEvent(
    new dom.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 160,
    }),
  );
}

function dispatchMouseOver(dom: JSDOM, selector: string): void {
  const element = dom.window.document.querySelector<HTMLElement>(selector);
  assert(element, `missing ${selector}`);
  element.dispatchEvent(
    new dom.window.MouseEvent('mouseover', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 160,
    }),
  );
}

function sendWebviewMessage(dom: JSDOM, data: unknown): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for condition');
}

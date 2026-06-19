import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';

const root = path.resolve(__dirname, '..', '..');

test('dashboard webview supports filter, add, save, and test interactions', async () => {
  const html = await readFile(path.join(root, 'test', 'harness.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: pathToFileURL(path.join(root, 'test', 'harness.html')).toString(),
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  await waitFor(() => dom.window.document.body.textContent?.includes('节点配置编辑器'));

  assert.match(dom.window.document.body.textContent || '', /gpu-node-1/);
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 4);

  click(dom, '[data-action="theme"][data-value="light"]');
  assert.equal(dom.window.document.querySelector('.shell')?.getAttribute('data-theme'), 'light');
  click(dom, '[data-action="theme"][data-value="dark"]');
  assert.equal(dom.window.document.querySelector('.shell')?.getAttribute('data-theme'), 'dark');

  click(dom, '[data-action="statusStyle"][data-value="icon"]');
  assert(dom.window.document.querySelector('[data-node-row] .status-icon'));
  click(dom, '[data-action="statusStyle"][data-value="bar"]');
  assert.equal(dom.window.document.querySelector('[data-node-row] .status-dot'), null);
  click(dom, '[data-action="statusStyle"][data-value="dot"]');
  assert(dom.window.document.querySelector('[data-node-row] .status-dot'));

  click(dom, '[data-action="toggleFilter"]');
  clickByText(dom, '.filter-option', 'vllm');
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 3);
  assert.match(dom.window.document.body.textContent || '', /过滤: vllm/);

  click(dom, '[data-action="clearFilter"]');
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 4);

  click(dom, '[data-node-row="gpu-node-1"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('ssh -p 22 admin@192.168.1.101'));
  click(dom, '[data-action="copySsh"][data-node="gpu-node-1"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('已复制 SSH 命令'));
  click(dom, '[data-action="openTerminal"][data-node="gpu-node-1"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('终端执行 SSH 命令'));

  dispatchContextMenu(dom, '[data-node-row="dev-vm"]');
  assert.match(dom.window.document.body.textContent || '', /编辑节点配置/);
  clickByText(dom, '.menu-item', '复制 SSH 命令');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('已复制 SSH 命令'));

  click(dom, '[data-action="showConfig"]');
  const defaultPwd = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="default"][data-field="pwd"]');
  assert(defaultPwd);
  assert.equal(defaultPwd.type, 'password');
  click(dom, '[data-action="toggleSecret"][data-key="defaultPwd"]');
  const defaultPwdShown = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="default"][data-field="pwd"]');
  assert(defaultPwdShown);
  assert.equal(defaultPwdShown.type, 'text');

  const firstDraft = dom.window.document.querySelector<HTMLInputElement>('input[data-bind="draft"][data-id="1"]');
  assert(firstDraft);
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
  await waitFor(() => (dom.window.document.body.textContent || '').includes('new-node-5'));
  assert.match(dom.window.document.body.textContent || '', /节点 \(5\)/);

  const newestHost = [...dom.window.document.querySelectorAll<HTMLInputElement>('input[data-bind="node"][data-field="host"]')].at(-1);
  assert(newestHost);
  newestHost.value = 'localhost';
  newestHost.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  click(dom, '[data-action="saveCfg"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('已保存 nodes.yaml'));

  click(dom, '[data-action="testAll"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('已测试 5 个节点'));
  assert.match(dom.window.document.body.textContent || '', /Connection refused/);

  click(dom, '[data-action="deleteNode"][data-id="5"]');
  assert.doesNotMatch(dom.window.document.body.textContent || '', /new-node-5/);

  click(dom, '[data-action="resetCfg"]');
  await waitFor(() => (dom.window.document.body.textContent || '').includes('gpu-node-1'));
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 4);

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

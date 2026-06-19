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

  click(dom, '[data-action="toggleFilter"]');
  clickByText(dom, '.filter-option', 'vllm');
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 3);
  assert.match(dom.window.document.body.textContent || '', /过滤: vllm/);

  click(dom, '[data-action="clearFilter"]');
  assert.equal(dom.window.document.querySelectorAll('[data-node-row]').length, 4);

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

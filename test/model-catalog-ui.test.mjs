import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
function setup(fetchImpl) {
  const state = { models: [], health: {}, apiKey: 'fixture' };
  const context = { S: state, rawApi: fetchImpl, document: { hidden: false }, $: () => ({}),
    esc: String, renderModels() {}, renderAccounts() {}, renderKeys() {}, renderUsageModels() {}, syncColumnBottoms() {} };
  vm.runInNewContext(`const MODEL_TIER_LABELS = {};
    ${source.slice(source.indexOf('const MODEL_DISPLAY ='), source.indexOf('function poolResetAt'))}
    globalThis.api = { applyModelCatalog, loadModelCatalog, refreshModelCatalogQuietly, isHiddenModelId };`, context);
  return { ...context.api, state, document: context.document };
}
const muse = 'meta/muse-spark-1.3-contributor';
const snapshot = (revision, ids = [muse], serviceOnlyModels = []) => ({
  data: ids.map(id => ({ id })), serviceOnlyModels, pausedModels: [], godOnlyModels: [], hidden_models: [],
  catalog: { revision, updatedAt: 1, stale: false },
});

test('旧响应晚到不能覆盖新目录和已解除的隐藏名单', async () => {
  const pending = [];
  const api = setup(url => {
    assert.equal(url, '/v1/models?refresh=1');
    return new Promise(resolve => pending.push(resolve));
  });
  const older = api.loadModelCatalog(true);
  const newer = api.loadModelCatalog(true);
  pending[1](snapshot(200)); await newer;
  pending[0](snapshot(100, ['mimo/mimo-v2.5'], [muse]));
  assert.equal(await older, null);
  assert.equal(api.state.models[0].id, muse);
  assert.equal(api.isHiddenModelId(muse), false);
});

test('先发起的强刷完成得更晚时，仍能发布比中途缓存更新的版本', async () => {
  const pending = [];
  const api = setup(() => new Promise(resolve => pending.push(resolve)));
  const refreshing = api.loadModelCatalog(true);
  const cached = api.loadModelCatalog(true);
  pending[1](snapshot(100, ['mimo/mimo-v2.5'])); await cached;
  pending[0](snapshot(200)); await refreshing;
  assert.equal(api.state.models[0].id, muse);
});

test('拉取失败或无效目录不能清空现有模型和控制名单', async () => {
  const api = setup(async () => { throw new Error('temporary failure'); });
  api.applyModelCatalog(snapshot(100));
  await assert.rejects(api.loadModelCatalog(true), /temporary failure/);
  assert.equal(api.applyModelCatalog({ error: 'bad response' }), false);
  const incomplete = snapshot(200, ['mimo/mimo-v2.5']);
  delete incomplete.godOnlyModels;
  assert.equal(api.applyModelCatalog(incomplete), false);
  assert.equal(api.state.models[0].id, muse);
});

test('旧模型快照即使响应编号更高，也不能覆盖已发布的新源版本', () => {
  const api = setup(async () => snapshot(100));
  const fresh = snapshot(100);
  fresh.catalog.updatedAt = 2000;
  api.applyModelCatalog(fresh);
  const old = snapshot(200, ['mimo/mimo-v2.5'], [muse]);
  old.catalog.updatedAt = 1000;
  assert.equal(api.applyModelCatalog(old), false);
  assert.equal(api.state.models[0].id, muse);
});

test('官方清空 God-only 名单后，前端不再永久写死旧型号', () => {
  const api = setup(async () => snapshot(100));
  assert.equal(api.isHiddenModelId('crof/kimi-k3-eco'), true);
  api.applyModelCatalog(snapshot(100));
  assert.equal(api.isHiddenModelId('crof/kimi-k3-eco'), false);
  assert.equal(api.isHiddenModelId('openai/gpt-5.6-luna-es'), false);
});

test('独立轮询只读取模型目录，后台页面暂停轮询', async () => {
  const urls = [];
  const api = setup(async url => { urls.push(url); return snapshot(100); });
  await api.refreshModelCatalogQuietly();
  assert.deepEqual(urls, ['/v1/models']);
  api.document.hidden = true;
  await api.refreshModelCatalogQuietly();
  assert.equal(urls.length, 1);
  assert.match(source, /const MODEL_POLL_MS = 60000/);
  assert.match(source, /setInterval\(refreshModelCatalogQuietly, MODEL_POLL_MS\)/);
  assert.match(source, /if \(!modelCatalogLoaded\)\s*\{\s*setServiceOnlyModels\(cfg\.serviceOnlyModels\)/);
});

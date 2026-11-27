const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const control = vm.runInNewContext(readFileSync(require.resolve('../pronunciation.js'), 'utf8') +
  '\npronunciationControl', { window: {} });

test('sends the exact source word and ignores replies for superseded playback', async () => {
  const requests = [];
  const call = (method, data) => new Promise(resolve => requests.push({method, data, resolve}));
  const button = {setAttribute() {}}, status = {}, install = {};
  const speech = control(button, status, install, call);
  speech.select('habló', 'es', 'Spanish');
  const first = button.onclick(), replay = button.onclick();
  assert.deepEqual(requests.map(r => [r.method, r.data.text, r.data.language]),
    [['speech.speak', 'habló', 'es'], ['speech.speak', 'habló', 'es']]);
  requests[1].resolve('missing-voice');
  await replay;
  assert.equal(install.hidden, false);
  assert.equal(install.textContent, 'Install Spanish voice');
  const installing = install.onclick();
  assert.equal(requests[2].method, 'speech.installVoices');
  requests[2].resolve(true);
  await installing;
  speech.clear();
  speech.select('otros', 'es', 'Spanish');
  requests[0].resolve('missing-voice');
  await first;
  assert.equal(install.hidden, true);
  assert.equal(status.textContent, '');
  const next = button.onclick();
  speech.clear();
  assert.equal(requests[4].method, 'speech.stop');
  requests[3].resolve('stopped');
  requests[4].resolve(true);
  await next;
  assert.equal(button.hidden, true);
});

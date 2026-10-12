import { Worker } from 'node:worker_threads';
import { runInNewContext } from 'node:vm';

/** Execute the emitted browser Worker bytes on a separate thread, through its real message boundary. */
export async function runInnerWorker(compiled, script, { onMessage, ...options } = {}) {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = globalThis;
    globalThis.location = { href: 'https://fixture.test/' };
    self.postMessage = value => parentPort.postMessage(value);
    parentPort.on('message', data => self.onmessage({ data }));
    ${compiled}
  `, { eval: true, execArgv: [] });
  const events = [];
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('inner worker fixture timed out')), 10_000);
      worker.once('error', reject);
      worker.on('message', message => {
        events.push(message);
        if (message.type === 'result') resolve(message.result);
        else Promise.resolve().then(() => onMessage?.(message, value => worker.postMessage(value))).catch(reject);
      });
      worker.postMessage({ type: 'execute', source: script, ...options });
    });
    return { result, events };
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

/** Capture the exact Blob passed to Worker by the compiled (possibly minified) sandbox. */
export function sandboxFixture(compiled) {
  const workers = [];
  const messages = [];
  const blobs = new Map();
  const parent = { postMessage: message => messages.push(message) };
  let receive;
  class WorkerStub {
    constructor(url) { this.source = blobs.get(url); this.sent = []; this.terminated = false; workers.push(this); }
    postMessage(message) { this.sent.push(message); }
    terminate() { this.terminated = true; }
  }
  runInNewContext(compiled, {
    parent, window: { addEventListener: (_type, callback) => { receive = callback; } },
    Blob: class { constructor(parts) { this.source = parts.join(''); } }, Worker: WorkerStub,
    URL: { createObjectURL(blob) { const id = String(blobs.size); blobs.set(id, blob.source); return id; }, revokeObjectURL() {} },
    setTimeout(callback) { callback(); },
  });
  return {
    workers, messages,
    send(data, source = parent) { receive({ source, data: { source: 'qz-inner-runner-host', ...data } }); },
  };
}

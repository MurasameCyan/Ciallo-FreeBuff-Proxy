import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function clientAbortError() {
  const error = new Error('client disconnected');
  error.name = 'AbortError';
  return error;
}

export function bindClientAbort(nodeReq, nodeRes) {
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted || nodeRes.writableEnded || nodeRes.writableFinished) return;
    controller.abort(clientAbortError());
  };
  const onRequestClose = () => {
    if (!nodeReq.complete) abort();
  };
  const onResponseClose = () => {
    if (!nodeRes.writableEnded && !nodeRes.writableFinished) abort();
  };
  nodeReq.once('aborted', abort);
  nodeReq.once('error', abort);
  nodeReq.once('close', onRequestClose);
  nodeRes.once('error', abort);
  nodeRes.once('close', onResponseClose);
  return {
    signal: controller.signal,
    dispose() {
      nodeReq.removeListener('aborted', abort);
      nodeReq.removeListener('error', abort);
      nodeReq.removeListener('close', onRequestClose);
      nodeRes.removeListener('error', abort);
      nodeRes.removeListener('close', onResponseClose);
    },
  };
}

export async function forwardWorkerRequest(nodeReq, nodeRes, handler, workerEnv) {
  const client = bindClientAbort(nodeReq, nodeRes);
  try {
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    if (client.signal.aborted) throw client.signal.reason;
    const body = Buffer.concat(chunks);
    const host = nodeReq.headers.host || 'localhost';
    const request = new Request(`http://${host}${nodeReq.url}`, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: body.length > 0 ? body : null,
      signal: client.signal,
    });
    const response = await handler.fetch(request, workerEnv);
    if (client.signal.aborted || nodeRes.destroyed) {
      try { await response.body?.cancel(client.signal.reason); } catch {}
      return;
    }
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      try {
        await pipeline(Readable.fromWeb(response.body), nodeRes);
      } catch {
        // pipeline propagates client disconnect to the worker response body.
      }
    }
    if (!nodeRes.writableEnded && !nodeRes.destroyed) nodeRes.end();
  } finally {
    client.dispose();
  }
}

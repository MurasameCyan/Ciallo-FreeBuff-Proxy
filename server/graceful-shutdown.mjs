export function closeHttpServer(server, { forceAfterMs = 5000, cleanupGraceMs = 1000 } = {}) {
  if (!server?.listening) return Promise.resolve();
  const forceDelay = Math.max(0, Number(forceAfterMs) || 0);
  const cleanupDelay = Math.max(0, Number(cleanupGraceMs) || 0);

  return new Promise((resolve, reject) => {
    let settled = false;
    let forced = false;
    let forceTimer = null;
    let cleanupTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      resolve();
    };

    try {
      server.close(() => {
        // closeAllConnections() also fires this callback. In the forced path,
        // wait for stream/socket cleanup callbacks before the final flush.
        if (!forced) finish();
      });
      forceTimer = setTimeout(() => {
        forced = true;
        try { server.closeAllConnections?.(); } catch {}
        cleanupTimer = setTimeout(finish, cleanupDelay);
      }, forceDelay);
    } catch (error) {
      reject(error);
    }
  });
}

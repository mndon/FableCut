"use strict";

async function withDeadline(timeout, signal, action) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, timeout));
  try { return await action(controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
async function withCancellation(action) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try { return await action(controller.signal); }
  finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
module.exports = { withDeadline, withCancellation };

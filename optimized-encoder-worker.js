/* Encode immutable compositor snapshots away from the browser's frame clock. */
"use strict";
let canvas, context, queue = Promise.resolve();
self.onmessage = ({ data: { id, bitmap } }) => {
  queue = queue.then(async () => {
    try {
      if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height); context = canvas.getContext("2d");
      }
      context.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
      self.postMessage({ id, blob });
    } catch (e) { self.postMessage({ id, error: e.message }); }
    finally { bitmap.close(); }
  });
};

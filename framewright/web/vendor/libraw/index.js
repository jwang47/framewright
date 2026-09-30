// LibRaw-Wasm wrapper, with bounded requests and worker failure cleanup.
export default class LibRaw {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 0;
    this.tail = Promise.resolve();
    this.disposed = false;
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data?.id);
      if (!request) return;
      this.pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.out);
    };
    this.worker.onerror = event => {
      event.preventDefault?.();
      this.dispose(new Error(`RAW decoder worker failed: ${event.message || 'worker stopped'}`));
    };
    this.worker.onmessageerror = () => this.dispose(new Error('RAW decoder returned an unreadable response'));
  }

  dispose(error = new Error('LibRaw disposed')) {
    if (this.disposed) return;
    this.disposed = true;
    this.failure = error;
    this.worker.terminate();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  runFn(fn, ...args) {
    const run = () => new Promise((resolve, reject) => {
      if (this.disposed) { reject(this.failure); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.dispose(new Error(`RAW decoder timed out during ${fn}; click the photo to retry`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const transfers = args.filter(a => ArrayBuffer.isView(a) && !(a instanceof DataView)).map(a => a.buffer);
        this.worker.postMessage({ id, fn, args }, transfers);
      } catch (error) {
        this.dispose(error);
      }
    });
    const result = this.tail.then(run, run);
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  async open(bytes, settings) { return this.runFn('open', bytes, settings); }
  async metadata(full) {
    const meta = await this.runFn('metadata', !!full);
    if (Object.hasOwn(meta || {}, 'thumb_format')) {
      meta.thumb_format = ['unknown', 'jpeg', 'bitmap', 'bitmap16', 'layer', 'rollei', 'h265'][meta.thumb_format] || 'unknown';
    }
    if (Object.hasOwn(meta || {}, 'desc')) meta.desc = String(meta.desc).trim();
    if (Object.hasOwn(meta || {}, 'timestamp')) meta.timestamp = new Date(meta.timestamp * 1000);
    return meta;
  }
  async imageData() { return this.runFn('imageData'); }
  async rawImageData() { return this.runFn('rawImageData'); }
  async thumbnailData() { return this.runFn('thumbnailData'); }
}

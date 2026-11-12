/*
 * 共用 ffmpeg.wasm 載入器：window.FFKit
 *   FFKit.load(onProgress) -> Promise<FFmpeg>   只會載入一次（約 32MB，瀏覽器會快取）
 *   FFKit.mount(file) -> Promise<string>        以 WORKERFS 掛載來源檔，不複製進記憶體；回傳 ffmpeg 可讀的路徑
 *   FFKit.unmount()
 *   FFKit.run(args, durationSec, onProgress) -> Promise<void>   執行指令並回報進度，失敗時錯誤訊息附上 ffmpeg 最後幾行 log
 *   FFKit.read(name, mime) -> Promise<Blob>     讀出輸出檔並刪除
 *   FFKit.probeDuration(file) -> Promise<number> 用 <video> 讀時長（秒），失敗回傳 NaN
 *
 * 必要條件（已驗證）：@ffmpeg/ffmpeg 0.12.15 的 ESM 版放在同源 vendor/ffmpeg/，
 * 核心使用 CDN 的 ESM 版 @ffmpeg/core 0.12.10。UMD 版 + classWorkerURL 必定失敗。
 */
(function (root) {
  'use strict';

  var CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
  var WASM_SIZE_HINT = 32232419;
  var MOUNT_DIR = '/input';

  function vendorUrl() {
    // 工具頁位於 tools/<id>/，vendor 位於站台根目錄
    var s = document.querySelector('script[src*="assets/ffmpeg-kit.js"]');
    return new URL('../vendor/ffmpeg/index.js', s ? s.src : document.baseURI).href;
  }

  var ffmpeg = null, loading = null, logTail = [];

  function fetchToBlobURL(url, mime, onProgress) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('下載失敗（' + res.status + '）');
      var total = Number(res.headers.get('content-length')) || WASM_SIZE_HINT;
      if (!res.body || !onProgress) return res.arrayBuffer();
      var reader = res.body.getReader(), chunks = [], received = 0;
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var out = new Uint8Array(received), off = 0;
            chunks.forEach(function (c) { out.set(c, off); off += c.length; });
            return out.buffer;
          }
          chunks.push(r.value); received += r.value.length;
          onProgress(Math.min(1, received / total));
          return pump();
        });
      })();
    }).then(function (buf) { return URL.createObjectURL(new Blob([buf], { type: mime })); });
  }

  function load(onProgress) {
    if (loading) return loading;
    loading = Promise.all([
      import(vendorUrl()),
      fetchToBlobURL(CORE_BASE + '/ffmpeg-core.wasm', 'application/wasm', onProgress)
    ]).then(function (r) {
      var ff = new r[0].FFmpeg();
      ff.on('log', function (e) { logTail.push(e.message); if (logTail.length > 40) logTail.shift(); });
      return ff.load({ coreURL: CORE_BASE + '/ffmpeg-core.js', wasmURL: r[1] }).then(function () { ffmpeg = ff; return ff; });
    });
    loading.catch(function () { loading = null; });
    return loading;
  }

  function mount(file) {
    var m = /\.([a-z0-9]+)$/i.exec(file.name);
    var name = 'in.' + (m ? m[1].toLowerCase() : 'bin');
    var wrapped = new File([file], name, { type: file.type });
    return unmount().then(function () { return ffmpeg.createDir(MOUNT_DIR).catch(function () {}); })
      .then(function () { return ffmpeg.mount('WORKERFS', { files: [wrapped] }, MOUNT_DIR); })
      .then(function () { return MOUNT_DIR + '/' + name; });
  }

  function unmount() {
    if (!ffmpeg) return Promise.resolve();
    return ffmpeg.unmount(MOUNT_DIR).catch(function () {}).then(function () { return ffmpeg.deleteDir(MOUNT_DIR).catch(function () {}); });
  }

  function run(args, durationSec, onProgress) {
    logTail = [];
    var onProg = function (e) {
      if (!onProgress) return;
      if (durationSec > 0 && e.time > 0) onProgress(Math.min(1, e.time / 1e6 / durationSec));
      else if (e.progress >= 0 && e.progress <= 1) onProgress(e.progress);
    };
    ffmpeg.on('progress', onProg);
    return ffmpeg.exec(args).then(function (code) {
      ffmpeg.off('progress', onProg);
      if (code !== 0) {
        var err = new Error('FFmpeg 處理失敗（代碼 ' + code + '）');
        err.log = logTail.slice(-8).join('\n');
        throw err;
      }
    }, function (e) { ffmpeg.off('progress', onProg); throw e; });
  }

  function read(name, mime) {
    return ffmpeg.readFile(name).then(function (data) {
      return ffmpeg.deleteFile(name).catch(function () {}).then(function () { return new Blob([data], { type: mime }); });
    });
  }

  function probeDuration(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var v = document.createElement(/^audio\//.test(file.type) ? 'audio' : 'video');
      var finish = function (d) { URL.revokeObjectURL(url); resolve(d); };
      v.preload = 'metadata';
      v.onloadedmetadata = function () { finish(Number.isFinite(v.duration) ? v.duration : NaN); };
      v.onerror = function () { finish(NaN); };
      setTimeout(function () { finish(NaN); }, 8000);
      v.src = url;
    });
  }

  root.FFKit = { load: load, mount: mount, unmount: unmount, run: run, read: read, probeDuration: probeDuration, get instance() { return ffmpeg; } };
})(self);

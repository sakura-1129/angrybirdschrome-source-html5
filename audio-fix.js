// audio-fix.js
// 老版《愤怒的小鸟 Chrome》音频修复补丁（无任何界面元素）
// 措施：
//   1. 修正存档 cookie EPRQ 中的 soundsOff 静音标记（不覆盖玩家进度）
//   2. 包装 HTMLMediaElement.play()：被自动播放策略拒绝时，排队到首次交互后自动重试
//   3. 首次用户交互时播放一段静音音频，提前解锁页面音频通道
// 回滚：删除 index.html 中引用本文件的 <script> 即可，游戏本体未改动。
(function () {
  'use strict';

  var COOKIE_NAME = 'EPRQ';

  /* ---------- 1. 修正存档中的静音标记 ---------- */
  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? m[1] : null;
  }

  function writeCookie(name, value) {
    try {
      if (location.protocol === 'file:') return;
      document.cookie = name + '=' + value + ';path=/;max-age=' + (60 * 60 * 24 * 365 * 5);
    } catch (e) {}
  }

  function fixSoundFlag() {
    var raw = readCookie(COOKIE_NAME);
    var data = null;

    if (raw) {
      try { data = JSON.parse(decodeURIComponent(raw)); } catch (e) {
        try { data = JSON.parse(raw); } catch (e2) { data = null; }
      }
      if (!data || typeof data !== 'object') return; // 读不懂就绝不覆盖，保护玩家进度
    } else {
      data = {};
    }

    var changed = false;
    if (data.soundsOff !== false) { data.soundsOff = false; changed = true; }
    if (data.soundModel && typeof data.soundModel === 'object' && data.soundModel.sounds === false) {
      data.soundModel.sounds = true; changed = true;
    }
    if (changed) {
      try { writeCookie(COOKIE_NAME, encodeURIComponent(JSON.stringify(data))); } catch (e) {}
    }
  }

  /* ---------- 2. 包装 play()，被拦截后重试 ---------- */
  var pendingPlays = [];

  function retryPending() {
    if (!pendingPlays.length) return;
    var list = pendingPlays.splice(0, pendingPlays.length);
    list.forEach(function (el) {
      try {
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    });
  }

  function installPlayHook() {
    if (!window.HTMLMediaElement || !HTMLMediaElement.prototype.play) return;

    var nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      var self = this;
      var result;
      try {
        result = nativePlay.apply(self, arguments);
      } catch (e) {
        if (pendingPlays.indexOf(self) === -1) pendingPlays.push(self);
        return Promise.reject(e);
      }
      if (result && typeof result.catch === 'function') {
        result.catch(function (err) {
          var name = err && err.name;
          if (name === 'NotAllowedError' || name === 'AbortError') {
            if (pendingPlays.indexOf(self) === -1) pendingPlays.push(self);
          }
        });
      }
      return result;
    };
  }

  /* ---------- 3. 首次交互解锁音频通道 ---------- */
  var unlocked = false;

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try {
      var silent = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
      silent.volume = 0.01;
      var p = silent.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
    setTimeout(retryPending, 60);
    setTimeout(retryPending, 400);
  }

  ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'].forEach(function (type) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  });

  installPlayHook();
  fixSoundFlag();
  document.addEventListener('DOMContentLoaded', fixSoundFlag);
})();

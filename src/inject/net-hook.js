/**
 * Page-context network hook (MAIN world, document_start).
 *
 * Chrome MV3 has no equivalent of Firefox's webRequest.filterResponseData(),
 * so we cannot read GraphQL response bodies from the service worker. Instead we
 * monkey-patch window.fetch and XMLHttpRequest in the page's own JS context and
 * forward the response text of Nextdoor GraphQL calls to the isolated-world
 * content script via window.postMessage.
 *
 * This script must run before Nextdoor's app code installs its own fetch usage,
 * which is why it is declared with "world": "MAIN" and "run_at": "document_start".
 */
(function () {
  'use strict';

  const TARGET = '/api/gql/';
  const SOURCE = 'ndm-net-hook';

  function post(phase, url, body) {
    try {
      window.postMessage({ source: SOURCE, phase: phase, url: url, body: body }, '*');
    } catch (_) {
      // Body too large / structured-clone failure — drop silently.
    }
  }

  // ----- window.fetch -----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (_) {}

      const isGql = url.indexOf(TARGET) !== -1;
      if (isGql) post('start', url);

      const promise = origFetch.apply(this, arguments);
      if (!isGql) return promise;

      return promise.then(function (response) {
        try {
          response
            .clone()
            .text()
            .then(function (body) { post('body', url, body); })
            .catch(function () {});
        } catch (_) {}
        return response;
      });
    };
  }

  // ----- XMLHttpRequest -----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__ndmUrl = url; } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__ndmUrl || '';
      if (url && url.indexOf(TARGET) !== -1) {
        post('start', url);
        this.addEventListener('load', function () {
          try {
            const rt = this.responseType;
            if (rt === '' || rt === 'text') {
              post('body', url, this.responseText);
            }
          } catch (_) {}
        });
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };

  // ----- Expanded-post id reader (React fiber, MAIN world only) -----
  // The isolated-world content script can't see React's __reactFiber$ expandos,
  // so it asks us for the currently-expanded post id. We walk the fiber up from
  // the "Close expanded post" button to the nearest post object.
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== 'ndm-get-expanded-id') return;

    var out = { type: 'ndExpandedId', reqId: d.reqId, postId: null, shareId: null };
    try {
      var start = document.querySelector('button[aria-label="Close expanded post"]');
      var fiberKey = start && Object.keys(start).find(function (k) {
        return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
      });
      var f = fiberKey ? start[fiberKey] : null;
      var depth = 0;
      while (f && depth < 60) {
        var p = f.memoizedProps;
        var pid = p && p.post && p.post.id != null ? String(p.post.id) : null;
        if (pid && (/^(post_|sharedPost_)/.test(pid) || /^\d+$/.test(pid))) {
          out.postId = pid;
          out.shareId = p.post.shareId || null;
          break;
        }
        f = f.return;
        depth++;
      }
    } catch (_) {}
    window.postMessage(out, '*');
  });
})();

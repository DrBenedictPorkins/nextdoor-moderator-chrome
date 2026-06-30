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

  // ----- Auto-vote bridge -----
  // The isolated-world content script can't POST to Nextdoor's GraphQL API
  // (wrong origin -> 403) and can't inject an inline <script> (page CSP blocks
  // it). So it postMessages a vote request here; this MAIN-world script runs
  // with the page's origin/cookies and is exempt from the page CSP.
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'ndm-vote-req') return;

    const reqId = d.reqId;
    (async function () {
      try {
        const csrfToken = document.cookie.split(';').map(function (c) { return c.trim(); })
          .find(function (c) { return c.startsWith('csrftoken='); })
          ?.split('=')[1];
        const headers = {
          'content-type': 'application/json',
          'x-csrftoken': csrfToken,
          'x-nd-train': window.RELEASE_TOKEN,
          'x-nd-uti': sessionStorage.getItem('ndas_tab_id'),
          'x-nd-request-locale': 'US',
        };
        await fetch('https://nextdoor.com/api/gql/ModerationChoicePage?', {
          method: 'POST', credentials: 'include',
          headers: Object.assign({}, headers, { 'x-nd-cts': String(Date.now()) }),
          body: JSON.stringify({
            operationName: 'ModerationChoicePage',
            variables: { contentId: d.contentId },
            extensions: { persistedQuery: { version: 1, sha256Hash: 'ff18fa078558a01359bdf38de65198827a769079fc46afcc32522d67ddf563bf' } },
          }),
        });
        const resp = await fetch('https://nextdoor.com/api/gql/SubmitModerationChoice?', {
          method: 'POST', credentials: 'include',
          headers: Object.assign({}, headers, { 'x-nd-cts': String(Date.now()) }),
          body: JSON.stringify({
            operationName: 'SubmitModerationChoice',
            variables: { contentId: d.contentId, choiceId: d.choiceId, notes: d.notes },
            extensions: { persistedQuery: { version: 1, sha256Hash: 'f567a86818f566d37cdbe574bdbc0c3ae539abdf3b7f2522c315307ff961fc75' } },
          }),
        });
        window.postMessage({ type: 'ndAutoVoteResult', reqId: reqId, success: resp.ok, status: resp.status }, '*');
      } catch (_) {
        window.postMessage({ type: 'ndAutoVoteResult', reqId: reqId, success: false, status: 0 }, '*');
      }
    })();
  });
})();

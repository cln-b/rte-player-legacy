/* jshint ignore:start */
// Let RTÉ's own account state, pairing screen and polling consume the response.
(function () {
    var config = window.__rteLoginHelper;
    if (!config || !config.url || !config.key) return;
    var helperUrl = config.url.replace(/\/+$/, '');
    var originalFetch = window.fetch;
    window.fetch = function (input, options) {
        var url = typeof input === 'string' ? input : input.url;
        var target = new URL(url, window.location.href);
        if (target.origin !== 'https://www.rte.ie' ||
                target.pathname !== '/servicelayer/api/idm/account/soip/login') {
            return originalFetch.apply(this, arguments);
        }
        var request = new Request(input, options);
        if (request.method !== 'POST') return originalFetch.apply(this, arguments);
        return request.text().then(function (body) {
            return originalFetch(helperUrl + target.pathname + target.search, {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'X-RTE-Helper-Key': config.key},
                body: body,
                credentials: 'omit',
                signal: request.signal
            });
        });
    };
}());

/* jshint ignore:end */

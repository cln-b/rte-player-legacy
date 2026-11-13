/* jshint ignore:start */
// The 2016 WebKit accepts a capture boolean but ignores the once option.
(function () {
    // Keep the most recent genuine VOD ad break and its last error on this TV.
    // There is no timer or network logger. Listeners exist only during a handoff.
    var latest = 'rte.lastAdHandoff', failure = 'rte.lastAdHandoffError';
    var events = ['ended', 'webkitneedkey', 'webkitkeymessage', 'webkitkeyadded', 'webkitkeyerror', 'error', 'timeupdate'];
    function note(trace, name, value, failed) {
        var entry = [Date.now() - trace.started, trace.phase, name];
        if (typeof value === 'number') entry.push(value);
        trace.events.push(entry);
        if (trace.events.length > 32) trace.events.shift();
        try {
            var record = JSON.stringify({started:trace.started, events:trace.events});
            window.localStorage.setItem(latest, record);
            if (failed) window.localStorage.setItem(failure, record);
        } catch (ignored) {}
    }
    function detach(trace) {
        if (trace.video) events.forEach(function (name) { trace.video.removeEventListener(name, trace.observe, false); });
        trace.video = null;
    }
    function stop(player) {
        if (player.rteAdTrace) detach(player.rteAdTrace);
        player.rteAdTrace = null;
    }
    function item(player, ad) {
        if (!player) return;
        var trace = player.rteAdTrace;
        if (ad && /\/series\/.*\/play(?:\/?[?#]|\/?$)/.test(window.location.hash)) {
            if (!trace || trace.phase === 'programme') {
                stop(player);
                trace = player.rteAdTrace = {started:Date.now(), events:[]};
            }
        } else if (!trace) return;
        trace.phase = ad ? 'ad' : 'programme';
        trace.previous = null;
        trace.advanced = 0;
        note(trace, 'selected');
    }
    function observeSource(player) {
        var trace = player.rteAdTrace, video = player.video;
        if (!trace || !video || trace.video === video) return;
        detach(trace);
        trace.video = video;
        trace.observe = function (event) {
            var name = event.type;
            if (name === 'timeupdate') {
                if (trace.phase !== 'programme') return;
                var now = Date.now(), clock = video.currentTime, before = trace.previous;
                if (before) {
                    var delta = clock - before.clock;
                    if (!video.seeking && delta > 0 && delta <= (now - before.ms) / 1000 + 0.5) trace.advanced += delta;
                    else trace.advanced = 0;
                }
                trace.previous = {clock:clock, ms:now};
                if (trace.advanced >= 8) {
                    note(trace, 'clock advanced', Math.floor(trace.advanced));
                    stop(player);
                }
            } else if (name === 'error') note(trace, name, video.error && video.error.code, true);
            else note(trace, name, event.message && event.message.byteLength, name === 'webkitkeyerror');
        };
        events.forEach(function (name) { video.addEventListener(name, trace.observe, false); });
    }
    function playerError(player, detail) {
        if (player.rteAdTrace && detail) note(player.rteAdTrace, 'player error', detail.code, true);
    }
    function endSource(player) {
        var source = player.rteSource;
        player.rteSource = null;
        if (source && source.canplay) source.video.removeEventListener('canplay', source.canplay, false);
        player.ADVClearEventListeners('');
    }

    function beginSource(player) {
        endSource(player);
        observeSource(player);
        return player.rteSource = {video: player.video};
    }

    function watchAd(player, source, type) {
        if (source !== player.rteSource || !player.checkStuck || !source.video) return;
        source.canplay = function () {
            source.video.removeEventListener('canplay', source.canplay, false);
            source.canplay = null;
            if (player.rteSource === source) player.ADVRegisterListeners(type || '');
        };
        source.video.addEventListener('canplay', source.canplay, false);
    }

    window.rteAdHandoff = {item:item, stop:stop, playerError:playerError, beginSource:beginSource, watchAd:watchAd, endSource:endSource};
}());

/* jshint ignore:end */

/* jshint ignore:start */
// Keep Next's routes in the fragment so Smart Hub never navigates away from the WGT.
(function () {
    var base = window.__rteBase;
    var routeOrigin = 'https://widget.invalid';
    var startupError = '';
    var livePath = '';
    var liveTimer;
    var hasPlayed = false;
    var lastVideoTime = null;
    var statusAction = '';
    var leavingPlayer = false;
    var episodeReturnPath = '';
    var lastReturnEvent = '';
    var lastReturnTime = 0;
    var returnKey = 0;
    var previousLive = '';
    var recoveryKey = 'rte.pendingLiveChannel';
    var recoveryEnabled = !!window.rteLive && typeof window.tizen !== 'undefined';
    var resume = null;

    // A warm channel switch can leave the hosted player blank before it
    // creates a video element. A fresh document runs RTÉ's normal startup.
    if (recoveryEnabled) {
        try {
            var pending = JSON.parse(window.sessionStorage.getItem(recoveryKey));
            window.sessionStorage.removeItem(recoveryKey);
            if (pending && /^\/live\/channel\/[A-Za-z0-9_-]+\/play$/.test(pending.path) &&
                    Date.now() >= pending.time && Date.now() - pending.time < 60000) resume = pending;
        } catch (ignored) {}
    }
    function resumeChannel() {
        if (!resume) return;
        if (Date.now() - resume.time > 90000) { resume = null; return; }
        var router = window.next && window.next.router;
        var path = route().pathname;
        if (router && path === base + '/home' && !resume.inGuide) {
            resume.inGuide = true;
            router.replace('/onnow');
        } else if (router && path === base + '/onnow' && resume.inGuide) {
            var buttons = document.querySelectorAll('button');
            for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].textContent.trim() === 'Watch Now') {
                    var destination = resume.path;
                    resume = null;
                    router.replace(destination);
                    return;
                }
            }
        }
        window.setTimeout(resumeChannel, 500);
    }
    if (resume) window.setTimeout(resumeChannel, 500);

    function retryBlankSwitch(path) {
        if (!recoveryEnabled || !previousLive || document.querySelector('video')) return false;
        var destination = path.slice(base.length).replace(/\/$/, '');
        if (!/^\/live\/channel\/[A-Za-z0-9_-]+\/play$/.test(destination)) return false;
        try {
            window.sessionStorage.setItem(recoveryKey, JSON.stringify({path:destination, time:Date.now()}));
            window.history.replaceState(null, '', window.location.href.split('#')[0]);
            window.location.reload();
            return true;
        } catch (ignored) { return false; }
    }

    function clearStatus() {
        var box = document.getElementById('rte-status');
        if (box) box.style.display = 'none';
        statusAction = '';
    }
    function monitorRoute() {
        var path = route().pathname;
        if (livePath === path) return;
        if (livePath) previousLive = livePath;
        clearTimeout(liveTimer);
        clearStatus();
        hasPlayed = false;
        lastVideoTime = null;
        livePath = /\/live\/channel\/[^/]+\/play\/?$/.test(path) ? path : '';
        if (livePath) {
            liveTimer = setTimeout(function () {
                if (!waitingForLive()) return;
                var app = document.getElementById('__next');
                if (app && app.innerText.trim()) {
                    showError('Press Back to return to the live guide.', 'back');
                } else if (!retryBlankSwitch(path)) {
                    showError('Live playback has not started. Press Back or OK for the live guide.', 'guide');
                }
            }, 15000);
        }
    }
    function waitingForLive() {
        var video = document.querySelector('video');
        return livePath && (!hasPlayed || (video && video.error));
    }
    function isPlayer(path) {
        return /\/play\/?$/.test(path);
    }
    function exitDestination() {
        if (livePath || statusAction === 'guide') return '/onnow';
        var current = route();
        if (!window.rteLive || !isPlayer(current.pathname)) return '';
        // A direct episode link has no previous catalogue page in this session.
        return episodeReturnPath || current.pathname.slice(base.length).replace(/\/play\/?$/, '') + current.search;
    }
    function handleReturn(event) {
        var destination = exitDestination();
        var router = window.next && window.next.router;
        var companion = lastReturnEvent && lastReturnEvent !== event.type && Date.now() - lastReturnTime < 300;
        // The catalogue, detail screens and dialogs use Vestel's Back key.
        var samsungBack = event.type === 'tizenhwkey' || event.keyCode === 10009;
        var forwardBack = !destination && window.rteLive && samsungBack;
        if (!router || (!destination && !companion && !forwardBack)) return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (companion) { lastReturnEvent = ''; return true; }
        if (leavingPlayer) return true;
        lastReturnEvent = event.type;
        lastReturnTime = Date.now();
        if (forwardBack) {
            var back = document.createEvent('Event');
            back.initEvent('keydown', true, true);
            Object.defineProperty(back, 'keyCode', {value:461});
            (event.target || document).dispatchEvent(back);
            return true;
        }
        leavingPlayer = true;
        var exit = window.rteWidget.exitPlayer;
        function failed() {
            leavingPlayer = false;
            if (destination === '/onnow') showError('Could not reopen the live guide. Press Back or OK to try again.', 'guide');
            else showError('Could not return to the programme. Press Return to try again.', 'back');
        }
        try {
            var navigation = exit ? exit(destination) : router.replace(destination);
            navigation.then(function () { leavingPlayer = false; }, failed);
        } catch (error) { failed(); }
        return true;
    }
    document.addEventListener('timeupdate', function (event) {
        var video = event.target;
        if (!livePath || video.tagName !== 'VIDEO' || video.readyState < 2 || video.seeking) return;
        // A live DASH clock can start at Unix time before a single frame is shown.
        var elapsed = lastVideoTime === null ? 0 : video.currentTime - lastVideoTime;
        lastVideoTime = video.currentTime;
        if (elapsed <= 0 || elapsed > 10 || video.error) return;
        hasPlayed = true;
        clearTimeout(liveTimer);
        if (statusAction === 'guide' || statusAction === 'back') clearStatus();
    }, true);
    document.addEventListener('error', function (event) {
        var video = event.target;
        if (!livePath || video.tagName !== 'VIDEO' || !video.error) return;
        clearTimeout(liveTimer);
        showError('Video playback stopped (media error ' + video.error.code + '). Press Back to return to the live guide.', 'back');
    }, true);
    window.addEventListener('popstate', monitorRoute);
    document.addEventListener('tizenhwkey', function (event) {
        if (event.keyName === 'back') {
            resume = null;
            handleReturn(event);
        }
    }, true);
    function route() {
        var fragment = window.location.hash.slice(1);
        return new URL(fragment.indexOf(base + '/') === 0 ? fragment : base + '/', routeOrigin);
    }
    function fit() {
        if (!document.body || !window.innerWidth || !window.innerHeight) return;
        var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
        var style = document.body.style;
        style.webkitTransformOrigin = style.transformOrigin = '0 0';
        style.webkitTransform = style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
        document.documentElement.style.overflow = 'hidden';
        if (scale <= 1280 / 1920) document.body.classList.add('lowres_monitor');
        else document.body.classList.remove('lowres_monitor');
    }
    document.addEventListener('DOMContentLoaded', fit);
    window.addEventListener('resize', fit);
    window.rteWidget = {
        fit: fit,
        clearStorage: function () {
            window.sessionStorage.clear();
            window.localStorage.clear();
            window.history.replaceState(null, '', window.location.href.split('#')[0]);
            window.location.reload();
        },
        label: function (key) {
            var labels = window.__rteFallbackLabels;
            return Object.prototype.hasOwnProperty.call(labels,key) ? labels[key] : key;
        },
        pattern: function (source, flags) {
            var compiled = window.__rtePatterns[source];
            if (compiled && typeof compiled[flags] === 'string')
                return new RegExp(compiled[flags], flags.replace('u', ''));
            return new RegExp(source, flags);
        },
        route: route,
        clock: function (timestamp, zone) {
            if (window.rteFullZoneFile && !window.moment.tz.zone(zone)) {
                // Only non-Irish guide clocks need the rest of the packaged time zones.
                var data = new XMLHttpRequest();
                data.open('GET', window.rteFullZoneFile, false);
                data.send(null);
                window.moment.tz.load(JSON.parse(data.responseText));
                window.rteFullZoneFile = '';
            }
            return window.moment.tz(timestamp, zone).format('HH:mm');
        },
        change: function (method, state, url) {
            var current = route();
            var path = new URL(url, current.href);
            if (isPlayer(path.pathname) && !isPlayer(current.pathname)) {
                var originPath = current.pathname.slice(base.length);
                episodeReturnPath = originPath && originPath !== '/' ? originPath + current.search : '';
            } else if (!isPlayer(path.pathname)) {
                episodeReturnPath = '';
            }
            window.history[method](state, '', '#' + path.pathname + path.search + path.hash);
            monitorRoute();
        },
        navigate: function (url) {
            var next = new URL(url, route().href);
            if (next.origin === routeOrigin) {
                // A failed Next route normally falls back to a server-rendered page.
                // The widget has no server; retain the app and expose the failure.
                showError('Could not load ' + next.pathname);
            } else {
                window.location.href = next.href;
            }
        }
    };
    function showError(message, action) {
        var box = document.getElementById('rte-status');
        if (box) {
            statusAction = action || 'restart';
            box.textContent = action ? message : message + ' — press OK to restart.';
            box.style.display = 'block';
        }
    }
    window.addEventListener('error', function (event) {
        if (event.message) startupError = String(event.message).split('?')[0].slice(0, 160);
    });
    window.setTimeout(function () {
        var ui = document.getElementById('__next');
        var text = ui ? ui.textContent.trim() : '';
        if (!livePath && (!text || /^ver:\s*[\d._]+$/.test(text))) {
            showError(startupError || 'RTÉ Player has not finished loading');
        }
    }, 45000);
    window.addEventListener('keydown', function (e) {
        if (resume) resume = null;
        var box = document.getElementById('rte-status');
        var back = e.keyCode === 10009 || e.keyCode === 8 || e.keyCode === 27;
        if ((back || (e.keyCode === 13 && statusAction === 'guide')) && handleReturn(e)) {
            returnKey = e.keyCode;
            return;
        }
        if (statusAction === 'restart' && e.keyCode === 13 && box && box.style.display === 'block') {
            e.preventDefault();
            e.stopImmediatePropagation();
            window.history.replaceState(null, '', window.location.href.split('#')[0]);
            window.location.reload();
        }
    }, true);
    window.addEventListener('keyup', function (e) {
        if (!returnKey || e.keyCode !== returnKey) return;
        returnKey = 0;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);
}());

/* jshint ignore:end */

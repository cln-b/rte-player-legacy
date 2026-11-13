/* jshint ignore:start */
// RTÉ's Vestel live player uses a DASH timeline anchored at the Unix epoch.
// The 2016 TV exposes its native playback clock as signed 32-bit milliseconds.
(function () {
    var video = document.createElement('video');
    var legacy = typeof window.tizen !== 'undefined' && typeof video.webkitGenerateKeyRequest === 'function' &&
        typeof navigator.requestMediaKeySystemAccess !== 'function';
    var day = 86400;
    var uint32 = 4294967296;
    var anchor = null;
    var channel = '';

    function active() {
        return legacy && /\/live\/channel\/[^/]+\/play\/?$/.test(location.hash.split('?')[0]);
    }

    function periodStart(value) {
        var match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || '');
        return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : NaN;
    }

    // Some feeds keep Period at zero and put the absolute clock in S@t.
    // DASH addresses segments by their original time or number. Moving the
    // presentationTimeOffset preserves those addresses and the media samples.
    function timelinePlan(period) {
        if (period.getElementsByTagName('SegmentList').length || period.getElementsByTagName('SegmentBase').length) return null;
        var templates = period.getElementsByTagName('SegmentTemplate');
        var plan = [], earliest = Infinity;
        for (var i = 0; i < templates.length; i++) {
            var template = templates[i];
            var segment = template.getElementsByTagName('S')[0];
            var scale = Number(template.getAttribute('timescale') || 1);
            var pto = Number(template.getAttribute('presentationTimeOffset') || 0);
            if (!segment || !segment.hasAttribute('t') || !(scale > 0) || !isFinite(pto)) return null;
            var first = (Number(segment.getAttribute('t')) - pto) / scale;
            if (!isFinite(first) || first < day * 365) return null;
            earliest = Math.min(earliest, first);
            plan.push({template: template, scale: scale, pto: pto});
        }
        return plan.length ? {first: earliest, tracks: plan} : null;
    }

    function manifest(mpd) {
        if (!active()) return;
        var route = location.hash.split('?')[0];
        if (route !== channel) {
            channel = route;
            anchor = null;
        }
        if (mpd.getAttribute('type') !== 'dynamic' || Date.parse(mpd.getAttribute('availabilityStartTime')) !== 0) return;
        var periods = mpd.getElementsByTagName('Period');
        if (!periods.length) return;
        var starts = [], timeline = null;
        for (var i = 0; i < periods.length; i++) {
            var start = periodStart(periods[i].getAttribute('start') || (i === 0 ? 'PT0S' : ''));
            if (periods.length === 1 && start === 0) timeline = timelinePlan(periods[i]);
            if (!timeline && (!isFinite(start) || start < day * 365)) return;
            starts.push(start);
        }
        var first = timeline ? timeline.first : Math.min.apply(null, starts);
        if (anchor === null) anchor = (Math.floor(first / day) - 1) * day;
        if (first < anchor) return;
        mpd.setAttribute('availabilityStartTime', new Date(anchor * 1000).toISOString());
        if (timeline) {
            timeline.tracks.forEach(function (track) {
                track.template.setAttribute('presentationTimeOffset', String(track.pto + anchor * track.scale));
            });
        } else {
            for (i = 0; i < periods.length; i++) {
                periods[i].setAttribute('start', 'PT' + (starts[i] - anchor).toFixed(6) + 'S');
            }
        }
    }

    function offset(buffer, seconds) {
        if (active() && anchor !== null) {
            buffer.rteOffset = seconds;
            buffer.timestampOffset = seconds + (buffer.rteShift || 0);
        } else {
            delete buffer.rteOffset;
            delete buffer.rteShift;
            buffer.timestampOffset = seconds;
        }
    }

    // Shaka supplies a separate SourceBuffer for each MP4 track. An init segment
    // gives its timescale in mdhd. Media fragments carry decode times in tfdt.
    function fragmentTimes(bytes, view, buffer) {
        var positions = [];
        function walk(start, end, depth) {
            if (depth > 5) return;
            for (var p = start; p + 8 <= end;) {
                var size = view.getUint32(p);
                if (!size) size = end - p;
                if (size < 8 || p + size > end) return;
                var kind = String.fromCharCode(bytes[p+4], bytes[p+5], bytes[p+6], bytes[p+7]);
                if (kind === 'mdhd') {
                    var field = p + (bytes[p+8] === 1 ? 28 : 20);
                    if (field + 4 <= p + size) buffer.rteScale = view.getUint32(field);
                } else if (kind === 'tfdt' && size >= 20 && bytes[p+8] === 1) {
                    positions.push(p + 12);
                } else if (kind === 'moov' || kind === 'trak' || kind === 'mdia' || kind === 'moof' || kind === 'traf') {
                    walk(p + 8, p + size, depth + 1);
                }
                p += size;
            }
        }
        walk(0, bytes.length, 0);
        return positions;
    }

    function append(buffer, data) {
        if (!active() || anchor === null || typeof buffer.rteOffset !== 'number') {
            buffer.appendBuffer(data);
            return;
        }
        var bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var positions = fragmentTimes(bytes, view, buffer);
        var scale = buffer.rteScale;
        if (positions.length && scale) {
            var candidate = Math.floor(-buffer.rteOffset / day) * day;
            var ticks = candidate * scale;
            var shift = 0;
            var times = positions.map(function (p) { return view.getUint32(p) * uint32 + view.getUint32(p + 4); });
            if (candidate > day * 365 && times.every(function (t) { return t >= ticks && t - ticks < scale * day * 30; })) {
                shift = candidate;
                var copy = new Uint8Array(bytes.length);
                copy.set(bytes);
                var output = new DataView(copy.buffer);
                positions.forEach(function (p, index) {
                    var relative = times[index] - ticks;
                    output.setUint32(p, Math.floor(relative / uint32));
                    output.setUint32(p + 4, relative % uint32);
                });
                data = copy;
            }
            if (buffer.rteShift !== shift) {
                buffer.rteShift = shift;
                buffer.timestampOffset = buffer.rteOffset + shift;
            }
        }
        buffer.appendBuffer(data);
    }

    window.rteLive = { legacyEme: legacy, active: active, manifest: manifest, offset: offset, append: append };
}());

/* jshint ignore:end */

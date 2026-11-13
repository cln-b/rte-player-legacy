import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseExpressionAt } from 'acorn';
import rewritePattern from 'regexpu-core';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';

const root = fileURLToPath(new URL('../', import.meta.url));
const brand = process.argv[2] || 'samsung';
const packages = {samsung:'RteOldSam1', vestel:'RteOldVst1', lg:'RteOldLg01', lg_lowres:'RteOldLg02'};
if (!Object.hasOwn(packages, brand)) throw new Error('Unknown brand');
const src = process.env.RTE_UPSTREAM_DIR ? path.resolve(root, process.env.RTE_UPSTREAM_DIR) : path.join(root, 'upstream', brand);
const out = path.join(root, 'build', brand);
const base = '/rpng-static/ctv/' + brand;
const id = packages[brand];
const icon = brand === 'vestel' ? 'rte-banner.png' : 'icon.png';
const label = 'RTÉ Player' + (brand === 'samsung' || brand === 'vestel' ? '' : ' (' + brand + ')');
const helperFile = path.join(root, '.local/login-helper.json');
const loginHelper = brand === 'vestel' && process.env.RTE_PUBLIC_BUILD === '1' ? {url: '', key: ''} :
    brand === 'vestel' && fs.existsSync(helperFile) ? JSON.parse(fs.readFileSync(helperFile, 'utf8')) : null;
function once(text, from, to) {
    if (text.split(from).length !== 2) throw new Error('Unexpected upstream runtime: ' + from);
    return text.replace(from,to);
}
function legacyJS(text, name) {
    if (brand === 'vestel' && text.includes('FAILED_TO_GENERATE_LICENSE_REQUEST:6006')) {
        // On EME 0.1b the two tracks signal when the hardware is ready. The
        // manifest's earlier init data still identifies the selected DRM system.
        const signal = 'Pr(e,t.initDataType,Re(t.initData))';
        text = once(text,'Nr(n),t||n.B.length||n.h.parseInbandPsshEnabled||n.s.C',
            'Nr(n),(t||n.h.parseInbandPsshEnabled)&&!window.rteLive.legacyEme||n.B.length||n.s.C');
        text = once(text,signal+',x(n)',
            '(window.rteLive.legacyEme&&e.g.initData&&e.g.initData.length?' +
            'e.g.initData.forEach(function(item){Pr(e,item.initDataType,item.initData,true)}):' +
            'Pr(e,t.initDataType,Re(t.initData),true)),x(n)');
        text = once(text,'function Pr(e,t,n){if(n.length){',
            'function Pr(e,t,n,fromMedia){var legacy=window.rteLive.legacyEme,pending=0;' +
            'if(legacy&&(!fromMedia||(e.rteFailedInit&&Ce(n,e.rteFailedInit))))return;if(n.length){');
        text = once(text,'if(Ce(n,r.value.initData)&&!bt("Tizen 2"))return;',
            'if(Ce(n,r.value.initData)&&(legacy?(!r.value.loaded&&++pending>=2):!bt("Tizen 2")))return;');
        text = once(text,'e.i.delete(r);var n=t.errorCode',
            'if(window.rteLive.legacyEme&&e.i.has(r))e.rteFailedInit=e.i.get(r).initData;e.i.delete(r);var n=t.errorCode');
        text = once(text,'if((i=e.g.dash.manifestPreprocessor)&&i(t),r=[n]',
            'if((i=e.g.dash.manifestPreprocessor)&&i(t),window.rteLive.manifest(t),r=[n]');
        text = once(text,'e.h[t].timestampOffset=n,Jo(e,t)','window.rteLive.offset(e.h[t],n),Jo(e,t)');
        text = once(text,'e.h[t].appendBuffer(n)}function Wo','window.rteLive.append(e.h[t],n)}function Wo');
    }
    if (name.startsWith('webpack-')) text = once(text, '"' + base + '/_next/"', '"./_next/"');
    if (name.startsWith('main-')) {
        // The stock 3.8-second deadline can expire while this TV parses a local page chunk.
        text = once(text, 'var a=3800;function i(e,t,r)', 'var a=30000;function i(e,t,r)');
        text = once(text, 'var e=window.location,t=e.protocol', 'var e=window.rteWidget.route(),t=e.protocol');
        text = once(text, 'window.history[e]({url:t,as:r,options:o,__N:!0,idx:this._idx="pushState"!==e?this._idx:this._idx+1},"",r)',
            'window.rteWidget.change(e,{url:t,as:r,options:o,__N:!0,idx:this._idx="pushState"!==e?this._idx:this._idx+1},r)');
        text = text.replace(/window\.location\.href=([\w.]+),/g, 'window.rteWidget.navigate($1),');
    }
    if (name.startsWith('main-') || name.includes('pages/')) {
        text = text.replace(/(?<![\w.])(?:(?:window|self)\.)?location\.(href|pathname|hash|search)\b(?!\s*=(?!=))/g,
            'window.rteWidget.route().$1');
        text = text.replace(/\w+\(\)\.BASE_PATH\+"\/(onetrust\.js|webOSTVjs-1\.2\.8\/webOSTV\.js)"/g, '"./$1"');
    }
    if (name === 'fetch.js') {
        // Resolve relative WGT paths before applying the polyfill's file-status rule.
        text = once(text,"request.url.indexOf('file://') === 0 && (xhr.status < 200 || xhr.status > 599)",
            "xhr.status === 0 && new URL(request.url, document.baseURI || location.href).protocol === 'file:'");
        text = once(text, 'resolve(new Response(body, options));',
            'try { resolve(new Response(body, options)); } catch (error) { reject(error); }');
    }
    if (name === 'onetrust.js') {
        // QtWebKit returns a string even after accepting responseType="json".
        const success = /if\(200===o.status\)return (\w+)\(o.status,o.response\);/;
        if (!success.test(text)) throw new Error('Consent SDK request handler has changed');
        text = text.replace(success, 'if(200===o.status)return $1(o.status,typeof o.response==="string"?JSON.parse(o.response):o.response);');
    }
    if (text.includes('c=new Intl.Collator,')) {
        // This language-tag sorter compares ASCII extension singletons.
        text = once(text, 'c=new Intl.Collator,',
            'c=typeof Intl!=="undefined"&&Intl.Collator?new Intl.Collator:{compare:function(a,b){return a.localeCompare(b)}},');
    }
    if (brand === 'vestel' && name.includes('/play-')) {
        // Use the hosted player's exit routine on hardware Return as well. It
        // clears streamingInfo before another station tries to initialise.
        text = once(text,'hn=function(){var e,n;An("exitFromPlayer")',
            'hn=function(returnPath){var e,n;O(!1),An("exitFromPlayer")');
        text = once(text,'void 0),Ne.push(p.backUI),mn.current=!1},Tn=',
            'void 0);mn.current=!1;return typeof returnPath==="string"?Ne.replace(returnPath):Ne.push(p.backUI)},Tn=');
        text = once(text,'An("play_page_mounted"),function(){ze.current=!0',
            'An("play_page_mounted"),window.rteWidget.exitPlayer=hn,function(){delete window.rteWidget.exitPlayer;ze.current=!0');
        text = once(text,'be(),pn.current=!1,l.AnalyticsManager.sendNpawEvent("Npaw","destroy",void 0,null!==(n=null===(e=null===event||void 0===event?void 0:event.target)',
            'be(),pn.current=!1,l.AnalyticsManager.sendNpawEvent("Npaw","destroy",void 0,null!==(n=null===(e=window.event&&window.event.target)');
    }
    if (brand === 'vestel' && name.includes('/settings-')) {
        // Extend the native Settings list so the remote uses its usual focus order.
        text = once(text, 'ft=ot.setFocus,pt=ot.getCurrentFocusKey,',
            'storageDialog=(0,s.useState)(""),storageFocus=(0,s.useRef)(""),' +
            'ft=ot.setFocus,pt=ot.getCurrentFocusKey,' +
            'openStorage=function(){storageFocus.current=pt();storageDialog[1]("confirm")},' +
            'closeStorage=function(){storageDialog[1]("");ft(storageFocus.current)},');
        text = once(text, 'return S.push({id:"privacy_button"',
            'return S.push({id:"clear_storage_button",label:"Clear storage",info:{title:"Clear storage",content:"Reset the data saved by RTÉ Player on this TV."},onSelect:openStorage,ariaHidden:h}),S.push({id:"privacy_button"');
        const storagePopup = 'storageDialog[0]&&(0,r.jsx)(i.fz,{defaultFocused:true,' +
            'title:storageDialog[0]==="confirm"?"Clear RTÉ Player storage?":"Could not clear storage",' +
            'description:storageDialog[0]==="confirm"?"This clears your saved sign-in, device ID and local preferences, then restarts the app.":"Close the app and try again.",' +
            'labelLeftButton:storageDialog[0]==="confirm"?"Clear and restart":"",labelRightButton:"Cancel",' +
            'onClickRightButton:closeStorage,onClickLeftButton:function(){try{window.rteWidget.clearStorage()}catch(error){storageDialog[1]("error")}}}),';
        text = once(text, 'mt.length&&!q&&(0,r.jsx)(i.H_', storagePopup+'mt.length&&!q&&(0,r.jsx)(i.H_');
    }
    if (name.includes('/_app-')) {
        if (brand === 'vestel') {
            text = once(text, 'device:"".concat(Nu(Mn().versionLabel)," ").concat(i.modelDevice)',
                'device:"Samsung TV"');
            // Keep the original pairing request and QR flow. The sidebar otherwise
            // traps focus in an invisible popup when the service declines a code.
            const signInDialog = 'Xe.actionOpen&&Xe.bySettingsButton&&!G.isSignedIn&&!G.associationCode&&!Yi&&' +
                '(0,i.jsx)(a.fz,{defaultFocused:true,title:"RTÉ Player sign in",' +
                'description:G.associationAccountCodeError?' + JSON.stringify(loginHelper ?
                    'Sign in failed. Check your internet connection and login helper configuration, then try again.' :
                    'RTÉ could not issue a pairing code for this TV app.') + ':"Requesting a pairing code from RTÉ…",' +
                'labelRightButton:"Back",onClickRightButton:$i}),';
            text = once(text,'nt&&!Yi&&(0,i.jsx)(a.fz',signInDialog+'nt&&!Yi&&(0,i.jsx)(a.fz');
            text = once(text,'s=mu.isAd(o),l=s?0:a','s=mu.isAd(o),window.rteAdHandoff.item(gu,s),l=s?0:a');
            text = once(text,'key:"handleGenericErrors",value:function(e){console.log',
                'key:"handleGenericErrors",value:function(e){window.rteAdHandoff.playerError(this,e.detail);console.log');
            // Scope the recovery timer and canplay callback to the ad that armed them.
            text = once(text,'var i=void 0===n?{checkStuck:!1,forceMimeType:!1}:n;',
                'var source,i=void 0===n?{checkStuck:!1,forceMimeType:!1}:n;');
            text = once(text,'if(r=(c=i).type,o=c.checkStuck','source=window.rteAdHandoff.beginSource(this);if(r=(c=i).type,o=c.checkStuck');
            text = once(text,'this.registerCheckStuck(r);case 19','window.rteAdHandoff.watchAd(this,source,r);case 19');
            text = once(text,'this.ADVClearEventListeners(""),this.advClearEventListeners()',
                'window.rteAdHandoff.stop(this),window.rteAdHandoff.endSource(this),this.advClearEventListeners()');
            text = once(text,'var f={servers:n};i&&',
                'var f={servers:n};if(window.rteLive.legacyEme)' +
                'f.preferredKeySystems=["com.microsoft.playready"];' +
                'if(window.rteLive.active())this.player.configure({restrictions:{maxHeight:576},preferredAudioChannelCount:2,preferredVideoCodecs:["avc1"]});i&&');
        }
        // Kotlin constructs Unicode regexps at runtime for programme slugs and
        // for RTÉ's stream URL check. Compile their original Unicode semantics.
        const patterns = new Set();
        for (const match of text.matchAll(/\w+\(("(?:[^"\\]|\\.)*")\)\.t8\(/g)) {
            patterns.add(parseExpressionAt(match[1],0,{ecmaVersion:2022}).value);
        }
        const selectorPattern = text.match(/"(\^\(https\?\|ftp\)[^"]+)"/);
        if (!selectorPattern) throw new Error('Missing RTÉ selector URL pattern');
        patterns.add(JSON.parse(selectorPattern[0]));
        const equivalents = {};
        for (const pattern of patterns) {
            equivalents[pattern] = {};
            for (const flags of ['gu','gui']) {
                equivalents[pattern][flags] = rewritePattern(pattern, flags, {unicodeFlag:'transform'});
            }
        }
        write('patterns.js','window.__rtePatterns=' + JSON.stringify(equivalents) + ';');
        text = once(text,'new RegExp(e,oe(t,"","gu",k,k,k,To))',
            'window.rteWidget.pattern(e,oe(t,"","gu",k,k,k,To))');
        text = once(text, 'toTranslatedLabel=function(e){var t=this.labels.w1(e);return null==t?e:t}',
            'toTranslatedLabel=function(e){var t=this.labels.w1(e);return null==t?window.rteWidget.label(e):t}');
        const resolution = '((null===(e=window.Android)||void 0===e||null===(t=e.isLowRes)||void 0===t?void 0:t.call(e))||n&&window.innerWidth<=1280)&&(document.body.className="res_1280x720",document.body.classList.add("lowres_monitor")),i&&document.body.classList.add("lowres_monitor")';
        text = once(text,resolution,'window.rteWidget.fit()');
        const clock = 'new Intl.DateTimeFormat("en",{timeZone:i,hour:"2-digit",minute:"2-digit",hour12:!1}).format(new Date(+e))';
        text = once(text,clock,'window.rteWidget.clock(+e,i)');
        // Kotlin replace(String, String) escapes the search text before constructing
        // its regexp. Use ES5 flags for that literal-only operation on old WebKit.
        for (const literal of ['go().h8(t)', 'go().h8(Te(t))']) {
            const call = 'new RegExp(' + literal + ',i?"gui":"gu")';
            text = once(text,call,'new RegExp(' + literal + ',i?"gi":"g")');
        }
    }
    try { parse(text, {ecmaVersion:5}); }
    catch {
        text = transformSync(text,{presets:[[presetEnv,{targets:{safari:'6'},modules:false}]],
            configFile:false,babelrc:false,sourceType:'script',comments:false,compact:true}).code;
    }
    parse(text,{ecmaVersion:5});
    return text;
}
function write(name, data) {
    const dest = path.join(out,name);
    fs.mkdirSync(path.dirname(dest), {recursive:true});
    if (name.endsWith('.js') && name !== 'login-helper-config.js') {
        data = '/* jshint ignore:start */\n' + data + '\n/* jshint ignore:end */\n';
    }
    fs.writeFileSync(dest,data);
}
// Replace old build output so a rebuild never ships stale or previously signed files.
fs.rmSync(out,{force:true,recursive:true});
for (const rel of fs.readdirSync(src,{recursive:true})) {
    const filename = path.join(src,rel);
    if (!fs.statSync(filename).isFile() || rel.split(path.sep).some(part => part.startsWith('.'))) continue;
    if (!/^(?:index\.html|labels\.js|onetrust\.js|webOSTVjs-1\.2\.8\/webOSTV\.js|_next\/static\/.+\.(?:css|js|ttf|woff2?))$/.test(rel)) {
        throw new Error('Unexpected staged asset ' + rel);
    }
    if (rel.endsWith('.js')) {
        write(rel,legacyJS(fs.readFileSync(filename,'utf8'),rel.includes('/pages/') ? rel : path.basename(rel)));
    } else if (rel.endsWith('.css')) {
        const raw = fs.readFileSync(filename,'utf8').replaceAll(base+'/_next/static/media/', '../media/');
        const result = await postcss([autoprefixer({overrideBrowserslist:['Safari 6','Safari 7'],remove:false})]).process(raw,{from:undefined});
        write(rel,result.css);
    } else if (rel !== 'index.html') write(rel,fs.readFileSync(filename));
}
for (const [dest, source] of Object.entries({'polyfill.js':'node_modules/core-js-bundle/minified.js',
    'encoding.js':'node_modules/fast-text-encoding/text.min.js',
    'moment.js':'node_modules/moment/min/moment.min.js',
    'zones.js':brand === 'vestel' ? 'node_modules/moment-timezone/builds/moment-timezone.min.js' :
        'node_modules/moment-timezone/builds/moment-timezone-with-data.min.js',
    'fetch.js':'node_modules/whatwg-fetch/dist/fetch.umd.js','compat.js':'widget/compat.js'})) {
    write(dest,legacyJS(fs.readFileSync(path.join(root,source),'utf8'),dest));
}
let html = fs.readFileSync(path.join(src,'index.html'),'utf8');
html = html.replaceAll('="' + base + '/', '="./');
html = once(html,'"assetPrefix":"' + base + '"','"assetPrefix":"."');
html = once(html,'<head>', '<head><script>window.__rteBase=' + JSON.stringify(base) + ';</script><script src="./polyfill.js"></script><script src="./fetch.js"></script><script src="./encoding.js"></script><script src="./moment.js"></script><script src="./zones.js"></script><script src="./patterns.js"></script><script src="./labels.js"></script><script src="./compat.js"></script>');
html = once(html,'</body>', '<div id="rte-status" role="alert" style="display:none;position:fixed;bottom:5%;left:5%;right:5%;z-index:2147483647;background:#17171e;color:white;padding:20px;font:26px sans-serif"></div></body>');
if (brand === 'vestel') {
    if (loginHelper) {
        write('login-helper.js', legacyJS(fs.readFileSync(path.join(root, 'widget/login-helper.js'), 'utf8'), 'login-helper.js'));
        write('login-helper-config.js', 'window.__rteLoginHelper=' + JSON.stringify({url: loginHelper.url, key: loginHelper.key}) + ';');
        html = once(html, '<script src="./fetch.js"></script>',
            '<script src="./fetch.js"></script><script src="./login-helper-config.js"></script><script src="./login-helper.js"></script>');
    }
    const zones = JSON.parse(fs.readFileSync(path.join(root,'node_modules/moment-timezone/data/packed/latest.json'),'utf8'));
    const localZones = ['Europe/Dublin','Etc/UTC'];
    const primary = {version:zones.version, zones:zones.zones.filter(z => localZones.includes(z.split('|')[0])),
        links:zones.links.filter(z => localZones.includes(z.split('|')[0]))};
    fs.appendFileSync(path.join(out,'zones.js'),'\nwindow.moment.tz.load(' + JSON.stringify(primary) + ');window.rteFullZoneFile="./zones-all.json";');
    write('zones-all.json', JSON.stringify(zones));
    write('ad-handoff.js',legacyJS(fs.readFileSync(path.join(root,'widget/ad-handoff.js'),'utf8'),'ad-handoff.js'));
    write('guide.css',fs.readFileSync(path.join(root,'widget/guide.css')));
    html = once(html,'</head>','<link rel="stylesheet" href="./guide.css"></head>');
    write('live.js',legacyJS(fs.readFileSync(path.join(root,'widget/live.js'),'utf8'),'live.js'));
    html = once(html,'<script src="./compat.js">','<script src="./live.js"></script><script src="./ad-handoff.js"></script><script src="./compat.js">');
}
write('index.html',html);
write('config.xml', `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://example.invalid/rte-player/${brand}" version="${brand === 'vestel' ? '1.0.0' : '1.0.1'}" viewmodes="maximized">
    <name>${label}</name>
    <icon src="${icon}"/>
    <content src="index.html"/>
    <tizen:application id="${id}.Player" package="${id}" required_version="2.4"/>
    <tizen:profile name="tv-samsung"/>
    <access origin="*" subdomains="true"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
    <tizen:setting screen-orientation="landscape" context-menu="disable" hwkey-event="enable"/>
</widget>\n`);
write(icon,fs.readFileSync(path.join(root,'widget',icon)));
console.log('Built',out);








    

    const pwaSettings = {};
    const version = 51; // version of this file
    const staticFileCdn = "https://static.cdn-website.com"
// should any assets be cached at all
    pwaSettings.shouldUseCache = true;

// should any assets be cached at all
    pwaSettings.shouldServePagesCacheFirst = false;

// version of site assets, should increase every publish
    pwaSettings.SITE_VERSION = toHash('1789401040000');

// version of runtime files, should increase on every deploy
    pwaSettings.RUNTIME_VERSION = toHash('2026-10-08T12_48_49');

// version of this file
    pwaSettings.SERVICE_WORKER_VERSION = '2' + '_' + version;

// debug mode
    pwaSettings.debug = true;

// base cache key url
    pwaSettings.baseKeyUrl = '/_dm/s/rt/actions/cacheKey';

// helper function
    function toHash(str) {
        var hash = 5381, i = str.length;
        while (i) {
            hash = hash * 33 ^ str.charCodeAt(--i)
        }
        return hash >>> 0
    }

    // import the workbox utils
importScripts(staticFileCdn + '/workbox/workbox-v3.6.3/workbox-sw.js');
workbox.setConfig({
    debug: false,
    modulePathPrefix: staticFileCdn + '/workbox/workbox-v3.6.3/',
});
workbox.core.setLogLevel(workbox.core.LOG_LEVELS.warn);

/**
 * Creates a request handler that firsts checks in the cache,
 * and if not present - fetches from network
 * @param {String} cacheName The cache name
 */
function cacheFirst(cacheName, { postFetch, matchUrlFallback = false } = {}) {
    return async function ({ event, params = {} }) {
        const request = event.request;

        // skip the mechanism entirely if needed
        if (!pwaSettings.shouldUseCache || skipCache(request.url)) {
            return fetch(request);
        }

        // open the cache
        const cache = await caches.open(cacheName);

        // check if we need to overpass the cache (for example - in case of a new published version)
        const forceNetwork = false;

        // fetch the cached response from cache
        const cachedResponse = forceNetwork
            ? null
            : (await cache.match(request)) ||
              (matchUrlFallback ? await cache.match(request.url) : null);

        if (cachedResponse) {
            logFromCache(request.url);
            return cachedResponse;
        } else {
            const networkResponse = await fetch(request);
            logFetchedAndCached(request.url, cacheName);
            cache.put(request, networkResponse.clone());
            if (postFetch) {
                postFetch({ request, cache, params });
            }
            return networkResponse;
        }
    };
}

/**
 * Creates a request handler that firsts fetches from the network,
 * and if offline or an error - fetches from cache
 * @param {String} cacheName The cache name
 */
function networkFirst(
    cacheName,
    { postFetch, ignoreSearch } = { postFetch: false, ignoreSearch: false }
) {
    return async function ({ event, params = {} }) {
        const request = event.request;

        // skip the mechanism entirely if needed
        if (!pwaSettings.shouldUseCache || skipCache(request.url)) {
            return fetch(request);
        }

        // try fetching first from network
        let networkResponse = null;
        try {
            networkResponse = await fetch(request);
        } catch (err) {
            networkResponse = null;
        }

        // open cache
        const cache = await caches.open(cacheName);

        // if the response is valid (no error) - use it
        if (validNetworkResponse(networkResponse)) {
            if (shouldCacheResponse(networkResponse)) {
                logFetchedAndCached(request.url, cacheName);
                cache.put(request, networkResponse.clone());
            }
            if (postFetch) {
                postFetch({ request, cache, params });
            }
            return networkResponse;
        }

        // else (not a < 400 response) fetch a cached response from cache
        const cachedResponse =
            (await cache.match(request, { ignoreSearch })) ||
            (await cache.match(request.url, { ignoreSearch }));

        // if one is found - serve it
        if (cachedResponse) {
            logFromCache(request.url);
            return cachedResponse;
        }

        // if no network and no cached response - log error
        log('error fetching request');
        return networkResponse;
    };
}

function validNetworkResponse(response) {
    return response && response.status < 400;
}

function shouldCacheResponse(response) {
    /**
     * Note: Since we're bypassing CORS here (see the fetch with mode: 'no-cors')
     * we might get responses which are opaque. this means that their statuses are 0
     * and they don't have any info on their response headers.
     * Since we're only checking this in "network first" it is ok, since we're not relaying
     * on cache first which might be corrupted - we always check the network first.
     * Read more about it here: https://tpiros.dev/blog/what-is-an-opaque-response/
     *
     * Also, since this method is used only for "network first" stratgy we don't
     * care about "no-cache" headers and cache the response anyway.
     */
    return (
        response &&
        (response.status === 200 || response.type === 'opaque') &&
        !response.redirected
    );
}

/**
 * Allows us to store objects in cache
 * @param {object} obj the object to create a blob from
 */
function createResponseFromJson(obj) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    return new Response(blob, { status: 200, statusText: 'OK' });
}

/**
 * Prefetches a url, i.e /?utm_homescreen
 * @param {<type>} urlToPrefetch The url to prefetch
 * @param {<type>} cacheName The cache name to store
 */
async function prefetchUrl(urlToPrefetch, cacheName) {
    const cacheBustedUrl = addParams(urlToPrefetch, { TIMESTAMP: Date.now() });
    const url = new URL(cacheBustedUrl, location.href);
    try {
        log('prefetching', urlToPrefetch);
        const response = await fetch(new Request(url, { mode: 'no-cors' }));
        if (response.status < 400) {
            const cache = await caches.open(cacheName);
            if (cache) {
                await cache.put(urlToPrefetch, response);
            }
        }
    } catch (err) {
        log('error, probably offline');
    }
}

/**
 * Checks whether to skip the cache entirely with the request
 * @param {String} url
 */
function skipCache(url) {
    return url && url.indexOf('skip_sw_cache') > -1;
}

/**
 * Adds the params to the URL
 * @param {String} url
 * @param {object} params the params to add
 */
function addParams(url, params = {}) {
    try {
        const ur = new URL(url);
        Object.keys(params).forEach((param) => {
            const value = params[param];
            ur.searchParams.set(param, value);
        });
        return ur.toString();
    } catch (err) {
        return addParamsNative(url, params);
    }
}

function getPathName(url) {
    try {
        const ur = new URL(url);
        return ur.pathname;
    } catch (err) {
        // TODO: native implementation
    }
}

/**
 * A fallback function for relative URLs
 * @param {String} url the url
 * @param {object} params the params to add
 */
function addParamsNative(url = '', params = {}) {
    const [noHash = '', hash = ''] = url.split('#');
    let [domain = '', search = ''] = noHash.split('?');

    search = search ? [search] : [];
    const searchStr = search
        .concat(
            Object.keys(params).map((k) => {
                const v = params[k];
                return v === true ? k : template('<k>=<v>', { k, v });
            })
        )
        .join('&');

    const res =
        domain +
        (searchStr ? template('?<0>', [searchStr]) : '') +
        (hash ? template('#<0>', [hash]) : '');
    return res;
}

/**
 * A helper function to replace template strings (since they don't work in jsp)
 * @param {string} str the string with placeholders
 * @param {object} data replacement values
 */
function template(str, data) {
    // Create regex using the keys of the replacement object.
    var regex = new RegExp('\\<(' + Object.keys(data).join('|') + ')\\>', 'g');

    // Replace the string by the value in object
    return str.replace(regex, (m, $1) => {
        const key = isNaN($1) ? $1 : +$1;
        return data[key] || m;
    });
}

/**
 * A logger function
 * @param {Array} args The log arguments
 */
function log(...args) {
    if (pwaSettings.debug) {
        console.log('RTSW:', ...args);
    }
}

function shouldEnableRegisterRouteForSitePages() {
    const userAgent = navigator.userAgent.toLowerCase();
    const isSafari =
        userAgent.includes('safari') &&
        !userAgent.includes('chrome') &&
        !userAgent.includes('crios');
    return !isSafari;
}

function logGroup(label, messages = []) {
    if (pwaSettings.debug) {
        console.groupCollapsed('RTSW: ' + label);
        messages.forEach((message) => console.log(message));
        console.groupEnd();
    }
}

const logFromCache = (function () {
    let timeout;
    let urls = [];
    return function (url) {
        urls.push(url);
        if (!timeout) {
            timeout = setTimeout(() => {
                timeout = false;
                logGroup('got from cache:', urls);
                urls = [];
            }, 5000);
        }
    };
})();

const logFetchedAndCached = (function () {
    let timeout;
    let urls = [];
    return function (url, cacheName) {
        urls.push({ url, cacheName });
        if (!timeout) {
            timeout = setTimeout(() => {
                timeout = false;
                logGroup(
                    'fetched and cached:',
                    urls.map((obj) => obj.url + ' in ' + obj.cacheName)
                );
                urls = [];
            }, 5000);
        }
    };
})();

    // pwaSettings: shouldUseCache, shouldServePagesCacheFirst, SITE_VERSION, RUNTIME_VERSION, SERVICE_WORKER_VERSION, debug

// Define our cache names
const { SITE_VERSION, RUNTIME_VERSION, SERVICE_WORKER_VERSION } =
    pwaSettings || {};
const prefix = 'druntime-v' + SERVICE_WORKER_VERSION + '-';
const SITE_ASSETS_CACHE_NAME = prefix + 'site-assets-' + SITE_VERSION;
const SITE_PAGES_CACHE_NAME =
    prefix + 'site-pages-' + (SITE_VERSION + '-' + RUNTIME_VERSION);
const RUNTIME_CACHE_NAME = prefix + 'runtime-assets-' + RUNTIME_VERSION;
const FONTS_CACHE_NAME =
    prefix + 'runtime-fonts-' + (SITE_VERSION + '-' + RUNTIME_VERSION);
const PAGES_CACHE_BLACKLIST = [
    '/rts/auth/authorize',
    '/rts/auth/code',
    '/rts/auth/redirect',
];

/**
 * EVENT LISTENERS
 */

// The first time the user starts up the PWA, 'install' is triggered.
self.addEventListener('install', function (event) {
    log('install');

    // this is to support the 'add to homescreen'
    prefetchUrl('/?utm_source=homescreen', SITE_PAGES_CACHE_NAME);

    // take over the page immediately
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    log('activate');
    // delete old caches
    const cacheWhitelist = [
        SITE_ASSETS_CACHE_NAME,
        RUNTIME_CACHE_NAME,
        SITE_PAGES_CACHE_NAME,
        FONTS_CACHE_NAME,
    ];
    const deletedCaches = [];
    event.waitUntil(
        caches.keys().then(async (keyList) => {
            await Promise.all(
                keyList.map((key) => {
                    if (
                        key &&
                        key.indexOf('druntime') === 0 &&
                        !cacheWhitelist.includes(key)
                    ) {
                        deletedCaches.push(key);
                        return caches.delete(key);
                    }
                })
            );
            logGroup('deleted caches:', deletedCaches);
        })
    );

    if (pwaSettings.shouldUseCache) {
        logGroup('using caches:', [
            SITE_ASSETS_CACHE_NAME,
            RUNTIME_CACHE_NAME,
            SITE_PAGES_CACHE_NAME,
            FONTS_CACHE_NAME,
        ]);
    } else {
        log('not using caches');
    }
});

self.addEventListener('message', async function handler(event) {
    if (event.data.command === 'deletePagesCache') {
        let success;
        try {
            await caches.delete(SITE_PAGES_CACHE_NAME);
            log('deleted', SITE_PAGES_CACHE_NAME, 'by request from page');
            success = true;
        } catch (e) {
            success = false;
        }
        event.ports[0].postMessage({
            success,
            cacheName: SITE_PAGES_CACHE_NAME,
        });
    }
});

/**
 * CACHE LOGIC
 */

if (pwaSettings.shouldUseCache) {
    // js files
    workbox.routing.registerRoute(
        /_dm\/s\/rt\/dist.*?\.js/,
        cacheFirst(RUNTIME_CACHE_NAME)
    );
    workbox.routing.registerRoute(
        /\/editor\/apps\/modules.*?\.js/,
        cacheFirst(RUNTIME_CACHE_NAME)
    );

    // jsp (ajax-ext)
    workbox.routing.registerRoute(
        /_dm\/s\/rt\/scripts.*?\.jsp/,
        cacheFirst(RUNTIME_CACHE_NAME)
    );

    // css files
    workbox.routing.registerRoute(
        /_dm\/s\/rt\/dist.*?\.css/,
        cacheFirst(RUNTIME_CACHE_NAME)
    );

    // dd assets
    workbox.routing.registerRoute(
        /.*?d[dp]-cdn\.multiscreensite\.com.*?/,
        cacheFirst(RUNTIME_CACHE_NAME)
    );

    // irp CDNs - going network first
    workbox.routing.registerRoute(
        /.*?irp\.cdn-website\.com.*?/,
        networkFirst(SITE_ASSETS_CACHE_NAME)
    );

    // static cdn - going network first
    workbox.routing.registerRoute(
        /.*?static\.cdn-website\.com\/mnlt\/.*?/,
        networkFirst(RUNTIME_CACHE_NAME)
    );

    // jquery
    workbox.routing.registerRoute(
        /.*?jquery.*?(?:\.min)?\.js.*?/,
        cacheFirst(RUNTIME_CACHE_NAME)
    );

    // other js
    workbox.routing.registerRoute(
        /.*?(?:leaflet|skrollr|lozad).*?(?:\.js|\.css).*?/,
        cacheFirst(RUNTIME_CACHE_NAME)
    );

    // site pages
    if (shouldEnableRegisterRouteForSitePages()) {
        workbox.routing.registerRoute(
            matchSitePages,
            pwaSettings.shouldServePagesCacheFirst
                ? cacheFirst(SITE_PAGES_CACHE_NAME)
                : networkFirst(SITE_PAGES_CACHE_NAME, { ignoreSearch: true })
        );
    }

    // site images
    workbox.routing.registerRoute(
        /.*?ir[tp]-cdn\.multiscreensite\.com.*?/,
        cacheFirst(SITE_ASSETS_CACHE_NAME)
    );
    workbox.routing.registerRoute(
        /.*?master-image-res\.s3\.amazonaws.*?/,
        cacheFirst(SITE_ASSETS_CACHE_NAME)
    );

    // css files - generated
    workbox.routing.registerRoute(
        /_dm\/s\/rt\/generate_css/,
        cacheFirst(SITE_ASSETS_CACHE_NAME)
    );
    workbox.routing.registerRoute(
        /_dm\/s\/rt\/widgets_css/,
        cacheFirst(SITE_ASSETS_CACHE_NAME)
    );

    // css files - site
    workbox.routing.registerRoute(
        /.*?cdn\.dwhitelabel\.com\/.*?files\/.*?\.css.*?/,
        cacheFirst(SITE_ASSETS_CACHE_NAME)
    );

    // fonts
    workbox.routing.registerRoute(
        /.*?fonts\.(?:googleapis|gstatic)\.com\/(.*)/,
        cacheFirst(FONTS_CACHE_NAME)
    );

    // fonts - local
    workbox.routing.registerRoute(
        new RegExp('/_dm/s/rt/css/font-icons'),
        cacheFirst(FONTS_CACHE_NAME)
    );
    workbox.routing.registerRoute(
        new RegExp('/_dm/s/rt/fonts'),
        cacheFirst(FONTS_CACHE_NAME)
    );
    workbox.routing.registerRoute(
        /.*?static-cdn\.dwhitelabel\.com\/fonts.*?/,
        cacheFirst(FONTS_CACHE_NAME)
    );

    // Vids CDNs
    workbox.routing.registerRoute(
        /.*?vid-cdn\..*\.(com|net).*?/,
        networkFirst(SITE_ASSETS_CACHE_NAME)
    );
    workbox.routing.registerRoute(
        /.*?vid\.cdn-website\.com.*?/,
        networkFirst(SITE_ASSETS_CACHE_NAME)
    );

    // MS CDN
    workbox.routing.registerRoute(
        /.*?ms-cdn\.multiscreensite\.com.*?/,
        networkFirst(RUNTIME_CACHE_NAME)
    );
}

/**
 * HELPER FUNCTIONS
 */

/**
 * A request matcher that checks if the request is for one of the site pages
 */
function matchSitePages({ url, event }) {
    const request = event.request;
    if (request) {
        if (request.mode === 'navigate' && shouldCachePageRequest(request)) {
            // direct navigation
            return { ajaxNav: false, sitePage: true };
        } else if (isAjaxNav(request.url)) {
            // ajax navigation
            return { ajaxNav: true, sitePage: true };
        }
    }
    return false;
}

function shouldCachePageRequest(request) {
    return PAGES_CACHE_BLACKLIST.every(
        (blacklistedUrl) => !request.url.includes(blacklistedUrl)
    );
}

async function fetchPageKey(pageUrl) {
    const baseKeyUrl = pwaSettings.baseKeyUrl;
    const pageUri = getPathName(pageUrl);
    const pageKeyUrl = addParams(baseKeyUrl, {
        uri: encodeURIComponent(pageUri),
        skip_sw_cache: true,
    });
    return await fetch(pageKeyUrl);
}

function isAjaxNav(url) {
    return url && url.indexOf('dm_ajaxCall=true') > -1;
}

function removeAjax(url) {
    return url.replace(/[\?&]dm_ajaxCall=true/, '');
}

function makeAjax(url) {
    return addParams(url, { dm_ajaxCall: 'true' });
}

self.addEventListener('fetch', () => {});

// self.addEventListener('fetch', function(event) {
//   event.respondWith(
//     caches.open(SITE_ASSETS_CACHE_NAME).then(function(cache) {
//       var request = event.request;
//       // check if not manifest.json
//       if (request.url.indexOf('manifest.json') > -1 || request.url.indexOf('manifest.xml') > -1) {
//         return fetch(request)
//       }
//       if (request.url.indexOf('picsum.photos') == -1) {
//         return fetch(request)
//       }
//       return cache.match(request).then(function (response) {
//         return response || fetch(request).then(function(response) {
//           cache.put(request, response.clone());
//           return response;
//         });
//       });
//     })
//   );
// });


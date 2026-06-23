/**
 * Instagram Profile & Hashtag Scraper v3
 * Robust version with longer timeouts and better error handling
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, Log } from 'crawlee';

const log = new Log({ prefix: 'InstagramScraper' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = async (min = 2000, max = 4000) => {
    await sleep(Math.floor(Math.random() * (max - min + 1)) + min);
};

async function setCookies(context, cookies) {
    if (!cookies?.length) return;
    const formatted = cookies.map((c) => ({
        name: c.name, value: c.value,
        domain: c.domain || '.instagram.com',
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: c.httpOnly || false,
        sameSite: 'None'
    }));
    await context.addCookies(formatted);
    log.info(`✅ Set ${formatted.length} cookies`);
}

async function dismissDialogs(page) {
    for (const sel of ['text=Not Now', 'text=Allow all cookies', 'text=Accept All', '[aria-label="Close"]']) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 })) { await el.click(); await sleep(800); }
        } catch (_) {}
    }
}

function setupInterception(page, store) {
    page.on('response', async (res) => {
        const url = res.url();
        if (!url.includes('instagram.com')) return;
        try {
            const ct = res.headers()['content-type'] || '';
            if (ct.includes('json') && (
                url.includes('/graphql') || url.includes('/api/v1/') ||
                url.includes('__a=1') || url.includes('query_hash')
            )) {
                const body = await res.json().catch(() => null);
                if (body) store.push({ url, body });
            }
        } catch (_) {}
    });
}

function deepFind(obj, test, depth = 0) {
    if (depth > 12 || !obj || typeof obj !== 'object') return null;
    if (test(obj)) return obj;
    for (const v of Object.values(obj)) {
        const r = deepFind(v, test, depth + 1);
        if (r) return r;
    }
    return null;
}

function parsePost(node) {
    if (!node) return null;
    const sc = node.shortcode || node.code;
    if (!sc) return null;
    return {
        postId: node.id,
        shortCode: sc,
        postUrl: `https://www.instagram.com/p/${sc}/`,
        type: node.__typename,
        imageUrl: node.display_url || node.image_versions2?.candidates?.[0]?.url,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || '',
        likesCount: node.edge_media_preview_like?.count || node.edge_liked_by?.count || node.like_count || 0,
        commentsCount: node.edge_media_to_comment?.count || node.comment_count || 0,
        timestamp: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString()
                 : node.taken_at ? new Date(node.taken_at * 1000).toISOString() : null,
        isVideo: node.is_video || node.media_type === 2,
        videoViews: node.video_view_count || 0,
        location: node.location?.name || null,
        ownerUsername: node.owner?.username || node.user?.username || null,
        hashtags: (node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || '').match(/#[\w]+/g) || [],
    };
}

async function scrapeProfile(page, username, maxPosts) {
    log.info(`📸 Scraping profile: @${username}`);
    const intercepted = [];
    setupInterception(page, intercepted);

    // Go directly to profile page
    const url = `https://www.instagram.com/${username}/`;
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
        log.warning(`Timeout on first load, retrying... ${e.message}`);
        await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    }
    await sleep(4000);
    await dismissDialogs(page);
    await sleep(2000);

    // Scroll to trigger API calls
    for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(2000);
    }

    // Get DOM post links
    const postLinks = await page.$$eval('a[href*="/p/"]', (els) =>
        [...new Set(els.map(e => e.href).filter(h => /\/p\/[A-Za-z0-9_-]{5,}/.test(h)))]
    ).catch(() => []);
    log.info(`Found ${postLinks.length} post links in DOM`);

    // Parse from page scripts
    const scriptData = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const s of scripts) {
            try {
                const json = JSON.parse(s.textContent);
                const find = (o, d = 0) => {
                    if (d > 10 || !o || typeof o !== 'object') return null;
                    if ((o.username && o.edge_followed_by) || o.edge_owner_to_timeline_media) return o;
                    for (const v of Object.values(o)) { const r = find(v, d+1); if (r) return r; }
                    return null;
                };
                const found = find(json);
                if (found) return found;
            } catch (_) {}
        }
        return null;
    }).catch(() => null);

    let userData = scriptData;
    let posts = [];

    // Extract from intercepted network calls
    for (const { body } of intercepted) {
        const timeline = deepFind(body, o => o.edge_owner_to_timeline_media || o.edge_felix_video_timeline);
        if (timeline) {
            const edges = timeline.edge_owner_to_timeline_media?.edges || timeline.edge_felix_video_timeline?.edges || [];
            posts.push(...edges.map(e => parsePost(e.node)).filter(Boolean));
        }
        if (!userData?.username) {
            const user = deepFind(body, o => o.username && (o.edge_followed_by || o.follower_count));
            if (user) userData = user;
        }
    }

    // Extract from script data
    if (posts.length === 0 && scriptData?.edge_owner_to_timeline_media?.edges) {
        posts = scriptData.edge_owner_to_timeline_media.edges.map(e => parsePost(e.node)).filter(Boolean);
    }

    // Fallback to DOM links
    if (posts.length === 0 && postLinks.length > 0) {
        log.info('Using DOM post links as fallback');
        posts = postLinks.slice(0, maxPosts).map(u => {
            const m = u.match(/\/p\/([A-Za-z0-9_-]+)/);
            return m ? { shortCode: m[1], postUrl: u } : null;
        }).filter(Boolean);
    }

    // Deduplicate
    const seen = new Set();
    posts = posts.filter(p => { if (!p.shortCode || seen.has(p.shortCode)) return false; seen.add(p.shortCode); return true; });

    const followers = userData?.edge_followed_by?.count || userData?.follower_count;
    log.info(`@${username} | Followers: ${followers} | Posts: ${posts.length}`);

    return {
        type: 'profile',
        scrapedAt: new Date().toISOString(),
        profileUrl: url,
        username: userData?.username || username,
        fullName: userData?.full_name,
        biography: userData?.biography,
        followers,
        following: userData?.edge_follow?.count || userData?.following_count,
        postsCount: userData?.edge_owner_to_timeline_media?.count || userData?.media_count,
        isVerified: userData?.is_verified || false,
        isPrivate: userData?.is_private || false,
        profilePicUrl: userData?.profile_pic_url_hd || userData?.profile_pic_url,
        externalUrl: userData?.external_url,
        posts: posts.slice(0, maxPosts)
    };
}

async function scrapeHashtag(page, hashtag, maxPosts) {
    log.info(`#️⃣  Scraping hashtag: #${hashtag}`);
    const intercepted = [];
    setupInterception(page, intercepted);

    const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (e) {
        log.warning(`Timeout, retrying... ${e.message}`);
        await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    }
    await sleep(4000);
    await dismissDialogs(page);

    // Scroll multiple times
    for (let i = 0; i < 8; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(2000);
    }

    // Extract from page scripts
    const scriptData = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const s of scripts) {
            try {
                const json = JSON.parse(s.textContent);
                const find = (o, d = 0) => {
                    if (d > 10 || !o || typeof o !== 'object') return null;
                    if (o.edge_hashtag_to_media || (o.hashtag && o.hashtag.edge_hashtag_to_media)) return o.hashtag || o;
                    for (const v of Object.values(o)) { const r = find(v, d+1); if (r) return r; }
                    return null;
                };
                const found = find(json);
                if (found) return found;
            } catch (_) {}
        }
        return null;
    }).catch(() => null);

    let posts = [];
    let totalCount = null;

    // From intercepted
    for (const { body } of intercepted) {
        const hd = deepFind(body, o => o.edge_hashtag_to_media || (o.name && o.edge_hashtag_to_top_posts));
        if (hd) {
            const edges = [...(hd.edge_hashtag_to_top_posts?.edges || []), ...(hd.edge_hashtag_to_media?.edges || [])];
            posts.push(...edges.map(e => ({ ...parsePost(e.node), hashtag })).filter(p => p?.shortCode));
            if (!totalCount) totalCount = hd.edge_hashtag_to_media?.count;
        }
    }

    // From scripts
    if (posts.length === 0 && scriptData) {
        const edges = [...(scriptData.edge_hashtag_to_top_posts?.edges || []), ...(scriptData.edge_hashtag_to_media?.edges || [])];
        posts = edges.map(e => ({ ...parsePost(e.node), hashtag })).filter(p => p?.shortCode);
        totalCount = scriptData.edge_hashtag_to_media?.count;
    }

    // DOM fallback
    if (posts.length === 0) {
        const links = await page.$$eval('a[href*="/p/"]', els =>
            [...new Set(els.map(e => e.href).filter(h => /\/p\/[A-Za-z0-9_-]{5,}/.test(h)))]
        ).catch(() => []);
        posts = links.slice(0, maxPosts).map(u => {
            const m = u.match(/\/p\/([A-Za-z0-9_-]+)/);
            return m ? { shortCode: m[1], postUrl: u, hashtag } : null;
        }).filter(Boolean);
        log.info(`DOM fallback: found ${posts.length} post links`);
    }

    // Deduplicate
    const seen = new Set();
    posts = posts.filter(p => { if (!p.shortCode || seen.has(p.shortCode)) return false; seen.add(p.shortCode); return true; });

    log.info(`#${hashtag} | Total: ${totalCount} | Scraped: ${posts.length}`);

    return {
        type: 'hashtag',
        scrapedAt: new Date().toISOString(),
        hashtag, hashtagUrl: url, totalPostsCount: totalCount,
        posts: posts.slice(0, maxPosts)
    };
}

// ─── Main ────────────────────────────────────────────────────────────────────

await Actor.init();
const input = await Actor.getInput() || {};
const {
    scrapeType = 'both', usernames = [], hashtags = [],
    maxPostsPerProfile = 12, maxPostsPerHashtag = 20,
    proxy = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    loginCookies = []
} = input;

log.info('Config:', { scrapeType, usernames, hashtags });
const proxyConfig = await Actor.createProxyConfiguration(proxy);

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-blink-features=AutomationControlled', '--lang=en-US',
                   '--disable-features=IsolateOrigins,site-per-process']
        }
    },
    browserPoolOptions: { useFingerprints: true },
    maxConcurrency: 1,
    navigationTimeoutSecs: 120,
    requestHandlerTimeoutSecs: 420,
    maxRequestRetries: 3,

    async requestHandler({ page, request }) {
        const { type, identifier } = request.userData;
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        if (loginCookies.length > 0) {
            await setCookies(page.context(), loginCookies);
        }

        try {
            const result = type === 'profile'
                ? await scrapeProfile(page, identifier, maxPostsPerProfile)
                : await scrapeHashtag(page, identifier, maxPostsPerHashtag);
            await Dataset.pushData(result);
            log.info(`✅ Saved ${type} "${identifier}" | Posts: ${result.posts?.length}`);
        } catch (err) {
            log.error(`❌ Failed ${type} "${identifier}": ${err.message}`);
            await Dataset.pushData({ type, identifier, error: err.message, scrapedAt: new Date().toISOString() });
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url} — ${error.message}`);
    }
});

const requests = [];
if (scrapeType === 'profile' || scrapeType === 'both') {
    for (const u of usernames) {
        const clean = u.replace(/^@/, '').trim();
        if (clean) requests.push({ url: `https://www.instagram.com/${clean}/`, userData: { type: 'profile', identifier: clean } });
    }
}
if (scrapeType === 'hashtag' || scrapeType === 'both') {
    for (const t of hashtags) {
        const clean = t.replace(/^#/, '').trim();
        if (clean) requests.push({ url: `https://www.instagram.com/explore/tags/${encodeURIComponent(clean)}/`, userData: { type: 'hashtag', identifier: clean } });
    }
}

if (!requests.length) { log.warning('No targets!'); await Actor.exit(); }
log.info(`Starting ${requests.length} target(s)...`);
await crawler.run(requests);
log.info('🎉 Done!');
await Actor.exit();

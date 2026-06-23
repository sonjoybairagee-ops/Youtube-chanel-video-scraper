/**
 * Instagram Profile & Hashtag Scraper - Apify Actor
 * Scrapes Instagram profiles and hashtag posts using Playwright
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, Log } from 'crawlee';

const log = new Log({ prefix: 'InstagramScraper' });

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const randomDelay = async (min = 1500, max = 4000) => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await sleep(delay);
};

async function setCookies(page, cookies) {
    if (!cookies || cookies.length === 0) return;
    await page.context().addCookies(cookies);
    log.info('Session cookies set successfully.');
}

async function dismissDialogs(page) {
    try {
        // Dismiss "Not Now" for notifications
        const notNow = page.locator('text=Not Now').first();
        if (await notNow.isVisible({ timeout: 3000 })) {
            await notNow.click();
            await sleep(1000);
        }
    } catch (_) {}

    try {
        // Dismiss cookie banner
        const acceptCookies = page.locator('text=Allow all cookies').first();
        if (await acceptCookies.isVisible({ timeout: 3000 })) {
            await acceptCookies.click();
            await sleep(1000);
        }
    } catch (_) {}

    try {
        // Dismiss login popup if browsing without account
        const close = page.locator('[aria-label="Close"]').first();
        if (await close.isVisible({ timeout: 2000 })) {
            await close.click();
        }
    } catch (_) {}
}

// ─── Profile Scraper ────────────────────────────────────────────────────────

async function scrapeProfile(page, username, maxPosts, scrapeComments, maxComments) {
    const profileUrl = `https://www.instagram.com/${username}/`;
    log.info(`Scraping profile: ${profileUrl}`);

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(2000, 4000);
    await dismissDialogs(page);

    // ── Extract profile info ──
    const profileData = await page.evaluate(() => {
        const getMeta = (prop) => {
            const el = document.querySelector(`meta[property="${prop}"]`) ||
                       document.querySelector(`meta[name="${prop}"]`);
            return el ? el.getAttribute('content') : null;
        };

        // Try window.__additionalDataLoaded or shared data
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        let userData = null;

        for (const script of scripts) {
            try {
                const json = JSON.parse(script.textContent);
                // Search for user data in various structures
                const search = (obj, depth = 0) => {
                    if (depth > 8 || !obj || typeof obj !== 'object') return null;
                    if (obj.username && obj.edge_followed_by) return obj;
                    for (const key of Object.keys(obj)) {
                        const result = search(obj[key], depth + 1);
                        if (result) return result;
                    }
                    return null;
                };
                userData = search(json);
                if (userData) break;
            } catch (_) {}
        }

        if (userData) {
            return {
                username: userData.username,
                fullName: userData.full_name,
                biography: userData.biography,
                followers: userData.edge_followed_by?.count,
                following: userData.edge_follow?.count,
                postsCount: userData.edge_owner_to_timeline_media?.count,
                isVerified: userData.is_verified,
                isPrivate: userData.is_private,
                profilePicUrl: userData.profile_pic_url_hd || userData.profile_pic_url,
                externalUrl: userData.external_url,
                businessCategory: userData.business_category_name,
                isBusiness: userData.is_business_account,
                posts: (userData.edge_owner_to_timeline_media?.edges || []).map((edge) => {
                    const node = edge.node;
                    return {
                        postId: node.id,
                        shortCode: node.shortcode,
                        postUrl: `https://www.instagram.com/p/${node.shortcode}/`,
                        type: node.__typename,
                        imageUrl: node.display_url,
                        thumbnailUrl: node.thumbnail_src,
                        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                        likesCount: node.edge_media_preview_like?.count || 0,
                        commentsCount: node.edge_media_to_comment?.count || 0,
                        timestamp: node.taken_at_timestamp
                            ? new Date(node.taken_at_timestamp * 1000).toISOString()
                            : null,
                        isVideo: node.is_video,
                        videoViewCount: node.video_view_count || 0,
                        dimensions: node.dimensions,
                        locationName: node.location?.name || null
                    };
                })
            };
        }

        // Fallback: parse from meta tags
        const descriptionMeta = getMeta('og:description') || '';
        const match = descriptionMeta.match(/([\d,.KM]+)\s*Followers,\s*([\d,.KM]+)\s*Following,\s*([\d,.KM]+)\s*Posts/i);

        return {
            username: null,
            fullName: getMeta('og:title')?.replace(' • Instagram photos and videos', '').trim(),
            biography: null,
            followers: match ? match[1] : null,
            following: match ? match[2] : null,
            postsCount: match ? match[3] : null,
            profilePicUrl: getMeta('og:image'),
            posts: []
        };
    });

    if (!profileData.username) {
        profileData.username = username;
    }

    log.info(`Profile: @${profileData.username} | Followers: ${profileData.followers} | Posts found: ${profileData.posts?.length}`);

    // ── Scroll to load more posts ──
    const postsToLoad = maxPosts - (profileData.posts?.length || 0);
    if (postsToLoad > 0 && !profileData.isPrivate) {
        await loadMorePosts(page, postsToLoad);
    }

    // ── Collect post URLs from page ──
    const postLinks = await page.$$eval(
        'a[href*="/p/"]',
        (links) => [...new Set(links.map((l) => l.href).filter((h) => h.includes('/p/')))]
    );

    const uniquePostUrls = [...new Set(postLinks)].slice(0, maxPosts);

    // ── Merge with already-scraped posts ──
    const existingShortCodes = new Set((profileData.posts || []).map((p) => p.shortCode));
    const newPostUrls = uniquePostUrls.filter((url) => {
        const match = url.match(/\/p\/([^/]+)/);
        return match && !existingShortCodes.has(match[1]);
    });

    // Scrape individual posts if we need more details
    const additionalPosts = [];
    for (const postUrl of newPostUrls.slice(0, Math.max(0, maxPosts - profileData.posts.length))) {
        try {
            const postData = await scrapePost(page, postUrl, scrapeComments, maxComments);
            if (postData) additionalPosts.push(postData);
            await randomDelay(2000, 4000);
        } catch (err) {
            log.warning(`Failed to scrape post ${postUrl}: ${err.message}`);
        }
    }

    const allPosts = [...(profileData.posts || []), ...additionalPosts].slice(0, maxPosts);

    return {
        type: 'profile',
        scrapedAt: new Date().toISOString(),
        profileUrl: `https://www.instagram.com/${username}/`,
        username: profileData.username || username,
        fullName: profileData.fullName,
        biography: profileData.biography,
        followers: profileData.followers,
        following: profileData.following,
        postsCount: profileData.postsCount,
        isVerified: profileData.isVerified || false,
        isPrivate: profileData.isPrivate || false,
        profilePicUrl: profileData.profilePicUrl,
        externalUrl: profileData.externalUrl,
        businessCategory: profileData.businessCategory,
        isBusiness: profileData.isBusiness || false,
        posts: allPosts
    };
}

async function loadMorePosts(page, neededCount) {
    log.info(`Scrolling to load more posts (need ${neededCount} more)...`);
    let prevCount = 0;
    let sameCountRounds = 0;

    for (let i = 0; i < 15; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await randomDelay(2000, 3500);

        const count = await page.$$eval('a[href*="/p/"]', (els) => els.length);
        if (count >= neededCount) break;

        if (count === prevCount) {
            sameCountRounds++;
            if (sameCountRounds >= 3) break;
        } else {
            sameCountRounds = 0;
        }
        prevCount = count;
    }
}

// ─── Single Post Scraper ────────────────────────────────────────────────────

async function scrapePost(page, postUrl, scrapeComments = false, maxComments = 10) {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(1500, 3000);
    await dismissDialogs(page);

    const postData = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.textContent);
                const search = (obj, depth = 0) => {
                    if (depth > 8 || !obj || typeof obj !== 'object') return null;
                    if (obj.shortcode && obj.edge_media_to_comment !== undefined) return obj;
                    for (const key of Object.keys(obj)) {
                        const r = search(obj[key], depth + 1);
                        if (r) return r;
                    }
                    return null;
                };
                const node = search(json);
                if (node) {
                    return {
                        postId: node.id,
                        shortCode: node.shortcode,
                        postUrl: `https://www.instagram.com/p/${node.shortcode}/`,
                        type: node.__typename,
                        imageUrl: node.display_url,
                        thumbnailUrl: node.thumbnail_src,
                        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                        likesCount: node.edge_media_preview_like?.count || node.edge_liked_by?.count || 0,
                        commentsCount: node.edge_media_to_comment?.count || 0,
                        timestamp: node.taken_at_timestamp
                            ? new Date(node.taken_at_timestamp * 1000).toISOString()
                            : null,
                        isVideo: node.is_video,
                        videoUrl: node.video_url || null,
                        videoViewCount: node.video_view_count || 0,
                        dimensions: node.dimensions,
                        locationName: node.location?.name || null,
                        locationId: node.location?.id || null,
                        ownerUsername: node.owner?.username,
                        ownerId: node.owner?.id,
                        isSponsored: node.is_ad || false,
                        hashtags: (node.edge_media_to_caption?.edges?.[0]?.node?.text || '')
                            .match(/#[\w]+/g) || [],
                        mentions: (node.edge_media_to_caption?.edges?.[0]?.node?.text || '')
                            .match(/@[\w.]+/g) || [],
                        sidecarImages: (node.edge_sidecar_to_children?.edges || []).map((e) => ({
                            imageUrl: e.node?.display_url,
                            isVideo: e.node?.is_video
                        })),
                        comments: (node.edge_media_to_comment?.edges || []).map((e) => ({
                            id: e.node?.id,
                            text: e.node?.text,
                            timestamp: e.node?.created_at
                                ? new Date(e.node.created_at * 1000).toISOString()
                                : null,
                            ownerUsername: e.node?.owner?.username,
                            likesCount: e.node?.edge_liked_by?.count || 0
                        }))
                    };
                }
            } catch (_) {}
        }

        // Fallback: meta tags
        const getMeta = (p) => {
            const el = document.querySelector(`meta[property="${p}"]`) ||
                       document.querySelector(`meta[name="${p}"]`);
            return el?.getAttribute('content') || null;
        };

        const url = window.location.href;
        const shortCodeMatch = url.match(/\/p\/([^/]+)/);
        return {
            postUrl: url,
            shortCode: shortCodeMatch ? shortCodeMatch[1] : null,
            imageUrl: getMeta('og:image'),
            caption: getMeta('og:description'),
            likesCount: 0,
            commentsCount: 0,
            timestamp: null
        };
    });

    if (scrapeComments && postData.commentsCount > 0 && postData.comments?.length < Math.min(maxComments, postData.commentsCount)) {
        postData.comments = await loadMoreComments(page, postData.comments || [], maxComments);
    } else if (!scrapeComments) {
        delete postData.comments;
    }

    return postData;
}

async function loadMoreComments(page, existingComments, maxComments) {
    const comments = [...existingComments];
    let attempts = 0;

    while (comments.length < maxComments && attempts < 5) {
        try {
            const loadMore = page.locator('text=Load more comments').first();
            if (await loadMore.isVisible({ timeout: 2000 })) {
                await loadMore.click();
                await randomDelay(2000, 3000);

                const newComments = await page.$$eval(
                    'ul[class*="comment"] li',
                    (items) => items.map((li) => ({
                        text: li.querySelector('span')?.textContent?.trim(),
                        ownerUsername: li.querySelector('a')?.textContent?.trim()
                    })).filter((c) => c.text)
                );

                comments.push(...newComments.slice(comments.length));
            } else {
                break;
            }
        } catch (_) {
            break;
        }
        attempts++;
    }

    return comments.slice(0, maxComments);
}

// ─── Hashtag Scraper ────────────────────────────────────────────────────────

async function scrapeHashtag(page, hashtag, maxPosts, scrapeComments, maxComments) {
    const hashtagUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;
    log.info(`Scraping hashtag: #${hashtag} → ${hashtagUrl}`);

    await page.goto(hashtagUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomDelay(2000, 4000);
    await dismissDialogs(page);

    // Extract hashtag metadata
    const hashtagMeta = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const script of scripts) {
            try {
                const json = JSON.parse(script.textContent);
                const search = (obj, depth = 0) => {
                    if (depth > 8 || !obj || typeof obj !== 'object') return null;
                    if (obj.name && obj.edge_hashtag_to_media) return obj;
                    for (const key of Object.keys(obj)) {
                        const r = search(obj[key], depth + 1);
                        if (r) return r;
                    }
                    return null;
                };
                const data = search(json);
                if (data) return {
                    name: data.name,
                    id: data.id,
                    postsCount: data.edge_hashtag_to_media?.count,
                    topPosts: (data.edge_hashtag_to_top_posts?.edges || []).map((e) => ({
                        postId: e.node?.id,
                        shortCode: e.node?.shortcode,
                        postUrl: `https://www.instagram.com/p/${e.node?.shortcode}/`,
                        imageUrl: e.node?.display_url,
                        thumbnailUrl: e.node?.thumbnail_src,
                        caption: e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                        likesCount: e.node?.edge_media_preview_like?.count || 0,
                        commentsCount: e.node?.edge_media_to_comment?.count || 0,
                        timestamp: e.node?.taken_at_timestamp
                            ? new Date(e.node.taken_at_timestamp * 1000).toISOString()
                            : null,
                        isVideo: e.node?.is_video,
                        ownerUsername: e.node?.owner?.username
                    })),
                    recentPosts: (data.edge_hashtag_to_media?.edges || []).map((e) => ({
                        postId: e.node?.id,
                        shortCode: e.node?.shortcode,
                        postUrl: `https://www.instagram.com/p/${e.node?.shortcode}/`,
                        imageUrl: e.node?.display_url,
                        thumbnailUrl: e.node?.thumbnail_src,
                        caption: e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                        likesCount: e.node?.edge_media_preview_like?.count || 0,
                        commentsCount: e.node?.edge_media_to_comment?.count || 0,
                        timestamp: e.node?.taken_at_timestamp
                            ? new Date(e.node.taken_at_timestamp * 1000).toISOString()
                            : null,
                        isVideo: e.node?.is_video,
                        ownerUsername: e.node?.owner?.username
                    }))
                };
            } catch (_) {}
        }
        return { name: null, postsCount: null, topPosts: [], recentPosts: [] };
    });

    log.info(`Hashtag #${hashtag}: ${hashtagMeta.postsCount} total posts | Top: ${hashtagMeta.topPosts?.length} | Recent: ${hashtagMeta.recentPosts?.length}`);

    // Collect post links by scrolling
    const allPostUrls = new Set();
    (hashtagMeta.topPosts || []).forEach((p) => p.postUrl && allPostUrls.add(p.postUrl));
    (hashtagMeta.recentPosts || []).forEach((p) => p.postUrl && allPostUrls.add(p.postUrl));

    if (allPostUrls.size < maxPosts) {
        await loadMoreHashtagPosts(page, allPostUrls, maxPosts);
    }

    // Pre-built posts map for quick lookup
    const preBuilt = new Map();
    [...(hashtagMeta.topPosts || []), ...(hashtagMeta.recentPosts || [])].forEach((p) => {
        if (p.shortCode) preBuilt.set(p.postUrl, p);
    });

    // Scrape individual posts for details if needed
    const posts = [];
    for (const postUrl of [...allPostUrls].slice(0, maxPosts)) {
        if (preBuilt.has(postUrl) && !scrapeComments) {
            posts.push({ ...preBuilt.get(postUrl), hashtag });
        } else {
            try {
                const postData = await scrapePost(page, postUrl, scrapeComments, maxComments);
                if (postData) posts.push({ ...postData, hashtag });
                await randomDelay(2000, 4000);
            } catch (err) {
                log.warning(`Failed to scrape post ${postUrl}: ${err.message}`);
            }
        }
    }

    return {
        type: 'hashtag',
        scrapedAt: new Date().toISOString(),
        hashtag,
        hashtagUrl,
        hashtagId: hashtagMeta.id,
        totalPostsCount: hashtagMeta.postsCount,
        posts
    };
}

async function loadMoreHashtagPosts(page, postUrls, targetCount) {
    let prevCount = postUrls.size;
    let sameRounds = 0;

    for (let i = 0; i < 20; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await randomDelay(2500, 4000);

        const links = await page.$$eval(
            'a[href*="/p/"]',
            (els) => els.map((el) => el.href).filter((h) => h.includes('/p/'))
        );
        links.forEach((l) => postUrls.add(l));

        if (postUrls.size >= targetCount) break;
        if (postUrls.size === prevCount) {
            sameRounds++;
            if (sameRounds >= 3) break;
        } else {
            sameRounds = 0;
        }
        prevCount = postUrls.size;
    }
}

// ─── Main Actor Entry ────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();

const {
    scrapeType = 'both',
    usernames = [],
    hashtags = [],
    maxPostsPerProfile = 12,
    maxPostsPerHashtag = 20,
    scrapeComments = false,
    maxCommentsPerPost = 10,
    proxy = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    loginCookies = []
} = input || {};

log.info('Actor started with config:', {
    scrapeType,
    usernameCount: usernames.length,
    hashtagCount: hashtags.length,
    maxPostsPerProfile,
    maxPostsPerHashtag
});

const proxyConfig = await Actor.createProxyConfiguration(proxy);

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        },
        useChrome: false
    },
    browserPoolOptions: {
        useFingerprints: true
    },
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 300,
    maxRequestRetries: 3,

    async requestHandler({ page, request }) {
        const { type, identifier } = request.userData;

        // Set viewport to look like a real browser
        await page.setViewportSize({ width: 1280, height: 800 });

        // Set extra headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        });

        // Inject cookies if provided
        if (loginCookies.length > 0) {
            await setCookies(page, loginCookies);
        }

        try {
            if (type === 'profile') {
                const result = await scrapeProfile(
                    page,
                    identifier,
                    maxPostsPerProfile,
                    scrapeComments,
                    maxCommentsPerPost
                );
                await Dataset.pushData(result);
                log.info(`✅ Profile @${identifier} saved | Posts: ${result.posts?.length}`);

            } else if (type === 'hashtag') {
                const result = await scrapeHashtag(
                    page,
                    identifier,
                    maxPostsPerHashtag,
                    scrapeComments,
                    maxCommentsPerPost
                );
                await Dataset.pushData(result);
                log.info(`✅ Hashtag #${identifier} saved | Posts: ${result.posts?.length}`);
            }
        } catch (err) {
            log.error(`Failed to scrape ${type} "${identifier}": ${err.message}`);
            await Actor.pushData({
                type,
                identifier,
                error: err.message,
                scrapedAt: new Date().toISOString()
            });
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Request failed: ${request.url} — ${error.message}`);
    }
});

// Build request list
const requests = [];

if (scrapeType === 'profile' || scrapeType === 'both') {
    for (const username of usernames) {
        const clean = username.replace(/^@/, '').trim();
        if (clean) {
            requests.push({
                url: `https://www.instagram.com/${clean}/`,
                userData: { type: 'profile', identifier: clean }
            });
        }
    }
}

if (scrapeType === 'hashtag' || scrapeType === 'both') {
    for (const tag of hashtags) {
        const clean = tag.replace(/^#/, '').trim();
        if (clean) {
            requests.push({
                url: `https://www.instagram.com/explore/tags/${encodeURIComponent(clean)}/`,
                userData: { type: 'hashtag', identifier: clean }
            });
        }
    }
}

if (requests.length === 0) {
    log.warning('No usernames or hashtags provided. Please check your input.');
    await Actor.exit();
}

log.info(`Starting scrape of ${requests.length} target(s)...`);
await crawler.run(requests);

log.info('🎉 Scraping complete! Check the Dataset tab for results.');
await Actor.exit();

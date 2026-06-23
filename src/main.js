import { Actor, log } from 'apify';

await Actor.init();

const input = await Actor.getInput();
const {
    searchQueries = [],
    directUrls = [],
    maxResultsPerQuery = 20,
    scrapeReviews = true,
    maxReviewsPerBusiness = 10,
    language = 'en',
    googleMapsApiKey = '',
} = input || {};

if (!searchQueries.length && !directUrls.length) {
    throw new Error('No input! Please provide searchQueries or directUrls.');
}

if (!googleMapsApiKey) {
    throw new Error('Google Maps API Key required! Get one free at console.cloud.google.com');
}

log.info('Starting Google Maps Scraper (API Mode)...', {
    searchQueries: searchQueries.length,
    maxResultsPerQuery,
});

const BASE = 'https://maps.googleapis.com/maps/api';

async function apiGet(url) {
    const res = await fetch(url);
    return res.json();
}

// Text Search → get place_ids
async function searchPlaces(query, maxResults) {
    const places = [];
    let pageToken = null;

    while (places.length < maxResults) {
        let url = `${BASE}/place/textsearch/json?query=${encodeURIComponent(query)}&language=${language}&key=${googleMapsApiKey}`;
        if (pageToken) url += `&pagetoken=${pageToken}`;

        const data = await apiGet(url);

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
            log.error(`Search API error: ${data.status} — ${data.error_message || ''}`);
            break;
        }

        for (const place of (data.results || [])) {
            if (places.length >= maxResults) break;
            places.push(place.place_id);
        }

        if (!data.next_page_token || places.length >= maxResults) break;
        pageToken = data.next_page_token;

        // Google requires ~2s delay before using next_page_token
        await new Promise(r => setTimeout(r, 2000));
    }

    return places;
}

// Place Details → full business data
async function getPlaceDetails(placeId) {
    const fields = [
        'place_id', 'name', 'formatted_address', 'formatted_phone_number',
        'international_phone_number', 'website', 'rating', 'user_ratings_total',
        'price_level', 'opening_hours', 'geometry', 'photos', 'types',
        'business_status', 'url', 'vicinity', 'address_components',
        'editorial_summary', 'reviews', 'plus_code', 'utc_offset',
        'delivery', 'dine_in', 'takeout', 'reservable', 'serves_breakfast',
        'serves_lunch', 'serves_dinner', 'serves_beer', 'serves_wine',
        'serves_vegetarian_food', 'wheelchair_accessible_entrance',
    ].join(',');

    const url = `${BASE}/place/details/json?place_id=${placeId}&fields=${fields}&language=${language}&key=${googleMapsApiKey}`;
    const data = await apiGet(url);

    if (data.status !== 'OK') {
        log.warning(`Details API error for ${placeId}: ${data.status}`);
        return null;
    }

    return data.result;
}

function formatBusiness(place, sourceLabel) {
    const addr = place.address_components || [];
    const getAddrComponent = (type) =>
        addr.find(c => c.types.includes(type))?.long_name || null;

    // Format opening hours
    const hours = {};
    for (const period of (place.opening_hours?.weekday_text || [])) {
        const [day, ...rest] = period.split(': ');
        hours[day] = rest.join(': ');
    }

    // Format reviews
    const reviews = (place.reviews || []).slice(0, 10).map(r => ({
        author: r.author_name,
        rating: r.rating,
        date: r.relative_time_description,
        text: r.text,
        language: r.language,
        profilePhoto: r.profile_photo_url,
    }));

    // Photo URLs (need API key)
    const photos = (place.photos || []).slice(0, 10).map(p =>
        `${BASE}/place/photo?maxwidth=800&photo_reference=${p.photo_reference}&key=${googleMapsApiKey}`
    );

    // Service options
    const serviceOptions = [];
    if (place.delivery) serviceOptions.push('Delivery');
    if (place.dine_in) serviceOptions.push('Dine-in');
    if (place.takeout) serviceOptions.push('Takeout');
    if (place.reservable) serviceOptions.push('Reservations');
    if (place.serves_breakfast) serviceOptions.push('Breakfast');
    if (place.serves_lunch) serviceOptions.push('Lunch');
    if (place.serves_dinner) serviceOptions.push('Dinner');
    if (place.serves_beer) serviceOptions.push('Beer');
    if (place.serves_wine) serviceOptions.push('Wine');
    if (place.serves_vegetarian_food) serviceOptions.push('Vegetarian');
    if (place.wheelchair_accessible_entrance) serviceOptions.push('Wheelchair accessible');

    const priceLevels = { 0: 'Free', 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };

    return {
        placeId: place.place_id,
        name: place.name,
        category: (place.types || []).map(t => t.replace(/_/g, ' ')).slice(0, 5),
        rating: place.rating || null,
        reviewCount: place.user_ratings_total || null,
        priceLevel: priceLevels[place.price_level] || null,
        businessStatus: place.business_status || null,
        address: place.formatted_address || null,
        vicinity: place.vicinity || null,
        street: getAddrComponent('route'),
        city: getAddrComponent('locality') || getAddrComponent('administrative_area_level_2'),
        state: getAddrComponent('administrative_area_level_1'),
        country: getAddrComponent('country'),
        postalCode: getAddrComponent('postal_code'),
        phone: place.formatted_phone_number || null,
        internationalPhone: place.international_phone_number || null,
        website: place.website || null,
        mapsUrl: place.url || null,
        coordinates: place.geometry?.location || null,
        plusCode: place.plus_code?.global_code || null,
        hours,
        isOpenNow: place.opening_hours?.open_now ?? null,
        description: place.editorial_summary?.overview || null,
        photos,
        serviceOptions,
        reviews,
        sourceLabel,
        scrapedAt: new Date().toISOString(),
    };
}

// ── Main execution ──
let totalSaved = 0;

for (const query of searchQueries) {
    log.info(`[SEARCH] "${query}"`);
    const placeIds = await searchPlaces(query, maxResultsPerQuery);
    log.info(`  Found ${placeIds.length} places`);

    for (const placeId of placeIds) {
        const place = await getPlaceDetails(placeId);
        if (!place) continue;

        const business = formatBusiness(place, `search:${query}`);
        await Actor.pushData(business);
        totalSaved++;
        log.info(`  ✅ ${business.name} | ⭐ ${business.rating} | 📞 ${business.phone || 'N/A'}`);

        // Small delay to respect API rate limits
        await new Promise(r => setTimeout(r, 200));
    }
}

// Direct place_id URLs
for (const url of directUrls) {
    const placeIdMatch = url.match(/place_id:([^&]+)/) || url.match(/!1s([^!]+)!/);
    if (placeIdMatch) {
        const place = await getPlaceDetails(placeIdMatch[1]);
        if (place) {
            await Actor.pushData(formatBusiness(place, `direct:${url}`));
            totalSaved++;
        }
    }
}

log.info(`✅ Done! Total businesses saved: ${totalSaved}`);
await Actor.exit();

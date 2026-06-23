# Instagram Profile & Hashtag Scraper

An Apify Actor that scrapes **Instagram profiles** and **hashtag posts** without requiring the official API.

---

## Features

- **Profile Scraper**: Extracts username, full name, bio, followers, following, post count, verification status, and individual post data
- **Hashtag Scraper**: Extracts top posts and recent posts for any hashtag with likes, captions, timestamps, and more
- **Post Details**: Image URL, caption, likes, comments count, timestamp, location, hashtags, mentions
- **Optional Comments**: Scrape comments on each post (configurable limit)
- **Anti-detection**: Random delays, fingerprint spoofing, proxy support
- **Proxy Support**: Works with Apify Residential Proxies (recommended) or your own proxies
- **Session Cookies**: Optionally provide login cookies for better access

---

## Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `scrapeType` | string | `"both"` | `"profile"`, `"hashtag"`, or `"both"` |
| `usernames` | array | `[]` | Instagram usernames (without @) |
| `hashtags` | array | `[]` | Hashtags to scrape (without #) |
| `maxPostsPerProfile` | integer | `12` | Max posts per profile (1–200) |
| `maxPostsPerHashtag` | integer | `20` | Max posts per hashtag (1–500) |
| `scrapeComments` | boolean | `false` | Whether to scrape post comments |
| `maxCommentsPerPost` | integer | `10` | Max comments per post |
| `proxy` | object | Apify Residential | Proxy configuration |
| `loginCookies` | array | `[]` | Optional Instagram session cookies |

---

## Example Input

```json
{
  "scrapeType": "both",
  "usernames": ["natgeo", "nasa"],
  "hashtags": ["travel", "photography"],
  "maxPostsPerProfile": 20,
  "maxPostsPerHashtag": 30,
  "scrapeComments": false,
  "proxy": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Output Data Format

### Profile Result

```json
{
  "type": "profile",
  "scrapedAt": "2024-01-15T10:30:00.000Z",
  "username": "natgeo",
  "fullName": "National Geographic",
  "biography": "The official Instagram of National Geographic...",
  "followers": 280500000,
  "following": 152,
  "postsCount": 30800,
  "isVerified": true,
  "isPrivate": false,
  "profilePicUrl": "https://...",
  "externalUrl": "https://www.nationalgeographic.com",
  "isBusiness": true,
  "posts": [
    {
      "postId": "123456",
      "shortCode": "ABC123",
      "postUrl": "https://www.instagram.com/p/ABC123/",
      "type": "GraphImage",
      "imageUrl": "https://...",
      "caption": "Amazing photo caption #nature",
      "likesCount": 150000,
      "commentsCount": 1200,
      "timestamp": "2024-01-14T12:00:00.000Z",
      "isVideo": false,
      "locationName": "Yellowstone National Park",
      "hashtags": ["#nature", "#wildlife"],
      "mentions": []
    }
  ]
}
```

### Hashtag Result

```json
{
  "type": "hashtag",
  "scrapedAt": "2024-01-15T10:30:00.000Z",
  "hashtag": "travel",
  "hashtagUrl": "https://www.instagram.com/explore/tags/travel/",
  "totalPostsCount": 650000000,
  "posts": [
    {
      "postId": "789012",
      "shortCode": "XYZ789",
      "postUrl": "https://www.instagram.com/p/XYZ789/",
      "hashtag": "travel",
      "imageUrl": "https://...",
      "caption": "Beautiful destination! #travel #adventure",
      "likesCount": 5200,
      "commentsCount": 89,
      "timestamp": "2024-01-15T08:00:00.000Z",
      "ownerUsername": "someuser",
      "isVideo": false
    }
  ]
}
```

---

## Setup on Apify

1. Go to [Apify Console](https://console.apify.com) → **Actors** → **Create new**
2. Upload all files from this folder
3. Set the Dockerfile as the build source
4. Configure your input in the **Input** tab
5. Click **Run**

## Getting Instagram Cookies (Optional but Recommended)

For better scraping results, provide your Instagram session cookies:

1. Log into Instagram in your browser
2. Open DevTools → Application → Cookies → `instagram.com`
3. Copy cookies (especially `sessionid`, `csrftoken`, `ds_user_id`)
4. Paste them as an array in the `loginCookies` input field

---

## Important Notes

- **Rate Limiting**: Instagram aggressively rate-limits scrapers. Use residential proxies and keep delays between requests.
- **Private Profiles**: Private profiles cannot be scraped without being a follower.
- **Terms of Service**: Scraping Instagram may violate their ToS. Use responsibly and for personal/research purposes only.
- **Proxy**: Using Apify Residential Proxies (`RESIDENTIAL` group) is strongly recommended to avoid blocks.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Empty results | Add session cookies or use residential proxy |
| Rate limit errors | Increase delays, reduce concurrency |
| Private profile | Must follow the account first |
| Login wall | Provide `loginCookies` in input |

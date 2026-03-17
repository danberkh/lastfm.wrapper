// Last.fm API helper functions with localStorage caching

const Cache = {
    get(key) {
        try {
            const item = localStorage.getItem('lfm_' + key);
            if (!item) return null;
            const { data, expires } = JSON.parse(item);
            if (Date.now() > expires) {
                localStorage.removeItem('lfm_' + key);
                return null;
            }
            return data;
        } catch { return null; }
    },
    set(key, data) {
        try {
            const expires = Date.now() + CONFIG.CACHE_TTL_HOURS * 3600 * 1000;
            localStorage.setItem('lfm_' + key, JSON.stringify({ data, expires }));
        } catch { /* storage full, skip cache */ }
    }
};

async function lfmFetch(method, params = {}) {
    const cacheKey = method + '_' + JSON.stringify(params);
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    const url = new URL(CONFIG.BASE_URL);
    url.searchParams.set('method', method);
    url.searchParams.set('user', CONFIG.USERNAME);
    url.searchParams.set('api_key', CONFIG.API_KEY);
    url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`Last.fm error ${json.error}: ${json.message}`);

    Cache.set(cacheKey, json);
    return json;
}

// Get user profile info
async function getUserInfo() {
    const data = await lfmFetch('user.getInfo');
    return data.user;
}

// Get top artists for a specific period
async function getTopArtists(period = 'overall', limit = 5) {
    const data = await lfmFetch('user.getTopArtists', { period, limit });
    return data.topartists.artist;
}

// Get top tracks for a specific period
async function getTopTracks(period = 'overall', limit = 5) {
    const data = await lfmFetch('user.getTopTracks', { period, limit });
    return data.toptracks.track;
}

// Get top albums for a specific period
async function getTopAlbums(period = 'overall', limit = 5) {
    const data = await lfmFetch('user.getTopAlbums', { period, limit });
    return data.topalbums.album;
}

// Get weekly chart list (used to find weeks within a year)
async function getWeeklyChartList() {
    const cacheKey = 'weeklychartlist';
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    const data = await lfmFetch('user.getWeeklyChartList');
    const charts = data.weeklychartlist.chart;
    Cache.set(cacheKey, charts);
    return charts;
}

// Get recent tracks between two unix timestamps (for scrobble count per year)
async function getScrobbleCountForYear(year) {
    const cacheKey = `scrobbles_${year}`;
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    const from = Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000);
    const to   = Math.floor(new Date(`${year}-12-31T23:59:59Z`).getTime() / 1000);

    // First page to get total
    const data = await lfmFetch('user.getRecentTracks', {
        from, to, limit: 1, page: 1
    });

    const total = parseInt(data.recenttracks['@attr']?.total || 0, 10);
    Cache.set(cacheKey, total);
    return total;
}

// Get top artists for a specific year using weekly charts
async function getTopArtistsForYear(year) {
    const cacheKey = `topartists_year_${year}`;
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    const from = Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000);
    const to   = Math.floor(new Date(`${year}-12-31T23:59:59Z`).getTime() / 1000);

    // Accumulate from weekly charts
    const charts = await getWeeklyChartList();
    const yearCharts = charts.filter(c => {
        const f = parseInt(c.from);
        return f >= from && f <= to;
    });

    const artistCounts = {};
    // Process weeks sequentially to respect rate limits
    for (const chart of yearCharts) {
        try {
            const res = await lfmFetch('user.getWeeklyArtistChart', {
                from: chart.from, to: chart.to
            });
            const artists = res.weeklyartistchart?.artist || [];
            for (const a of artists) {
                const name = a.name;
                const plays = parseInt(a.playcount || 0, 10);
                artistCounts[name] = (artistCounts[name] || 0) + plays;
            }
        } catch { /* skip failed week */ }
    }

    const sorted = Object.entries(artistCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, playcount]) => ({ name, playcount }));

    Cache.set(cacheKey, sorted);
    return sorted;
}

// Get top tracks for a specific year using weekly charts
async function getTopTracksForYear(year) {
    const cacheKey = `toptracks_year_${year}`;
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    const from = Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000);
    const to   = Math.floor(new Date(`${year}-12-31T23:59:59Z`).getTime() / 1000);

    const charts = await getWeeklyChartList();
    const yearCharts = charts.filter(c => {
        const f = parseInt(c.from);
        return f >= from && f <= to;
    });

    const trackCounts = {};
    for (const chart of yearCharts) {
        try {
            const res = await lfmFetch('user.getWeeklyTrackChart', {
                from: chart.from, to: chart.to
            });
            const tracks = res.weeklytrackchart?.track || [];
            for (const t of tracks) {
                const key = `${t.name}|||${t.artist['#text']}`;
                const plays = parseInt(t.playcount || 0, 10);
                trackCounts[key] = {
                    plays: (trackCounts[key]?.plays || 0) + plays,
                    name: t.name,
                    artist: t.artist['#text'],
                    url: t.url
                };
            }
        } catch { /* skip */ }
    }

    const sorted = Object.values(trackCounts)
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 5);

    Cache.set(cacheKey, sorted);
    return sorted;
}

// Get top albums for a specific year using weekly charts
async function getTopAlbumsForYear(year) {
    const cacheKey = `topalbums_year_${year}`;
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    const from = Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000);
    const to   = Math.floor(new Date(`${year}-12-31T23:59:59Z`).getTime() / 1000);

    const charts = await getWeeklyChartList();
    const yearCharts = charts.filter(c => {
        const f = parseInt(c.from);
        return f >= from && f <= to;
    });

    const albumCounts = {};
    for (const chart of yearCharts) {
        try {
            const res = await lfmFetch('user.getWeeklyAlbumChart', {
                from: chart.from, to: chart.to
            });
            const albums = res.weeklyalbumchart?.album || [];
            for (const a of albums) {
                const key = `${a.name}|||${a.artist['#text']}`;
                const plays = parseInt(a.playcount || 0, 10);
                albumCounts[key] = {
                    plays: (albumCounts[key]?.plays || 0) + plays,
                    name: a.name,
                    artist: a.artist['#text']
                };
            }
        } catch { /* skip */ }
    }

    const sorted = Object.values(albumCounts)
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 5);

    Cache.set(cacheKey, sorted);
    return sorted;
}

// Get top tags for an artist
async function getArtistTags(artistName) {
    const cacheKey = `artisttags_${artistName}`;
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    try {
        const data = await lfmFetch('artist.getTopTags', { artist: artistName });
        const tags = data.toptags?.tag?.slice(0, 5).map(t => t.name) || [];
        Cache.set(cacheKey, tags);
        return tags;
    } catch { return []; }
}

// Get monthly scrobble counts for a given year (for bar chart)
async function getMonthlyScrobbles(year) {
    const cacheKey = `monthly_${year}`;
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    const months = [];
    for (let m = 0; m < 12; m++) {
        const startDate = new Date(Date.UTC(year, m, 1));
        const endDate   = new Date(Date.UTC(year, m + 1, 0, 23, 59, 59));
        if (startDate > new Date()) {
            months.push(0);
            continue;
        }
        const from = Math.floor(startDate.getTime() / 1000);
        const to   = Math.floor(endDate.getTime() / 1000);
        try {
            const data = await lfmFetch('user.getRecentTracks', {
                from, to, limit: 1, page: 1
            });
            months.push(parseInt(data.recenttracks['@attr']?.total || 0, 10));
        } catch {
            months.push(0);
        }
    }

    Cache.set(cacheKey, months);
    return months;
}

// Get artist image from Last.fm (via artist.getInfo)
async function getArtistImage(artistName) {
    const cacheKey = `artistimg_${artistName}`;
    const cached = Cache.get(cacheKey);
    if (cached !== null) return cached;

    try {
        const data = await lfmFetch('artist.getInfo', { artist: artistName });
        const images = data.artist?.image || [];
        // Get largest image available
        const large = images.find(i => i.size === 'extralarge') ||
                      images.find(i => i.size === 'large') ||
                      images[images.length - 1];
        const url = large?.['#text'] || '';
        Cache.set(cacheKey, url);
        return url;
    } catch {
        Cache.set(cacheKey, '');
        return '';
    }
}

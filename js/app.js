// Main application logic

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
let currentYear = CONFIG.END_YEAR;
let yearDataCache = {};

// ── DOM helpers ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
};

// ── Init ───────────────────────────────────────────────────────
async function init() {
    buildTimeline();
    await loadProfile();
    await loadYear(CONFIG.END_YEAR);
}

// ── Profile ────────────────────────────────────────────────────
async function loadProfile() {
    try {
        const user = await getUserInfo();
        const avatarSrc = user.image?.find(i => i.size === 'extralarge')?.['#text'] || '';

        $('profile-avatar').src = avatarSrc || 'https://lastfm.freetls.fastly.net/i/u/avatar170s/818148bf682d429dc215c1705eb27b98.png';
        $('profile-name').textContent = user.realname || user.name;
        $('profile-username').textContent = `@${user.name}`;
        $('profile-scrobbles').textContent = Number(user.playcount).toLocaleString();
        $('profile-country').textContent = user.country || '';
        $('profile-since').textContent = new Date(parseInt(user.registered.unixtime) * 1000).getFullYear();
        $('profile-section').classList.add('loaded');
    } catch (e) {
        console.error('Profile load error:', e);
    }
}

// ── Timeline ───────────────────────────────────────────────────
function buildTimeline() {
    const container = $('timeline');
    for (let y = CONFIG.END_YEAR; y >= CONFIG.START_YEAR; y--) {
        const btn = el('button', 'year-btn', y.toString());
        btn.dataset.year = y;
        btn.addEventListener('click', () => selectYear(y));
        container.appendChild(btn);
    }
}

function selectYear(year) {
    currentYear = year;
    document.querySelectorAll('.year-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.year) === year);
    });
    loadYear(year);
}

// ── Year data ──────────────────────────────────────────────────
async function loadYear(year) {
    showLoader(true);
    clearYearContent();
    $('year-title').textContent = year;

    try {
        // Load scrobble count first
        const count = await getScrobbleCountForYear(year);
        $('year-scrobbles').textContent = Number(count).toLocaleString() + ' scrobbles';

        // YoY Comparison
        if (year > CONFIG.START_YEAR) {
            const prevCount = await getScrobbleCountForYear(year - 1);
            if (prevCount > 0) {
                const diff = count - prevCount;
                const pct = ((diff / prevCount) * 100).toFixed(1);
                const sign = diff >= 0 ? '+' : '';
                $('year-scrobbles').innerHTML += ` <small style="color: var(--muted); font-size: 0.8rem; font-weight: 400;">(${sign}${pct}% vs ${year-1})</small>`;
            }
        }

        showLoader(false);
        renderLoadingCards();

        // Load all stats
        const [artists, tracks, albums] = await Promise.all([
            getTopArtistsForYear(year),
            getTopTracksForYear(year),
            getTopAlbumsForYear(year)
        ]);

        await renderArtists(artists);
        renderTracks(tracks);
        renderAlbums(albums);
        renderGenres(artists); // Driven by top artists

        const monthly = await getMonthlyScrobbles(year);
        renderMonthlyChart(monthly);
    } catch (e) {
        console.error(`Error loading year ${year}:`, e);
        $('year-content').innerHTML = `<p class="error-msg">Error cargando datos para ${year}. Reintentando...</p>`;
        showLoader(false);
    }
}

function clearYearContent() {
    $('artists-list').innerHTML = '';
    $('tracks-list').innerHTML = '';
    $('albums-list').innerHTML = '';
    $('genres-list').innerHTML = '';
    $('chart-bars').innerHTML = '';
    $('year-scrobbles').textContent = '...';
}

function renderLoadingCards() {
    for (const listId of ['artists-list', 'tracks-list', 'albums-list']) {
        const list = $(listId);
        list.innerHTML = '';
        for (let i = 0; i < 5; i++) {
            list.appendChild(el('div', 'card skeleton'));
        }
    }
}

// ── Artists ────────────────────────────────────────────────────
async function renderArtists(artists) {
    const list = $('artists-list');
    list.innerHTML = '';

    for (let i = 0; i < artists.length; i++) {
        const a = artists[i];
        const card = el('div', 'card artist-card');
        card.innerHTML = `
            <div class="rank">#${i + 1}</div>
            <div class="artist-img-wrap">
                <img class="artist-img" src="" alt="${a.name}" loading="lazy">
            </div>
            <div class="card-info">
                <span class="card-name">${a.name}</span>
                <span class="card-plays">${Number(a.playcount).toLocaleString()} plays</span>
            </div>`;
        list.appendChild(card);

        // Load image asynchronously
        const img = card.querySelector('.artist-img');
        getArtistImage(a.name).then(url => {
            img.src = url || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="%23333" width="1" height="1"/></svg>';
        });

        // Staggered animation
        setTimeout(() => card.classList.add('visible'), 80 * i);

        // Update background if it's the #1 artist
        if (i === 0) {
            updateDynamicBackground(a.name);
        }
    }
}

async function updateDynamicBackground(artistName) {
    // Generate two colors based on name string as fallback or seed
    const hash = artistName.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
    }, 0);
    
    const h1 = Math.abs(hash % 360);
    const h2 = (h1 + 60) % 360;
    
    document.body.style.setProperty('--bg-accent', `hsla(${h1}, 70%, 20%, 0.4)`);
    document.body.style.setProperty('--bg-accent2', `hsla(${h2}, 70%, 20%, 0.4)`);
}

function toggleShareMode() {
    const isShare = document.body.classList.toggle('share-mode');
    $('exit-share').style.display = isShare ? 'block' : 'none';
}

// ── Tracks ─────────────────────────────────────────────────────
function renderTracks(tracks) {
    const list = $('tracks-list');
    list.innerHTML = '';

    tracks.forEach((t, i) => {
        const card = el('div', 'card track-card');
        card.innerHTML = `
            <div class="rank">#${i + 1}</div>
            <div class="card-info">
                <span class="card-name">${t.name}</span>
                <span class="card-artist">${t.artist}</span>
                <span class="card-plays">${Number(t.plays).toLocaleString()} plays</span>
            </div>`;
        list.appendChild(card);
        setTimeout(() => card.classList.add('visible'), 80 * i);
    });
}
// ── Albums ─────────────────────────────────────────────────────
function renderAlbums(albums) {
    const list = $('albums-list');
    list.innerHTML = '';

    albums.forEach((alb, i) => {
        const card = el('div', 'card album-card');
        card.innerHTML = `
            <div class="rank">#${i + 1}</div>
            <div class="card-info">
                <span class="card-name">${alb.name}</span>
                <span class="card-artist">${alb.artist}</span>
                <span class="card-plays">${Number(alb.plays).toLocaleString()} plays</span>
            </div>`;
        list.appendChild(card);
        setTimeout(() => card.classList.add('visible'), 80 * i);
    });
}

// ── Genres ─────────────────────────────────────────────────────
async function renderGenres(artists) {
    const list = $('genres-list');
    list.innerHTML = '';
    
    const tagCounts = {};
    // Fetch tags for top 5 artists
    const tagResults = await Promise.all(artists.map(a => getArtistTags(a.name)));
    
    tagResults.forEach(tags => {
        tags.forEach(tag => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        });
    });

    const sortedTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    sortedTags.forEach(([tag, count], i) => {
        const badge = el('span', 'tag-badge', tag);
        list.appendChild(badge);
        setTimeout(() => {
            badge.style.opacity = '1';
            badge.style.transform = 'none';
        }, 50 * i);
    });
}

// ── Monthly bar chart ──────────────────────────────────────────
function renderMonthlyChart(monthly) {
    const container = $('chart-bars');
    container.innerHTML = '';
    const max = Math.max(...monthly, 1);

    monthly.forEach((count, i) => {
        const pct = Math.round((count / max) * 100);
        const bar = el('div', 'bar-wrap');
        bar.innerHTML = `
            <div class="bar-label">${count > 0 ? count.toLocaleString() : ''}</div>
            <div class="bar" style="--h:${pct}%" title="${MONTHS[i]}: ${count.toLocaleString()} plays">
                <div class="bar-fill"></div>
            </div>
            <div class="bar-month">${MONTHS[i]}</div>`;
        container.appendChild(bar);
        setTimeout(() => bar.querySelector('.bar').classList.add('grown'), 60 * i);
    });
}

// ── Loader ─────────────────────────────────────────────────────
function showLoader(show) {
    $('loader').style.display = show ? 'flex' : 'none';
}

// ── Start ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

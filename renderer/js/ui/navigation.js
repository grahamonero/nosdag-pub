// ==================== NAVIGATION & HAMBURGER MENU ====================
// Handles new minimal header, hamburger menu, feed tabs, and welcome banner

// Nosdag: the header relay pill must reflect the posture — in anonymous mode reads come
// from the onion selection, not the configured clearnet list.
import * as OnionRelays from '../nosdag/onion-relays.js';

// Security helper: Validate image URLs to prevent XSS
function sanitizeImageUrl(url) {
    if (!url || typeof url !== 'string') {
        return '/default-avatar.png';
    }

    const trimmedUrl = url.trim();

    // Allow only safe protocols
    if (trimmedUrl.startsWith('https://') ||
        trimmedUrl.startsWith('http://') ||
        trimmedUrl.startsWith('data:image/')) {
        return trimmedUrl;
    }

    // Default to safe fallback for invalid protocols
    return '/default-avatar.png';
}

// Import modules lazily to avoid circular dependencies
let State = null;
let Posts = null;

async function ensureStateLoaded() {
    if (!State) {
        State = await import('../state.js');
    }
    return State;
}

async function ensurePostsLoaded() {
    if (!Posts) {
        Posts = await import('../posts.js');
    }
    return Posts;
}

// ===================
// TIP QUEUE BADGE (left rail)
// ===================

// Update the Tip Queue count badges: the left rail (#ndQueueCount, row may
// be gone) and the Tip Queue tab inside the Tip Jar (#ndQueueTabCount, strip
// only exists once the wallet modal has been opened). Both null-guarded.
export function updateMenuQueueCount() {
    const countEl = document.getElementById('ndQueueCount');
    const tabCountEl = document.getElementById('ndQueueTabCount');
    if (!countEl && !tabCountEl) return;

    const hideBadges = () => {
        if (countEl) countEl.style.display = 'none';
        if (tabCountEl) tabCountEl.style.display = 'none';
    };

    // Don't show queue count if not logged in
    const pubkey = localStorage.getItem('nostr-public-key');
    if (!pubkey) {
        hideBadges();
        return;
    }

    const StateModule = window.NostrState || {};
    let queue = StateModule.zapQueue;

    if (!queue) {
        try {
            queue = JSON.parse(localStorage.getItem('zapQueue') || '[]');
        } catch (e) {
            console.error('Failed to parse zapQueue from localStorage:', e);
            queue = [];
        }
    }

    if (queue.length > 0) {
        if (countEl) {
            countEl.textContent = queue.length;
            countEl.style.display = 'inline-flex';
        }
        if (tabCountEl) {
            tabCountEl.textContent = queue.length;
            tabCountEl.style.display = 'inline-flex';
        }
    } else {
        hideBadges();
    }
}

// ===================
// FEED TABS
// ===================

export async function handleFeedTabClick(feedType, event) {
    // event may be null when this is dispatched from the hamburger menu
    // rather than an actual feed-tab click.
    event?.preventDefault?.();

    // Load State module to check current page
    const StateModule = await ensureStateLoaded();

    // First, navigate to home page (this will hide thread/messages/profile/etc and show feed)
    // Only navigate if we're not already on home page
    // Use skipHistory=true since we're about to push our own history state
    // Use skipFeedLoad=true to prevent loading the default Following feed (we'll load the correct feed below)
    if (StateModule.currentPage !== 'home' && typeof window.navigateTo === 'function') {
        window.navigateTo('home', true, true); // skipHistory=true, skipFeedLoad=true
        // Wait for page transition and following list to load (needed for Web of Trust feed)
        // Web of Trust requires State.followingUsers to be populated
        if (feedType === 'global' && StateModule.publicKey) {
            // Wait for following list to be loaded (up to 2 seconds)
            let attempts = 0;
            while (StateModule.followingUsers.size === 0 && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
        } else {
            // Standard 300ms delay for other feeds
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    // Push feed change to browser history
    const feedNames = {
        'global': 'suggestedfollows',
        'following': 'following',
        'monero': 'trendingmonero',
        'trending': 'trending',
        'live': 'live'
    };
    const feedPath = feedNames[feedType] || feedType;
    history.pushState(
        { page: 'home', feed: feedType },
        '',
        `/feed/${feedPath}`
    );

    // Update active tab styling — only when triggered from a real click on a tab.
    // The hamburger-dispatch path passes a null event for tabs that don't
    // appear in the top nav (e.g. Suggested Follows).
    document.querySelectorAll('.feed-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    if (event?.target?.classList) {
        event.target.classList.add('active');
    }

    // Show the Following quick-toggle chip only on the Following feed for
    // logged-in users (anonymous users get redirected to Trending), and sync
    // its checked state from localStorage each time we land there.
    const followingChip = document.getElementById('followingFeedChip');
    if (followingChip) {
        const showChip = feedType === 'following' && !!StateModule.publicKey;
        followingChip.style.display = showChip ? 'block' : 'none';
        if (showChip) {
            const chipBox = document.getElementById('followingChipShowOwn');
            if (chipBox) chipBox.checked = localStorage.getItem('show-own-notes-in-following') !== 'false';
        }
    }

    // Ensure Posts module is loaded
    const PostsModule = await ensurePostsLoaded();

    // Handle different feed types
    switch(feedType) {
        case 'global':
            // Web of Trust feed: Notes from users followed by people you follow
            // Shows content from your extended network (friends-of-friends)
            console.log('Loading Web of Trust feed...');
            PostsModule.loadWebOfTrustFeed();
            break;
        case 'following':
            // Your personal feed: Posts from only people you directly follow
            console.log('Loading Following feed...');
            PostsModule.loadStreamingHomeFeed();
            break;
        case 'monero':
            // Trending Monero feed: Popular posts about Monero/privacy (default for anonymous)
            console.log('Loading Monero feed...');
            PostsModule.loadTrendingFeed(); // Use existing trending function
            break;
        case 'trending':
            // Trending feed: Popular notes across all topics
            console.log('Loading Trending Notes feed...');
            PostsModule.loadTrendingAllFeed();
            break;
        case 'live':
            // Live streams feed: NIP-53 live activities
            console.log('Loading Live Streams feed...');
            // Import and load livestream module
            try {
                const Livestream = await import('../livestream.js');
                Livestream.renderLivestreamFeed();
            } catch (err) {
                console.error('Failed to load livestream module:', err);
            }
            break;
        case 'articles':
            // NIP-23 long-form articles feed (kind 30023)
            console.log('Loading Articles feed...');
            try {
                const Articles = await import('../articles.js');
                Articles.loadArticlesFeed();
            } catch (err) {
                console.error('Failed to load articles module:', err);
            }
            break;
    }
}

// ===================
// WELCOME BANNER
// ===================

export function closeWelcomeBanner() {
    const banner = document.getElementById('welcomeBanner');
    if (!banner) {
        console.warn('Welcome banner element not found');
        return;
    }

    banner.classList.add('hidden');
    localStorage.setItem('welcomeBannerClosed', 'true');
}

export async function showWelcomeBannerIfNeeded() {
    // Only show for anonymous users
    const StateModule = await ensureStateLoaded();

    let storedPublicKey = null;
    try {
        storedPublicKey = localStorage.getItem('nostr-public-key');
    } catch (e) {
        console.error('Failed to access localStorage:', e);
    }

    const isLoggedIn = StateModule.publicKey !== null || storedPublicKey !== null;

    let bannerClosed = false;
    try {
        bannerClosed = localStorage.getItem('welcomeBannerClosed') === 'true';
    } catch (e) {
        console.error('Failed to access localStorage:', e);
    }

    console.log('🎉 Checking welcome banner - isLoggedIn:', isLoggedIn, 'bannerClosed:', bannerClosed);

    if (!isLoggedIn && !bannerClosed) {
        const banner = document.getElementById('welcomeBanner');
        if (banner) {
            console.log('  ✅ Showing welcome banner');
            banner.classList.remove('hidden');
        }
    }
}

export function handleCreateKeysAndPost() {
    // Show create account modal
    if (typeof window.showCreateAccount === 'function') {
        window.showCreateAccount();
    }
}

export function showWhatIsNostr() {
    if (typeof window.showToast === 'function') {
        window.showToast('Nostr is a decentralized social protocol. Your identity is a cryptographic key pair, giving you true ownership of your data. No company can ban you or censor your posts.', 'info', 8000);
    } else {
        console.log('Nostr is a decentralized social protocol. Your identity is a cryptographic key pair, giving you true ownership of your data. No company can ban you or censor your posts.');
    }
}

export function showWhatIsMonero() {
    if (typeof window.showToast === 'function') {
        window.showToast('Monero (XMR) is a privacy-focused cryptocurrency. Transactions are completely private and untraceable, making it ideal for confidential payments and tips.', 'info', 8000);
    } else {
        console.log('Monero (XMR) is a privacy-focused cryptocurrency. Transactions are completely private and untraceable, making it ideal for confidential payments and tips.');
    }
}

// ===================
// HEADER BUTTONS
// ===================

export async function handleCreateNoteClick() {
    const StateModule = await ensureStateLoaded();

    let storedPublicKey = null;
    try {
        storedPublicKey = localStorage.getItem('nostr-public-key');
    } catch (e) {
        console.error('Failed to access localStorage:', e);
    }

    const isLoggedIn = StateModule.publicKey !== null || storedPublicKey !== null;

    if (isLoggedIn) {
        // Logged in: show inline compose
        if (typeof window.toggleCompose === 'function') {
            window.toggleCompose();
        }
    } else {
        // Anonymous: show modal to create keys
        handleCreateKeysAndPost();
    }
}

export function showLoginOptions() {
    // Show login modal with all login options
    const modal = document.createElement('div');
    modal.id = 'loginOptionsModal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;';

    // Create modal container
    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'background: var(--darker-bg); border: 1px solid var(--border-color); border-radius: 16px; padding: 2rem; max-width: 400px; width: 90%;';

    // Create header
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;';

    const title = document.createElement('h2');
    title.style.cssText = 'margin: 0; color: var(--text-primary);';
    title.textContent = 'Login to Nosdag';

    // Store event listeners for cleanup
    const cleanupModal = () => {
        modal.remove();
    };

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background: none; border: none; color: var(--text-secondary); font-size: 1.5rem; cursor: pointer;';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', cleanupModal);

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Create buttons container
    const buttonsContainer = document.createElement('div');
    buttonsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 0.75rem;';

    // Create New Account button
    const createAccountBtn = document.createElement('button');
    createAccountBtn.style.cssText = 'width: 100%; padding: 0.75rem 1rem; background: linear-gradient(135deg, var(--nd-accent), var(--nd-accent)); border: none; color: white; border-radius: 8px; cursor: pointer; font-size: 1rem; font-weight: 600; transition: transform 0.2s;';
    createAccountBtn.textContent = '🆕 Create New Account';
    const handleCreateAccount = () => {
        if (typeof window.showCreateAccount === 'function') {
            window.showCreateAccount();
        }
        cleanupModal();
    };
    createAccountBtn.addEventListener('click', handleCreateAccount);

    // Login with nsec button
    const loginNsecBtn = document.createElement('button');
    loginNsecBtn.style.cssText = 'width: 100%; padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; cursor: pointer; font-size: 1rem; transition: all 0.2s;';
    loginNsecBtn.textContent = '🔑 Login with nsec';
    const handleLoginNsec = () => {
        if (typeof window.showLoginWithNsec === 'function') {
            window.showLoginWithNsec();
        }
        cleanupModal();
    };
    loginNsecBtn.addEventListener('click', handleLoginNsec);

    // Use Amber button
    const amberBtn = document.createElement('button');
    amberBtn.style.cssText = 'width: 100%; padding: 0.75rem 1rem; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; cursor: pointer; font-size: 1rem; transition: all 0.2s;';
    amberBtn.textContent = '📱 Use Amber (Android)';
    const handleAmber = () => {
        if (typeof window.showLoginWithAmber === 'function') {
            window.showLoginWithAmber();
        }
        cleanupModal();
    };
    amberBtn.addEventListener('click', handleAmber);

    // Append all buttons
    buttonsContainer.appendChild(createAccountBtn);
    buttonsContainer.appendChild(loginNsecBtn);
    buttonsContainer.appendChild(amberBtn);

    // Assemble modal
    modalContent.appendChild(header);
    modalContent.appendChild(buttonsContainer);
    modal.appendChild(modalContent);

    // Close on overlay click
    const handleOverlayClick = (e) => {
        if (e.target === modal) {
            cleanupModal();
        }
    };
    modal.addEventListener('click', handleOverlayClick);

    document.body.appendChild(modal);
}

export async function updateHeaderUIForAuthState() {
    // Load State module to check publicKey
    const StateModule = await ensureStateLoaded();

    // Trust State.publicKey as the authoritative source
    // If State module has loaded but publicKey is null, user is NOT logged in
    // (even if localStorage has stale keys)
    const isLoggedIn = StateModule.publicKey !== null && StateModule.publicKey !== undefined;

    const loginBtn = document.getElementById('headerLoginBtn');
    const createAccountBtn = document.getElementById('headerCreateAccountBtn');
    const createNoteBtn = document.getElementById('headerCreateNoteBtn');
    const ndLogout = document.getElementById('ndLogout');
    const notificationsBtn = document.getElementById('headerNotificationsBtn');

    console.log('🔄 updateHeaderUIForAuthState called');
    console.log('  - State.publicKey:', StateModule.publicKey ? StateModule.publicKey.substring(0, 16) + '...' : 'null');
    console.log('  - isLoggedIn:', isLoggedIn);

    if (isLoggedIn) {
        // Logged in: show create note, hide login/create account, show rail logout, show notifications
        console.log('  ✅ User is logged in');
        if (loginBtn) loginBtn.style.display = 'none';
        if (createAccountBtn) createAccountBtn.style.display = 'none';
        if (createNoteBtn) createNoteBtn.style.display = 'flex';
        if (ndLogout) ndLogout.style.display = 'flex';
        if (notificationsBtn) notificationsBtn.style.display = 'flex';
        updateMenuQueueCount();
    } else {
        // Anonymous: show login/create account buttons, hide create note + rail logout, hide notifications
        console.log('  ❌ User is anonymous - showing Login/Create Account buttons');
        if (loginBtn) loginBtn.style.display = 'flex';
        if (createAccountBtn) createAccountBtn.style.display = 'flex';
        if (createNoteBtn) createNoteBtn.style.display = 'none';
        if (ndLogout) ndLogout.style.display = 'none';
        if (notificationsBtn) notificationsBtn.style.display = 'none';
        updateMenuQueueCount();
    }
}

// ===================
// RELAY INDICATOR
// ===================

export function updateRelayIndicator(count) {
    const relayCount = document.getElementById('relayCount');
    if (!relayCount) return;
    // Anonymous mode: feeds read from the onion selection — show that, not the clearnet config.
    if (OnionRelays.getPosture() === 'tor') {
        const n = OnionRelays.selectedUrls().length;
        relayCount.textContent = `${n} onion relay${n === 1 ? '' : 's'} · Tor`;
        return;
    }
    const relayText = count === 1 ? 'relay' : 'relays';
    relayCount.textContent = count + ' ' + relayText + ' connected';
}

// ===================
// INITIALIZATION
// ===================

// Initialize UI when DOM is ready
export async function initNavigation() {
    console.log('🚀 UI Navigation - Initializing');

    // Show welcome banner if needed
    await showWelcomeBannerIfNeeded();

    // Update header UI based on login state
    console.log('🚀 Calling updateHeaderUIForAuthState from initNavigation');
    await updateHeaderUIForAuthState();

    // Set default active feed tab to Following
    const followingTab = document.querySelector('.feed-tab[data-feed="following"]');
    if (followingTab) {
        followingTab.classList.add('active');
    }

    // Also call again after a short delay in case app.js hasn't restored session yet
    setTimeout(async () => {
        console.log('🚀 Calling updateHeaderUIForAuthState again after 500ms delay');
        await updateHeaderUIForAuthState();
    }, 500);

    // And again after app initialization should be complete
    setTimeout(async () => {
        console.log('🚀 Final updateHeaderUIForAuthState call after 2s');
        await updateHeaderUIForAuthState();
    }, 2000);
}

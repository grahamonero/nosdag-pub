// ==================== USER PROFILE VIEWING MODULE ====================
// Handles profile viewing, follow/unfollow, and profile page rendering

import { showWarningToast, showSuccessToast, showErrorToast } from './toasts.js';
import { showSkeletonLoader } from './skeleton.js';
import * as PaywallUI from '../paywall-ui.js';

// Track where user came from for back navigation
let previousPage = 'home';

// Track profile page state
let cachedProfilePosts = [];
let displayedProfilePostCount = 0;
const PROFILE_POSTS_PER_PAGE = 30;

// Track following list
let followingList = new Set();

// ==================== TIMEOUT CONSTANTS ====================
const TIMEOUTS = {
    POST_LOAD: 8000,           // Loading user posts
    REPOST_FETCH: 3000,        // Fetching original posts for reposts
    FOLLOW_COUNT: 5000,        // Following/followers count fetch
    ANIMATION: 300             // Post removal animation
};

// ==================== UTILITY FUNCTIONS ====================

// Fallback HTML for posts that fail to render
const POST_RENDER_ERROR_HTML = `
    <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
        <div style="color: #666; font-size: 12px;">Error rendering post</div>
    </div>
`;

// Generate Load More button HTML for profile posts
function renderLoadMoreButton(remainingCount) {
    if (remainingCount <= 0) return '';
    return `
        <div id="profileLoadMoreContainer" style="text-align: center; padding: 20px; border-top: 1px solid #333;">
            <button onclick="loadMoreProfilePosts()" style="background: linear-gradient(135deg, var(--nd-accent-hi), var(--nd-accent)); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;">
                Load More Posts (${remainingCount} available)
            </button>
        </div>
    `;
}

/**
 * Immediately remove posts from an unfollowed user from the Following feed
 * @param {string} pubkey - The pubkey of the unfollowed user
 */
function purgeUnfollowedUserPosts(pubkey) {
    try {
        // Only purge if we're on the Following feed
        const activeTab = document.querySelector('.feed-tab.active');
        const isFollowingFeed = activeTab?.dataset?.feed === 'following';

        if (!isFollowingFeed) {
            console.log('Not on Following feed, skipping purge');
            return;
        }

        // Find all posts from this user in the feed
        const feed = document.getElementById('feed');
        if (!feed) return;

        // Posts have data-pubkey attribute or we can check the author info
        const postsToRemove = [];
        const allPosts = feed.querySelectorAll('.post');

        allPosts.forEach(post => {
            // Check data-pubkey attribute first
            const postPubkey = post.dataset.pubkey;
            if (postPubkey === pubkey) {
                postsToRemove.push(post);
                return;
            }

            // Also check for username element with data-pubkey
            const usernameEl = post.querySelector('.username[data-pubkey]');
            if (usernameEl?.dataset.pubkey === pubkey) {
                postsToRemove.push(post);
                return;
            }

            // Check avatar onclick for viewUserProfilePage call with this pubkey
            const avatar = post.querySelector('.avatar');
            if (avatar?.onclick?.toString().includes(pubkey)) {
                postsToRemove.push(post);
            }
        });

        // Remove posts with fade animation
        postsToRemove.forEach(post => {
            post.style.transition = 'opacity 0.3s, max-height 0.3s, margin 0.3s, padding 0.3s';
            post.style.opacity = '0';
            post.style.maxHeight = '0';
            post.style.marginTop = '0';
            post.style.marginBottom = '0';
            post.style.paddingTop = '0';
            post.style.paddingBottom = '0';
            post.style.overflow = 'hidden';

            setTimeout(() => {
                post.remove();
            }, TIMEOUTS.ANIMATION);
        });

        if (postsToRemove.length > 0) {
            console.log(`Purged ${postsToRemove.length} posts from unfollowed user ${pubkey.substring(0, 8)}...`);
        }

    } catch (error) {
        console.error('Error purging unfollowed user posts:', error);
    }
}

// ==================== PROFILE VIEWING ====================

// Wire Notes/Articles tab switching on the full-page profile. Mirrors the
// right-panel profile's pattern: lazy-load articles on first click, swap
// visibility of the two containers. Idempotent.
function wireProfilePageTabs(pubkey) {
    const tabs = document.querySelectorAll('.profile-tab');
    if (!tabs || !tabs.length) return;
    const notesBox = document.getElementById('userPostsContainer');
    const articlesBox = document.getElementById('userArticlesContainer');
    const highlightsBox = document.getElementById('userHighlightsContainer');
    let articlesLoaded = false;
    let highlightsLoaded = false;

    const activate = (which) => {
        tabs.forEach(t => {
            const isActive = t.dataset.profileTab === which;
            t.classList.toggle('active', isActive);
            t.style.color = isActive
                ? 'var(--text-primary)'
                : 'var(--text-secondary, #888)';
            t.style.borderBottomColor = isActive
                ? 'var(--accent-color, #f60)'
                : 'transparent';
        });
        if (notesBox) notesBox.style.display = (which === 'notes') ? '' : 'none';
        if (articlesBox) articlesBox.style.display = (which === 'articles') ? '' : 'none';
        if (highlightsBox) highlightsBox.style.display = (which === 'highlights') ? '' : 'none';

        if (which === 'articles' && !articlesLoaded) {
            articlesLoaded = true;
            fetchUserArticles(pubkey).catch(e => {
                console.warn('Failed to fetch profile articles:', e);
                if (articlesBox) {
                    articlesBox.innerHTML = '<div style="padding: 24px; color: #aaa; text-align: center;">Failed to load articles.</div>';
                }
            });
        }
        if (which === 'highlights' && !highlightsLoaded) {
            highlightsLoaded = true;
            fetchUserHighlights(pubkey).catch(e => {
                console.warn('Failed to fetch profile highlights:', e);
                if (highlightsBox) {
                    highlightsBox.innerHTML = '<div style="padding: 24px; color: #aaa; text-align: center;">Failed to load highlights.</div>';
                }
            });
        }
    };

    tabs.forEach(tab => {
        tab.addEventListener('click', (ev) => {
            ev.preventDefault();
            activate(tab.dataset.profileTab);
        });
    });
}

// Fetch and render kind-9802 highlights for the full-page profile view (NIP-84).
async function fetchUserHighlights(pubkey) {
    const box = document.getElementById('userHighlightsContainer');
    if (!box) return;
    box.innerHTML = '<div style="padding: 24px; text-align: center; color: #888;">Loading highlights…</div>';
    try {
        const Highlights = await import('../highlights.js');
        const events = await Highlights.fetchHighlightsByAuthor(pubkey, { limit: 50 });
        if (!events.length) {
            box.innerHTML = '<div style="padding: 24px; color: #888; text-align: center;">No highlights yet.</div>';
            return;
        }
        box.innerHTML = `<div class="highlights-feed" style="padding: 12px;">${
            events.map(ev => Highlights.renderHighlightCard(ev)).join('')
        }</div>`;
        Highlights.wireHighlightHandlers(box);
    } catch (e) {
        console.error('fetchUserHighlights failed:', e);
        box.innerHTML = '<div style="padding: 24px; color: #aaa; text-align: center;">Failed to load highlights.</div>';
    }
}

// Fetch and render kind-30023 articles for the full-page profile view.
async function fetchUserArticles(pubkey) {
    const box = document.getElementById('userArticlesContainer');
    if (!box) return;
    box.innerHTML = '<div style="padding: 24px; text-align: center; color: #888;">Loading articles…</div>';
    try {
        const Articles = await import('../articles.js');
        const events = await Articles.queryArticles({ authors: [pubkey], limit: 30 });
        if (!events.length) {
            box.innerHTML = '<div style="padding: 24px; color: #888; text-align: center;">No articles yet.</div>';
            return;
        }
        box.innerHTML = `<div class="articles-feed" style="padding: 12px;">${
            events.map(ev => Articles.renderArticleCard(ev)).join('')
        }</div>`;
        Articles.wireArticleHandlers(box);
    } catch (e) {
        console.error('fetchUserArticles failed:', e);
        box.innerHTML = '<div style="padding: 24px; color: #aaa; text-align: center;">Failed to load articles.</div>';
    }
}

async function fetchUserPosts(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule, UtilsModule, PostsModule] = await Promise.all([
            import('../state.js'),
            import('../relays.js'),
            import('../utils.js'),
            import('../posts.js')
        ]);

        const userPostsContainer = document.getElementById('userPostsContainer');
        if (!userPostsContainer) return;

        const rawEvents = [];
        const processedIds = new Set();
        const repostEventIdsToFetch = []; // For reposts with only 'e' tag (no embedded content)
        let hasReceivedPosts = false;

        // Create timeout for loading
        const timeout = setTimeout(async () => {
            if (!hasReceivedPosts) {
                // Own profile: relays silent (cold Tor start) — serve the notes from
                // the local IPFS chain before admitting defeat.
                if (await renderOwnNotesFromChain(pubkey, StateModule)) return;
                userPostsContainer.innerHTML = `
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>No posts found or connection timeout</p>
                        <p style="font-size: 12px; margin-top: 10px;">This user may not have any recent posts on these relays</p>
                    </div>
                `;
            }
        }, TIMEOUTS.POST_LOAD);

        if (!StateModule.pool) {
            throw new Error('Relay pool not initialized');
        }

        // Get user's write relays (outbox) - where they publish their posts
        const outboxRelays = await RelaysModule.getOutboxRelays(pubkey);
        console.log(`Fetching posts from ${pubkey.slice(0, 8)}'s outbox relays:`, outboxRelays);

        const sub = StateModule.pool.subscribeMany(outboxRelays, [
            {
                kinds: [1, 6], // Text notes and reposts
                authors: [pubkey],
                limit: 100 // Get user's last 100 posts/reposts
            }
        ], {
            onevent(event) {
                hasReceivedPosts = true;
                clearTimeout(timeout);

                if (!processedIds.has(event.id)) {
                    rawEvents.push(event);
                    processedIds.add(event.id);

                    // If this is a kind 6 repost with only 'e' tag, collect the ID to fetch
                    if (event.kind === 6 && (!event.content || !event.content.trim().startsWith('{'))) {
                        const eTag = event.tags.find(t => t[0] === 'e');
                        if (eTag && eTag[1]) {
                            repostEventIdsToFetch.push(eTag[1]);
                        }
                    }
                }
            },
            async oneose() {
                clearTimeout(timeout);
                sub.close();

                console.log('Received', rawEvents.length, 'raw events (including reposts)');

                // Fetch original posts for reposts that only had 'e' tags
                let fetchedOriginals = {};
                if (repostEventIdsToFetch.length > 0) {
                    console.log('Fetching', repostEventIdsToFetch.length, 'original posts for e-tag reposts');
                    fetchedOriginals = await fetchOriginalPostsForReposts(StateModule, RelaysModule, repostEventIdsToFetch);
                }

                // Normalize events: extract original posts from reposts (kind 6)
                const userPosts = [];
                const seenOriginalIds = new Set();

                for (const event of rawEvents) {
                    let { post, reposter, repostId, repostTimestamp } = PostsModule.normalizeEventForDisplay(event);

                    // If normalizeEventForDisplay returned null post (e-tag only repost), use fetched original
                    if (!post && event.kind === 6) {
                        const eTag = event.tags.find(t => t[0] === 'e');
                        if (eTag && eTag[1] && fetchedOriginals[eTag[1]]) {
                            post = fetchedOriginals[eTag[1]];
                            reposter = event.pubkey;
                            repostId = event.id;
                            repostTimestamp = event.created_at;
                        }
                    }

                    if (!post) continue; // Skip if we still couldn't get the original post

                    // De-duplicate by original post ID
                    if (seenOriginalIds.has(post.id)) continue;
                    seenOriginalIds.add(post.id);

                    // Store repost context on the post for rendering
                    if (reposter) {
                        post._repostContext = { reposter, repostId, repostTimestamp };
                        post._sortTimestamp = repostTimestamp;
                    } else {
                        post._sortTimestamp = post.created_at;
                    }

                    userPosts.push(post);
                    // ALSO add to global event cache so repost/reply can find it
                    StateModule.eventCache[post.id] = post;
                }

                // Sort by sort timestamp (repost time or original post time)
                userPosts.sort((a, b) => (b._sortTimestamp || b.created_at) - (a._sortTimestamp || a.created_at));

                if (userPosts.length === 0) {
                    // Own profile: relays had nothing — the local IPFS chain is the
                    // authoritative copy of the user's own notes.
                    if (await renderOwnNotesFromChain(pubkey, StateModule)) return;
                    userPostsContainer.innerHTML = `
                        <div style="text-align: center; color: #666; padding: 40px;">
                            <p>No posts found</p>
                            <p style="font-size: 12px; margin-top: 10px;">This user hasn't posted recently or posts aren't available on these relays</p>
                        </div>
                    `;
                } else {
                    // Fetch profiles for final render
                    const allAuthors = [...new Set(userPosts.map(post => post.pubkey))];
                    await PostsModule.fetchProfiles(allAuthors);

                    // Store posts in cache for pagination
                    cachedProfilePosts = userPosts;
                    displayedProfilePostCount = 0;
                    // A full off-Tor EOSE is the truth and may lower the stat; Tor answers only raise it.
                    setNotesCount(pubkey, userPosts.length, { authoritative: localStorage.getItem('nosdag:posture') !== 'tor' });

                    // Now fetch Monero addresses ONCE and render first page
                    await renderUserPosts(userPosts.slice(0, PROFILE_POSTS_PER_PAGE), true, pubkey); // true = fetch Monero addresses
                }
            }
        });

    } catch (error) {
        console.error('Error fetching user posts:', error);
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (userPostsContainer) {
            userPostsContainer.innerHTML = `
                <div style="text-align: center; color: #666; padding: 40px;">
                    <p>Error loading posts</p>
                    <p style="font-size: 12px; margin-top: 10px;">${UtilsModule.escapeHtml(error.message)}</p>
                </div>
            `;
        }
    }
}

// Fetch original posts for reposts that only have 'e' tags
async function fetchOriginalPostsForReposts(StateModule, RelaysModule, eventIds) {
    if (!eventIds.length) return {};

    const results = {};

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log('Timeout fetching original posts for reposts, got', Object.keys(results).length, 'of', eventIds.length);
            resolve(results);
        }, TIMEOUTS.REPOST_FETCH);

        const sub = StateModule.pool.subscribeMany(RelaysModule.getActiveRelays(), [
            { ids: eventIds }
        ], {
            onevent(event) {
                results[event.id] = event;
            },
            oneose() {
                clearTimeout(timeout);
                sub.close();
                console.log('Fetched', Object.keys(results).length, 'original posts for e-tag reposts');
                resolve(results);
            }
        });
    });
}

async function renderUserPosts(posts, fetchMoneroAddresses = false, pubkey = null) {
    const userPostsContainer = document.getElementById('userPostsContainer');
    if (!userPostsContainer || !posts.length) return;

    try {
        // Import Posts module to use proper rendering
        const PostsModule = await import('../posts.js');
        const StateModule = await import('../state.js');

        // Add all posts to global event cache so interaction buttons work
        posts.forEach(post => {
            StateModule.eventCache[post.id] = post;
        });

        // Fetch profiles for posts, any parent posts they might reference, AND reposters
        const allAuthors = posts.map(post => post.pubkey);
        const reposterPubkeys = posts.filter(p => p._repostContext).map(p => p._repostContext.reposter);
        const allPubkeys = [...new Set([...allAuthors, ...reposterPubkeys])];
        await PostsModule.fetchProfiles(allPubkeys);

        // Fetch Monero addresses for all post authors (only once, after all posts loaded)
        if (fetchMoneroAddresses && window.getUserMoneroAddress) {
            await Promise.all(
                allAuthors.map(async (pubkey) => {
                    try {
                        const moneroAddr = await window.getUserMoneroAddress(pubkey);
                        if (StateModule.profileCache[pubkey]) {
                            StateModule.profileCache[pubkey].monero_address = moneroAddr || null;
                        }
                    } catch (error) {
                        console.warn('Error fetching Monero address for profile post author:', error);
                    }
                })
            );
        }

        // Fetch parent posts, disclosed tips, and engagement counts
        const [parentPostsMap, disclosedTipsData, engagementData] = await Promise.all([
            PostsModule.fetchParentPosts(posts, PostsModule.getParentPostRelays()),
            PostsModule.fetchDisclosedTips(posts),
            PostsModule.fetchEngagementCounts(posts.map(p => p.id))
        ]);

        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await PostsModule.fetchProfiles([...new Set(parentAuthors)]);
        }

        // Cache disclosed tips data for later access
        Object.assign(PostsModule.disclosedTipsCache, disclosedTipsData);

        // Render each post with engagement data, parent context, disclosed tips, AND repost context
        const renderedPosts = await Promise.all(posts.map(async post => {
            try {
                return await PostsModule.renderSinglePost(post, 'feed', engagementData, parentPostsMap, post._repostContext || null);
            } catch (error) {
                console.error('Error rendering profile post:', error);
                return POST_RENDER_ERROR_HTML;
            }
        }));

        // Update displayed count
        displayedProfilePostCount += posts.length;

        // Check if there are more posts to load
        const remainingCount = cachedProfilePosts.length - displayedProfilePostCount;

        userPostsContainer.innerHTML = renderedPosts.join('') + renderLoadMoreButton(remainingCount);

        // Process any embedded notes after rendering
        try {
            const Utils = await import('../utils.js');
            await Utils.processEmbeddedNotes('userPostsContainer');
        } catch (error) {
            console.error('Error processing embedded notes in profile posts:', error);
        }

        // Add trust badges to all posts
        // Profile posts are all from the same author, so use async mode for reliable badge display
        try {
            const TrustBadges = await import('../trust-badges.js');
            // Find all username elements in profile posts and add badges with async fetching
            const usernameElements = userPostsContainer.querySelectorAll('.username[data-pubkey]');
            for (const usernameEl of usernameElements) {
                const pubkey = usernameEl.getAttribute('data-pubkey');
                if (pubkey && !usernameEl.querySelector('.trust-badge')) {
                    await TrustBadges.addTrustBadgeToElement(usernameEl, pubkey, true);
                }
            }
        } catch (error) {
            console.error('Error adding trust badges to profile posts:', error);
        }

        // Process paywalled notes (check unlock status, show locked/unlocked UI)
        try {
            await PaywallUI.processPaywalledNotes(userPostsContainer);
        } catch (error) {
            console.error('Error processing paywalled notes in profile:', error);
        }

    } catch (error) {
        console.error('Error rendering user posts:', error);
        const Utils = await import('../utils.js');
        userPostsContainer.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <p>Error rendering posts</p>
                <p style="font-size: 12px; margin-top: 10px;">${Utils.escapeHtml(error.message)}</p>
            </div>
        `;
    }
}

// Load more profile posts
export async function loadMoreProfilePosts() {
    const startIndex = displayedProfilePostCount;
    const endIndex = Math.min(startIndex + PROFILE_POSTS_PER_PAGE, cachedProfilePosts.length);
    const postsToRender = cachedProfilePosts.slice(startIndex, endIndex);

    if (postsToRender.length === 0) return;

    try {
        const PostsModule = await import('../posts.js');
        const StateModule = await import('../state.js');
        const Utils = await import('../utils.js');

        // Add posts to global event cache
        postsToRender.forEach(post => {
            StateModule.eventCache[post.id] = post;
        });

        // Fetch parent posts, disclosed tips, and engagement counts
        const [parentPostsMap, disclosedTipsData, engagementData] = await Promise.all([
            PostsModule.fetchParentPosts(postsToRender, PostsModule.getParentPostRelays()),
            PostsModule.fetchDisclosedTips(postsToRender),
            PostsModule.fetchEngagementCounts(postsToRender.map(p => p.id))
        ]);

        const parentAuthors = Object.values(parentPostsMap)
            .filter(parent => parent)
            .map(parent => parent.pubkey);
        if (parentAuthors.length > 0) {
            await PostsModule.fetchProfiles([...new Set(parentAuthors)]);
        }

        // Cache disclosed tips data
        Object.assign(PostsModule.disclosedTipsCache, disclosedTipsData);

        // Render new posts with engagement data
        const renderedPosts = await Promise.all(postsToRender.map(async post => {
            try {
                return await PostsModule.renderSinglePost(post, 'feed', engagementData, parentPostsMap);
            } catch (error) {
                console.error('Error rendering profile post:', error);
                return POST_RENDER_ERROR_HTML;
            }
        }));

        // Update displayed count
        displayedProfilePostCount = endIndex;

        // Remove old Load More button
        const loadMoreContainer = document.getElementById('profileLoadMoreContainer');
        if (loadMoreContainer) {
            loadMoreContainer.remove();
        }

        // Append new posts and button to container
        const remainingCount = cachedProfilePosts.length - displayedProfilePostCount;
        const userPostsContainer = document.getElementById('userPostsContainer');
        if (userPostsContainer) {
            userPostsContainer.insertAdjacentHTML('beforeend', renderedPosts.join('') + renderLoadMoreButton(remainingCount));
        }

        // Process embedded notes
        await Utils.processEmbeddedNotes('userPostsContainer');

    } catch (error) {
        console.error('Error loading more profile posts:', error);
    }
}

export async function viewUserProfilePage(pubkey, forceFullPage = false) {
    try {
        // Username clicks open the compact right-panel profile; the panel's own
        // "View Full Profile" button passes forceFullPage — without it the button
        // would loop back into the same panel it sits in.
        if (!forceFullPage && window.RightPanel?.isVisible()) {
            console.log('Opening profile in right panel:', pubkey);
            window.RightPanel.openProfile(pubkey);
            return;
        }

        // Import required modules
        const [StateModule, Posts, Utils, Lists] = await Promise.all([
            import('../state.js'),
            import('../posts.js'),
            import('../utils.js'),
            import('../lists.js').catch(() => null)
        ]);

        // NIP-51 muted-user block: short-circuit before doing anything else.
        if (Lists?.lists?.mutePubkeys?.has(pubkey)) {
            const profilePage = document.getElementById('profilePage');
            if (profilePage) {
                document.getElementById('feed')?.style.setProperty('display', 'none');
                profilePage.style.display = 'block';
                profilePage.innerHTML = `
                    <div style="max-width: 600px; margin: 40px auto; padding: 32px 20px; text-align: center;">
                        <div style="font-size: 48px; margin-bottom: 16px;">🔇</div>
                        <div style="color: #fff; font-weight: 600; font-size: 20px; margin-bottom: 8px;">Posts are not viewable</div>
                        <div style="color: #aaa; font-size: 15px; margin-bottom: 24px;">You have muted this user.</div>
                        <button id="profilePageUnmuteBtn" style="background: linear-gradient(135deg, var(--nd-accent-hi), var(--nd-accent)); border: none; color: #fff; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 15px;">Unmute and view profile</button>
                    </div>
                `;
                const btn = profilePage.querySelector('#profilePageUnmuteBtn');
                if (btn) {
                    btn.addEventListener('click', async () => {
                        await Lists.unmuteUser(pubkey);
                        viewUserProfilePage(pubkey);
                    });
                }
            }
            StateModule.setCurrentPage('profile');
            return;
        }

        // Store current page to go back to
        previousPage = StateModule.currentPage || 'home';

        // Hide current page and clear content
        document.getElementById('feed')?.style.setProperty('display', 'none');
        document.getElementById('messagesPage')?.style.setProperty('display', 'none');
        document.getElementById('threadPage')?.style.setProperty('display', 'none');

        // Clear any thread content that might be in the feed
        const feedElement = document.getElementById('feed');
        if (feedElement) {
            feedElement.innerHTML = '';
        }

        const profilePage = document.getElementById('profilePage');
        if (!profilePage) {
            console.error('Profile page element not found');
            return;
        }

        // Show loading state
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px;">
                <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid #333; border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="text-align: center; color: #666;">Loading profile...</div>
                </div>
            </div>
        `;
        profilePage.style.display = 'block';

        // This path bypasses handleNavigation, so reset the shared scroller here too.
        document.querySelector('.app-container .main')?.scrollTo(0, 0);

        // Update current page state
        StateModule.setCurrentPage('profile');

        // Always fetch fresh profile to ensure we have latest Lightning address —
        // but keep the copy we already have: on a cold Tor start the relay fetch
        // returns nothing and the cached kind-0 is the only source of the user's
        // real name/avatar. The fresh result wins whenever it arrives.
        const previousProfile = StateModule.profileCache[pubkey] || null;
        delete StateModule.profileCache[pubkey];
        await Posts.fetchProfiles([pubkey]);
        let userProfile = StateModule.profileCache[pubkey];
        if (!userProfile && previousProfile) {
            StateModule.profileCache[pubkey] = previousProfile;
            userProfile = previousProfile;
        }

        // Next fallback: the persisted kind-0 blob (saveProfileToCache writes it on
        // every good fetch), so even a cold boot renders the real identity.
        if (!userProfile) {
            try { userProfile = JSON.parse(localStorage.getItem('profile-' + pubkey) || 'null'); } catch { userProfile = null; }
            if (userProfile) StateModule.profileCache[pubkey] = userProfile;
        }

        // Use default profile if still not found
        if (!userProfile) {
            userProfile = {
                pubkey: pubkey,
                name: 'Anonymous',
                picture: null,
                about: 'No profile information available'
            };
        }

        // Escape user-controlled profile fields to prevent XSS
        const safeName = Utils.escapeHtml(userProfile.name || 'Anonymous');
        const safeNip05 = userProfile.nip05 ? Utils.escapeHtml(userProfile.nip05) : '';
        const safeAbout = userProfile.about ? Utils.escapeHtml(userProfile.about) : '';
        // For website, validate it's a proper URL and escape for display
        let safeWebsiteHref = '';
        let safeWebsiteDisplay = '';
        if (userProfile.website) {
            const websiteUrl = userProfile.website.startsWith('http://') || userProfile.website.startsWith('https://')
                ? userProfile.website
                : 'https://' + userProfile.website;
            // Only allow http/https URLs to prevent javascript: injection
            if (websiteUrl.startsWith('http://') || websiteUrl.startsWith('https://')) {
                safeWebsiteHref = Utils.escapeHtml(websiteUrl);
                safeWebsiteDisplay = Utils.escapeHtml(userProfile.website);
            }
        }

        // Render profile page with ThumbHash progressive loading
        const profileAvatarPlaceholder = userProfile.picture ? window.ThumbHashLoader?.getPlaceholder(userProfile.picture) : null;
        profilePage.innerHTML = `
            <div style="max-width: 800px; margin: 0 auto; padding: 20px; word-wrap: break-word; overflow-wrap: break-word;">
                <div style="background: linear-gradient(135deg, color-mix(in srgb, var(--nd-accent) 10%, transparent), color-mix(in srgb, var(--nd-accent) 10%, transparent)); border: 1px solid var(--border-primary); border-radius: 16px; padding: 24px; margin-bottom: 24px;">
                    <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 16px;">
                        ${userProfile.picture ?
                            `<img src="${profileAvatarPlaceholder || userProfile.picture}" data-thumbhash-src="${userProfile.picture}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover;${profileAvatarPlaceholder ? ' filter: blur(4px); transition: filter 0.3s;' : ''}"
                                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" onload="window.ThumbHashLoader?.onImageLoad(this)">
                             <div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, var(--nd-accent-hi), var(--nd-accent)); display: none; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${safeName.charAt(0).toUpperCase()}</div>` :
                            `<div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, var(--nd-accent-hi), var(--nd-accent)); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 24px;">${safeName.charAt(0).toUpperCase()}</div>`
                        }
                        <div style="flex: 1; min-width: 0; word-wrap: break-word; overflow-wrap: break-word;">
                            <h1 class="profile-name" data-pubkey="${pubkey}" style="color: var(--text-primary); font-size: 24px; margin: 0 0 8px 0; word-wrap: break-word;">${safeName}</h1>
                            <p style="margin: 0 0 8px 0; color: var(--text-muted); font-family: monospace; font-size: 14px; word-break: break-all;">${pubkey.substring(0, 8)}...${pubkey.substring(56)}</p>
                            ${safeNip05 ? `<div style="color: #10B981; font-size: 14px; margin-bottom: 8px; word-wrap: break-word;">✅ ${safeNip05}</div>` : ''}
                            ${safeAbout ? `<div style="color: var(--text-secondary); font-size: 14px; line-height: 1.4; margin-bottom: 8px; word-wrap: break-word;">${safeAbout}</div>` : ''}
                            ${safeWebsiteHref ? `<div style="margin-bottom: 8px; word-wrap: break-word;"><a href="${safeWebsiteHref}" target="_blank" rel="noopener noreferrer" style="color: var(--nd-accent); text-decoration: none; font-size: 14px; word-break: break-all;">🔗 ${safeWebsiteDisplay}</a></div>` : ''}
                            <div id="uiProfileMoneroAddress" style="margin-bottom: 8px;"></div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 16px; margin-bottom: 16px;">
                        <div id="followingCount_${pubkey}" onclick="showFollowingList('${pubkey}')" style="cursor: pointer; text-align: center; color: var(--text-primary); padding: 8px; background: var(--card-bg); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Following</div>
                        </div>
                        <div id="followersCount_${pubkey}" onclick="showFollowersList('${pubkey}')" style="cursor: pointer; text-align: center; color: var(--text-primary); padding: 8px; background: var(--card-bg); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Followers</div>
                        </div>
                        <div id="notesCount_${pubkey}" style="text-align: center; color: var(--text-primary); padding: 8px; background: var(--card-bg); border-radius: 8px; min-width: 80px;">
                            <div style="font-size: 18px; font-weight: bold;">-</div>
                            <div style="font-size: 12px; opacity: 0.8;">Notes</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                        <button onclick="goBackFromProfile()" style="background: color-mix(in srgb, var(--nd-accent) 20%, transparent); border: 1px solid var(--nd-accent); border-radius: 8px; color: var(--nd-accent); padding: 8px 16px; cursor: pointer; font-size: 14px;">← Back</button>
                        ${pubkey === StateModule.publicKey
                            ? `<button onclick="showEditProfileModal()" style="background: linear-gradient(135deg, var(--nd-accent-hi), var(--nd-accent)); border: none; border-radius: 8px; color: #fff; padding: 8px 16px; cursor: pointer; font-size: 14px; font-weight: bold;">✏️ Edit Profile</button>`
                            : `<button id="followBtn_${pubkey}" onclick="toggleFollow('${pubkey}')" style="background: rgba(255, 255, 255, 0.06); border: none; border-radius: 8px; color: #9aa4b4; padding: 8px 16px; cursor: pointer; font-size: 14px; font-weight: bold;">Following...</button>`}
                        <button onclick="copyUserNpub('${pubkey}')" style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px; color: #9aa4b4; padding: 8px 16px; cursor: pointer; font-size: 14px;">📋 Copy npub</button>
                    </div>
                </div>
                <div class="profile-tabs" style="border-top: 1px solid var(--border-color); margin-top: 16px; display: flex; gap: 0;">
                    <button class="profile-tab active" data-profile-tab="notes" data-profile-pubkey="${pubkey}" style="flex: 1; padding: 10px 16px; background: none; border: none; border-bottom: 2px solid var(--accent-color, #f60); color: var(--text-primary); font-size: 14px; cursor: pointer;">Notes</button>
                    <button class="profile-tab" data-profile-tab="articles" data-profile-pubkey="${pubkey}" style="flex: 1; padding: 10px 16px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-secondary, #888); font-size: 14px; cursor: pointer;">Articles</button>
                    <button class="profile-tab" data-profile-tab="highlights" data-profile-pubkey="${pubkey}" style="flex: 1; padding: 10px 16px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-secondary, #888); font-size: 14px; cursor: pointer;">Highlights</button>
                </div>
                <div id="userPostsContainer" style="word-break: break-word; overflow-wrap: break-word; max-width: 100%;">
                    <div style="text-align: center; color: #666; padding: 40px;">
                        <p>Loading user posts...</p>
                    </div>
                </div>
                <div id="userArticlesContainer" style="display: none; word-break: break-word; overflow-wrap: break-word; max-width: 100%;"></div>
                <div id="userHighlightsContainer" style="display: none; word-break: break-word; overflow-wrap: break-word; max-width: 100%;"></div>
            </div>
        `;

        wireProfilePageTabs(pubkey);

        // Update follow button state
        await updateFollowButton(pubkey);

        // Load follow counts
        seedOwnNotesCount(pubkey);
        await loadFollowCounts(pubkey);

        // Load and display Monero address for this user
        await loadAndDisplayMoneroAddress(pubkey, userProfile);

        // Add trust badge to profile (function has built-in retry logic)
        try {
            const TrustBadges = await import('../trust-badges.js');
            // Use setTimeout to ensure DOM is fully painted before first attempt
            setTimeout(async () => {
                try {
                    await TrustBadges.addProfileTrustBadge(pubkey);
                } catch (err) {
                    console.error('[Profile] Failed to add trust badge:', err);
                }
            }, 50);
        } catch (error) {
            console.error('Error importing trust badge module:', error);
        }

        // Fetch and display user's posts
        await fetchUserPosts(pubkey);

    } catch (error) {
        console.error('Error viewing user profile:', error);
    }
}

// Load and display Monero address for a user profile
async function loadAndDisplayMoneroAddress(pubkey, userProfile) {
    const addressContainer = document.getElementById('uiProfileMoneroAddress');
    if (!addressContainer) return;

    // Show loading state
    addressContainer.innerHTML = `
        <div style="color: #666; font-size: 12px;">
            <span style="margin-right: 6px;">💰</span>Loading XMR address...
        </div>
    `;

    try {
        // Use the getUserMoneroAddress function that works for any user
        let moneroAddress = null;
        if (window.getUserMoneroAddress) {
            moneroAddress = await window.getUserMoneroAddress(pubkey);
        }

        if (moneroAddress && moneroAddress.trim()) {
            // Display the Monero address with tip + copy buttons
            const shortAddress = `${moneroAddress.substring(0, 8)}...${moneroAddress.substring(moneroAddress.length - 8)}`;
            // Escape for use in onclick attribute to prevent injection
            const safeMoneroAddress = moneroAddress.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const isOwnProfile = pubkey === window.NostrState?.publicKey;
            addressContainer.innerHTML = `
                <div style="background: color-mix(in srgb, var(--nd-accent) 10%, transparent); border: 1px solid var(--nd-accent); border-radius: 8px; padding: 12px; margin-top: 8px;">
                    <div style="color: var(--nd-accent); font-size: 12px; font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                        <span><span style="margin-right: 6px;">💰</span>MONERO ADDRESS</span>
                        <span style="display: flex; gap: 6px;">
                            ${isOwnProfile ? '' : `<button id="uiProfileTipBtn"
                                    style="background: var(--nd-accent); border: 1px solid var(--nd-accent); color: var(--nd-on-accent); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: bold;">
                                Tip
                            </button>`}
                            <button onclick="navigator.clipboard.writeText('${safeMoneroAddress}'); window.NostrUtils.showNotification('Monero address copied!', 'success')"
                                    style="background: none; border: 1px solid var(--nd-accent); color: var(--nd-accent); padding: 2px 6px; border-radius: 4px; cursor: pointer; font-size: 10px;">
                                Copy
                            </button>
                        </span>
                    </div>
                    <div style="color: var(--text-primary); font-family: monospace; font-size: 14px; word-break: break-all; line-height: 1.4;">
                        ${shortAddress}
                    </div>
                </div>
            `;
            // Direct user tip: same zap flow as a note, with no note reference.
            addressContainer.querySelector('#uiProfileTipBtn')?.addEventListener('click', () => {
                if (!window.NostrState?.publicKey) {
                    window.NostrUtils?.showNotification?.('Log in to send a tip', 'error');
                    return;
                }
                window.openZapModal?.('', userProfile?.name || userProfile?.display_name || 'this user', moneroAddress, 'choose', null, pubkey);
            });
        } else {
            // Clear the loading message if no address found
            addressContainer.innerHTML = '';
        }

    } catch (error) {
        console.error('Error loading Monero address for profile:', error);
        addressContainer.innerHTML = '';
    }
}


// ==================== FOLLOW FUNCTIONALITY ====================

// Update follow button appearance
async function updateFollowButton(pubkey) {
    const button = document.getElementById(`followBtn_${pubkey}`);
    if (!button) return;

    // Import State module to check global following list
    const StateModule = await import('../state.js');

    // Check if user is following this pubkey (use global state, not local variable)
    // StateModule.followingUsers might be a Set or Array, handle both
    const currentFollowing = StateModule.followingUsers || [];
    const isFollowing = currentFollowing instanceof Set
        ? currentFollowing.has(pubkey)
        : Array.isArray(currentFollowing)
            ? currentFollowing.includes(pubkey)
            : false;

    if (isFollowing) {
        button.textContent = '✓ Following';
        button.style.background = 'color-mix(in srgb, var(--nd-accent) 14%, transparent)';
        button.style.border = '1px solid color-mix(in srgb, var(--nd-accent) 45%, transparent)';
        button.style.color = 'var(--nd-accent)';
    } else {
        button.textContent = '+ Follow';
        button.style.background = 'linear-gradient(135deg, var(--nd-accent-hi), var(--nd-accent))';
        button.style.border = 'none';
        button.style.color = '#fff';
    }
}

// Toggle follow status
export async function toggleFollow(pubkey) {
    try {
        // Import required modules
        const [StateModule, RelaysModule] = await Promise.all([
            import('../state.js'),
            import('../relays.js')
        ]);

        if (!StateModule.publicKey || !StateModule.hasPrivateKey()) {
            showWarningToast('Please log in to follow users', 'Login Required');
            return;
        }

        // CRITICAL: Block follow actions during sync to prevent catastrophic data loss
        if (!StateModule.contactListFullySynced) {
            const progress = StateModule.contactListSyncProgress || { loaded: 0, total: 0 };
            const message = progress.total > 0
                ? `⏳ Still syncing your follows (${progress.loaded}/${progress.total} relays)...\n\nPlease wait a moment to prevent data loss.`
                : `⏳ Still syncing your follows...\n\nPlease wait a moment to prevent data loss.`;

            console.warn('🔒 Follow action blocked - contact list sync not complete');
            alert(message);
            return;
        }

        // Use the GLOBAL state, not local followingList
        const currentFollowing = new Set(StateModule.followingUsers || []);
        const isCurrentlyFollowing = currentFollowing.has(pubkey);

        // You can't follow yourself. (Still allow un-following, so anyone who self-followed before
        // this guard existed can clean it off their own list.)
        if (pubkey === StateModule.publicKey && !isCurrentlyFollowing) {
            showWarningToast("You can't follow yourself", 'Not allowed');
            return;
        }

        // Update following set
        if (isCurrentlyFollowing) {
            currentFollowing.delete(pubkey);
        } else {
            currentFollowing.add(pubkey);
        }

        // Update global state immediately
        StateModule.setFollowingUsers(currentFollowing);

        // Update local tracking variable
        followingList = new Set(currentFollowing);

        // Save to localStorage with timestamp
        localStorage.setItem('following-list', JSON.stringify([...currentFollowing]));
        localStorage.setItem('following-list-timestamp', Date.now().toString());

        // Update button immediately
        await updateFollowButton(pubkey);

        // Create contact list event (kind 3) with COMPLETE list
        const tags = [...currentFollowing].map(pk => ['p', pk]);

        const event = {
            kind: 3,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: ''
        };

        // Sign and publish event
        const writeRelays = RelaysModule.getWriteRelays();
        const Utils = await import('../utils.js');
        const signedEvent = await Utils.signEvent(event);
        await StateModule.pool.publish(writeRelays, signedEvent);

        // Keep the local contact-list cache current so counts and the Following feed
        // survive a cold start without relays (the same cache login reads first).
        try {
            const FeedCache = await import('../feed-cache.js');
            await FeedCache.saveCachedFollows(StateModule.publicKey, signedEvent);
        } catch { /* cache unavailable */ }

        const action = isCurrentlyFollowing ? 'unfollowed' : 'followed';
        const actionTitle = isCurrentlyFollowing ? 'Unfollowed' : 'Followed';

        // Show toast notification
        showSuccessToast(`User ${action}!`, actionTitle);

        // If unfollowing, immediately remove their posts from the Following feed
        if (isCurrentlyFollowing) {
            purgeUnfollowedUserPosts(pubkey);
        }

        // Altruistic pinning (§5.1): auto-host a new follow (opt-out), unhost on unfollow.
        import('../nosdag/altruistic-pin.js').then(m => m.onFollowChange(pubkey, !isCurrentlyFollowing)).catch(() => {});

        // Note: We don't reload the feed when following - their posts will appear
        // in the Following feed naturally when user next loads it. This prevents
        // unwanted feed switching (e.g., from Suggested Follows to Following).

    } catch (error) {
        console.error('Error toggling follow:', error);
        showErrorToast('Failed to update follow status', 'Follow Error');
    }
}

// ==================== FOLLOW COUNTS & LISTS FUNCTIONALITY ====================

// Load and display follower/following counts for a profile
// Own-profile fallback: when relays return nothing (cold Tor start — onion-only reads,
// and the onion set may not hold the data), the user's own notes are all in the local
// IPFS chain. Serve them from the node through the normal render pipeline. Returns true
// when it rendered something.
async function renderOwnNotesFromChain(pubkey, StateModule) {
    if (pubkey !== StateModule.publicKey) return false;
    try {
        const [{ getLocalHead }, DagRead, RelaysModule] = await Promise.all([
            import('../nosdag/dag-publish.js'),
            import('../nosdag/dag-read.js'),
            import('../relays.js')
        ]);
        const head = getLocalHead(pubkey);
        const chainNotes = head ? await DagRead.walkNotes(head, { limit: 100, author: pubkey }) : [];

        // Timeline-archive notes (pre-Nosdag imports) live under the archive manifest, not
        // the chain — merge them in, minus anything the author later deleted (best-effort
        // kind-5 check; silent relays skip the filter for this render).
        let archiveNotes = [];
        try {
            const relays = RelaysModule.getUserDataRelays();
            const arc = await DagRead.readAuthorArchive(pubkey, { pool: StateModule.pool, relays });
            if (arc.notes.length) {
                const deleted = await DagRead.fetchDeletedIds(pubkey, arc.notes.map(n => n.id), StateModule.pool, relays);
                archiveNotes = arc.notes.filter(n => !deleted.has(n.id));
            }
        } catch (e) {
            console.warn('[nosdag] archive read failed:', e?.message || e);
        }

        const byId = new Map();
        for (const n of [...chainNotes, ...archiveNotes]) if (n?.id && !byId.has(n.id)) byId.set(n.id, n);
        const notes = [...byId.values()].sort((a, b) => b.created_at - a.created_at);
        if (!notes.length) return false;
        for (const n of notes) {
            n._sortTimestamp = n.created_at;
            StateModule.eventCache[n.id] = n;
        }
        cachedProfilePosts = notes;
        displayedProfilePostCount = 0;
        setNotesCount(pubkey, notes.length);
        await renderUserPosts(notes.slice(0, PROFILE_POSTS_PER_PAGE), true, pubkey);
        console.log(`[nosdag] own profile notes served from the local node (${chainNotes.length} chain + ${archiveNotes.length} archive)`);
        return true;
    } catch (e) {
        console.warn('[nosdag] own-notes local fallback failed:', e?.message || e);
        return false;
    }
}

// Followers/notes are relay-derived estimates: over Tor each query catches a different
// partial subset of answers inside the timeout window, so raw results fluctuate wildly
// between clicks. Ratchet per session: partial answers only move a stat UP; only an
// authoritative read (full EOSE off-Tor) may lower it.
const statRatchet = new Map(); // pubkey -> { followers, notes }

// The Notes stat: instant local seed for the own profile (chain note count), refined
// to the loaded-list length once a fetch or fallback actually renders notes.
function setNotesCount(pubkey, n, { authoritative = false } = {}) {
    if (!Number.isFinite(n) || n < 0) return;
    const r = statRatchet.get(pubkey) || {};
    if (!authoritative && n < (r.notes || 0)) return; // partial answer never lowers the shown floor
    r.notes = n;
    statRatchet.set(pubkey, r);
    const el = document.getElementById(`notesCount_${pubkey}`);
    if (el) el.querySelector('div:first-child').textContent = n;
}

async function seedOwnNotesCount(pubkey) {
    try {
        const StateModule = await import('../state.js');
        if (pubkey !== StateModule.publicKey) return;
        const { getPostCount } = await import('../nosdag/dag-publish.js');
        let n = getPostCount(pubkey) || 0;
        // Archive notes never overlap the chain (the import skips prev-tagged notes), so
        // the instant floor is the sum; manifest.count is free — no envelope fetches.
        try {
            const arcCid = localStorage.getItem('nosdag:archive:' + pubkey);
            if (arcCid && window.nosdag?.archive?.get) {
                const man = await window.nosdag.archive.get({ cid: arcCid });
                if (man && !man.error && man.count) n += man.count;
            }
        } catch { /* stat stays chain-only */ }
        if (n) setNotesCount(pubkey, n);
    } catch { /* stat stays '-' until the fetch lands */ }
}

async function loadFollowCounts(pubkey) {
    try {
        // Load following count (users this profile follows)
        const followingCount = await getFollowingCount(pubkey);
        const followingElement = document.getElementById(`followingCount_${pubkey}`);
        if (followingElement) {
            followingElement.querySelector('div:first-child').textContent = followingCount;
        }

        // Load followers count (users who follow this profile)
        const followersCount = await getFollowersCount(pubkey);
        const followersElement = document.getElementById(`followersCount_${pubkey}`);
        if (followersElement) {
            followersElement.querySelector('div:first-child').textContent = followersCount;
        }
    } catch (error) {
        console.error('Error loading follow counts:', error);
    }
}

// Get count of users this profile follows
async function getFollowingCount(pubkey) {
    try {
        const StateModule = await import('../state.js');
        const RelaysModule = await import('../relays.js');

        // Own profile: seed from the durable contact-list cache FIRST (IndexedDB —
        // stable across the posture-switch window where State.followingUsers is
        // briefly cleared), then from live state. A cold Tor start then shows the
        // real number instantly and relay results only refine it.
        let seed = 0;
        let seedTs = 0;
        if (pubkey === StateModule.publicKey) {
            try {
                const FeedCache = await import('../feed-cache.js');
                const cached = await FeedCache.getCachedFollows(pubkey);
                seed = cached?.follows?.length || 0;
                seedTs = cached?.kind3_created_at || 0;
            } catch { /* cache unavailable */ }
            if (!seed) seed = StateModule.followingUsers?.size || 0;
        }

        if (!StateModule.pool) return seed;

        const readRelays = RelaysModule.getUserDataRelays();
        const isTor = localStorage.getItem('nosdag:posture') === 'tor';

        return new Promise((resolve) => {
            let count = seed;
            // limit:1 applies PER RELAY — several kind-3s arrive and the newest must
            // win, AND a relay copy must be newer than the cached kind-3 to count at
            // all: onion relays often hold an old contact list, and "newest among the
            // stale" was overriding the good cached number.
            let bestTs = seedTs;
            const timeout = setTimeout(() => {
                resolve(count);
            }, isTor ? 12000 : TIMEOUTS.FOLLOW_COUNT); // onion circuits are slow, not empty — give them a chance

            const sub = StateModule.pool.subscribeMany(readRelays, [
                { kinds: [3], authors: [pubkey], limit: 1 }
            ], {
                onevent(event) {
                    try {
                        if (event.created_at <= bestTs) return;
                        bestTs = event.created_at;
                        // Count 'p' tags (users being followed); an empty list never
                        // downgrades a non-zero seed (junk guard).
                        const n = event.tags.filter(tag => tag[0] === 'p' && tag[1]).length;
                        if (n > 0 || !seed) count = n;
                    } catch (error) {
                        console.error('Error parsing following list:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    resolve(count);
                }
            });
        });
    } catch (error) {
        console.error('Error getting following count:', error);
        return 0;
    }
}

// Get count of users who follow this profile
async function getFollowersCount(pubkey) {
    try {
        const StateModule = await import('../state.js');
        const RelaysModule = await import('../relays.js');

        // Own profile: seed from the last known-good snapshot (written below on every
        // successful live read; the follower-baseline snapshot is the backup source) so
        // a cold Tor start shows the last real number instead of 0.
        let seed = 0;
        const snapKey = 'nosdag:followers:' + pubkey;
        if (pubkey === StateModule.publicKey) {
            try { seed = JSON.parse(localStorage.getItem(snapKey) || 'null')?.count || 0; } catch { /* corrupt */ }
            if (!seed) {
                try {
                    const FB = await import('../follower-baseline.js');
                    seed = FB.getLocalFollowerCount() ?? 0;
                } catch { /* baseline unavailable */ }
            }
        }

        if (!StateModule.pool) return seed;

        // Use aggregating relays for comprehensive follower discovery — except in Tor
        // posture, where the hardcoded clearnet aggregators can't resolve; use the
        // onion read set so the query is at least possible.
        let socialGraphRelays = RelaysModule.SOCIAL_GRAPH_RELAYS;
        try {
            const OR = await import('../nosdag/onion-relays.js');
            socialGraphRelays = OR.readOverride?.() || socialGraphRelays;
        } catch { /* module optional */ }
        const isTor = localStorage.getItem('nosdag:posture') === 'tor';

        return new Promise((resolve) => {
            const followers = new Set();
            const settle = (authoritative) => {
                const r = statRatchet.get(pubkey) || {};
                let n;
                if (authoritative && !isTor && followers.size > 0) {
                    // Full clearnet EOSE across the aggregators: the truth, may go down.
                    n = followers.size;
                } else {
                    // Timeout or Tor: a partial view — never below the seed or what this
                    // session already showed.
                    n = Math.max(followers.size, seed, r.followers || 0);
                }
                r.followers = n;
                statRatchet.set(pubkey, r);
                // A real result leaves a snapshot behind for the next silent start.
                if (n > 0 && pubkey === StateModule.publicKey) {
                    try { localStorage.setItem(snapKey, JSON.stringify({ count: n, cached_at: Date.now() })); } catch { /* full */ }
                }
                resolve(n);
            };
            const timeout = setTimeout(() => settle(false), isTor ? 12000 : TIMEOUTS.FOLLOW_COUNT);

            const sub = StateModule.pool.subscribeMany(socialGraphRelays, [
                { kinds: [3], '#p': [pubkey], limit: 200 }
            ], {
                onevent(event) {
                    try {
                        // Check if this contact list contains our pubkey
                        const hasFollow = event.tags.some(tag => tag[0] === 'p' && tag[1] === pubkey);
                        if (hasFollow) {
                            followers.add(event.pubkey);
                        }
                    } catch (error) {
                        console.error('Error parsing follower event:', error);
                    }
                },
                oneose() {
                    clearTimeout(timeout);
                    sub.close();
                    settle(true);
                }
            });
        });
    } catch (error) {
        console.error('Error getting followers count:', error);
        return 0;
    }
}

// Copy user's npub to clipboard
export async function copyUserNpub(pubkey) {
    try {
        // Import NostrTools to encode the npub
        if (!window.NostrTools || !window.NostrTools.nip19) {
            throw new Error('NostrTools not available');
        }

        const npub = window.NostrTools.nip19.npubEncode(pubkey);

        await navigator.clipboard.writeText(npub);

        // Show notification if available
        try {
            const Utils = await import('../utils.js');
            Utils.showNotification('npub copied to clipboard!', 'success');
        } catch (error) {
            // Fallback notification
            alert('npub copied to clipboard!');
        }

    } catch (error) {
        console.error('Error copying npub:', error);

        // Fallback: copy the hex pubkey if npub encoding fails
        try {
            await navigator.clipboard.writeText(pubkey);
            try {
                const Utils = await import('../utils.js');
                Utils.showNotification('Pubkey copied to clipboard!', 'success');
            } catch {
                alert('Pubkey copied to clipboard!');
            }
        } catch (clipboardError) {
            console.error('Error copying to clipboard:', clipboardError);
            alert('Failed to copy to clipboard');
        }
    }
}

// ==================== CONTACT LIST SYNC STATUS INDICATOR ====================

// Show the sync status banner with optional progress
export function showContactSyncStatus(loaded = 0, total = 0) {
    const banner = document.getElementById('contactSyncStatus');
    const text = document.getElementById('contactSyncText');

    if (!banner || !text) return;

    if (total > 0) {
        text.textContent = `Syncing your follows: ${loaded}/${total} relays`;
    } else {
        text.textContent = 'Syncing your follows...';
    }

    banner.style.display = 'flex';
}

// Hide the sync status banner
export function hideContactSyncStatus() {
    const banner = document.getElementById('contactSyncStatus');
    if (banner) {
        banner.style.display = 'none';
    }
}

// Update sync progress (can be called during sync)
export function updateContactSyncProgress(loaded, total) {
    const text = document.getElementById('contactSyncText');
    if (text) {
        text.textContent = `Syncing your follows: ${loaded}/${total} relays`;
    }
}

export async function goBackFromProfile() {
    // Import State module
    const StateModule = await import('../state.js');

    // Hide profile page
    const profilePage = document.getElementById('profilePage');
    if (profilePage) {
        profilePage.style.display = 'none';
    }

    // Show the previous page
    if (previousPage === 'messages') {
        const messagesPage = document.getElementById('messagesPage');
        if (messagesPage) {
            messagesPage.style.display = 'block';
        }
    } else if (previousPage === 'thread') {
        const threadPage = document.getElementById('threadPage');
        if (threadPage) {
            threadPage.style.display = 'block';
        }
    } else {
        // Default back to feed
        const feed = document.getElementById('feed');
        if (feed) {
            feed.style.display = 'block';
        }
    }

    // Update current page state
    StateModule.setCurrentPage(previousPage);
}

// Export previousPage for thread module
export function setPreviousPage(page) {
    previousPage = page;
}

export function getPreviousPage() {
    return previousPage;
}

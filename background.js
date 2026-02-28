// ============================================================
// background.js — Service Worker (Orchestrator)
// Coordinates search, scraping, scoring, and AI analysis.
// ============================================================

console.log('[BG] Optimizer v1.0.1 started');

// Import scoring and AI modules
importScripts('scoring.js', 'ai.js');

// ─── State ─────────────────────────────────────────────────

let lastResults = null; // Cache last results for popup

// ─── Message Handler ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'optimize') {
        handleOptimize(msg.product, sender.tab?.id)
            .then(results => {
                lastResults = results;
                sendResponse({ success: true });
            })
            .catch(err => {
                console.error('[BG] Optimize failed:', err);
                sendResponse({ error: err.message });
            });
        return true; // Keep channel open for async
    }

    if (msg.action === 'getResults') {
        sendResponse({ results: lastResults });
        return false;
    }

    if (msg.action === 'clearResults') {
        lastResults = null;
        sendResponse({ success: true });
        return false;
    }
});

// ─── Main Optimization Flow ────────────────────────────────

async function handleOptimize(product, tabId) {
    if (!product || !product.title) {
        throw new Error('No product data provided');
    }

    // Notify content script: loading
    if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: 'optimizeStatus', status: 'loading' });
    }

    try {
        // Step 1: Build search query (AI or fallback)
        const aiAvailable = await AIEngine.isAIAvailable();
        let searchQuery;

        console.log('[BG] AI Available:', aiAvailable);

        if (aiAvailable) {
            console.log('[BG] Generating AI search query for:', product.title);
            searchQuery = await AIEngine.buildSearchQuery(product.title);
            await new Promise(r => setTimeout(r, 500)); // Rate limit safety
        }

        if (!searchQuery) {
            console.log('[BG] Using fallback search query');
            searchQuery = ScoringEngine.buildSearchQueryFallback(product.title);
        }

        console.log('[BG] Final search query:', searchQuery);

        // Step 2: Search Amazon for similar products
        console.log('[BG] Searching Amazon...');
        const searchResults = await searchAmazon(searchQuery, product.asin);
        console.log('[BG] Found', searchResults.length, 'potential candidates');

        if (searchResults.length === 0) {
            console.warn('[BG] No similar products found on Amazon search.');
            return buildResults(product, [], {}, {}, '', aiAvailable);
        }

        // Step 3: Fetch detail pages for top results (parallel)
        console.log('[BG] Fetching details for top', Math.min(8, searchResults.length), 'products...');
        const detailedProducts = await fetchProductDetails(searchResults.slice(0, 8));
        console.log('[BG] Successfully fetched', detailedProducts.length, 'detailed products');

        // Step 4: Include the original product
        const allProducts = [
            { ...product, isOriginal: true, quantity: ScoringEngine.extractQuantity(product.title) },
            ...detailedProducts,
        ];

        // Step 5: AI review analysis (if available)
        let reviewAnalyses = {};
        if (aiAvailable) {
            try {
                console.log('[BG] Starting batch AI review analysis...');
                // Batch all reviews into ONE AI call (saves quota/prevents 429)
                reviewAnalyses = await AIEngine.analyzeReviewsBatch(allProducts);
                console.log('[BG] Review analysis complete for', Object.keys(reviewAnalyses).length, 'products');
                await new Promise(r => setTimeout(r, 500)); // Rate limit safety
            } catch (err) {
                console.warn('[BG] Batch review analysis failed:', err);
            }
        }

        // Step 6: Deterministic scoring
        console.log('[BG] Scoring products...');
        const aiSentiments = {};
        Object.entries(reviewAnalyses).forEach(([asin, analysis]) => {
            aiSentiments[asin] = analysis.sentimentScore || 50;
        });

        const ranked = ScoringEngine.scoreProducts(allProducts,
            Object.keys(aiSentiments).length > 0 ? aiSentiments : null
        );
        console.log('[BG] Scoring complete. Top product score:', ranked[0]?.score);

        // Step 7: AI decision review
        let decisionReview = '';
        if (aiAvailable) {
            console.log('[BG] Generating AI decision summary...');
            decisionReview = await AIEngine.writeDecisionReview(ranked, reviewAnalyses);
        }
        if (!decisionReview) {
            decisionReview = ScoringEngine.generateFallbackSummary(ranked);
        }

        return buildResults(product, ranked, reviewAnalyses, aiSentiments, decisionReview, aiAvailable);

    } finally {
        // Notify content script: done
        if (tabId) {
            chrome.tabs.sendMessage(tabId, { action: 'optimizeStatus', status: 'done' });
        }
    }
}

// ─── Build Results Object ──────────────────────────────────

function buildResults(originalProduct, ranked, reviewAnalyses, aiSentiments, decisionReview, aiUsed) {
    return {
        originalProduct,
        products: ranked.map(p => ({
            title: p.title,
            price: p.price,
            unitPrice: p.unitPrice,
            quantity: p.quantity,
            rating: p.rating,
            reviewCount: p.reviewCount,
            shipping: p.shipping,
            imageUrl: p.imageUrl,
            url: p.url,
            asin: p.asin,
            score: p.score,
            breakdown: p.breakdown,
            isBestValue: p.isBestValue || false,
            isOriginal: p.isOriginal || false,
            reviewAnalysis: reviewAnalyses[p.asin] || null,
        })),
        decisionReview,
        aiUsed,
        timestamp: Date.now(),
    };
}

// ─── Amazon Search ─────────────────────────────────────────

async function searchAmazon(query, excludeAsin) {
    const encoded = encodeURIComponent(query);
    const url = `https://www.amazon.com/s?k=${encoded}`;

    try {
        const response = await fetch(url, {
            headers: {
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (!response.ok) {
            console.warn('[BG] Search request failed:', response.status);
            return [];
        }

        const html = await response.text();
        return parseSearchResults(html, excludeAsin);
    } catch (err) {
        console.error('[BG] Search error:', err);
        return [];
    }
}

/**
 * Parse search results from Amazon HTML.
 */
function parseSearchResults(html, excludeAsin) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const results = [];

    const cards = doc.querySelectorAll('[data-component-type="s-search-result"]');

    cards.forEach(card => {
        const asin = card.getAttribute('data-asin');
        if (!asin || asin === excludeAsin) return;

        // Title
        const titleEl = card.querySelector('h2 span, .a-text-normal, h2 a span');
        const title = titleEl ? titleEl.textContent.trim() : '';
        if (!title) return;

        // URL
        const linkEl = card.querySelector('h2 a, a.a-link-normal[href*="/dp/"]');
        const href = linkEl ? linkEl.getAttribute('href') : '';
        const url = href ? (href.startsWith('http') ? href : `https://www.amazon.com${href}`) : '';

        // Price
        let price = null;
        const priceEl = card.querySelector('.a-price .a-offscreen');
        if (priceEl) {
            const match = priceEl.textContent.match(/[\d,]+\.?\d*/);
            if (match) price = parseFloat(match[0].replace(/,/g, ''));
        }

        // Rating
        let rating = null;
        const ratingEl = card.querySelector('.a-icon-star-small .a-icon-alt, .a-icon-star .a-icon-alt');
        if (ratingEl) {
            const match = ratingEl.textContent.match(/([\d.]+)/);
            if (match) rating = parseFloat(match[1]);
        }

        // Review count
        let reviewCount = 0;
        const reviewEl = card.querySelector('.a-size-base.s-underline-text, [aria-label*="stars"] + span');
        if (reviewEl) {
            const match = reviewEl.textContent.match(/([\d,]+)/);
            if (match) reviewCount = parseInt(match[1].replace(/,/g, ''), 10);
        }

        // Image
        const imgEl = card.querySelector('.s-image');
        const imageUrl = imgEl ? imgEl.getAttribute('src') : '';

        // Prime badge
        const isPrime = !!card.querySelector('.a-icon-prime, .s-prime');

        results.push({
            asin,
            title,
            price,
            rating,
            reviewCount,
            shipping: { isPrime, isFree: isPrime, cost: null },
            imageUrl,
            url,
        });
    });

    return results.filter(r => r.price !== null).slice(0, 12);
}

// ─── Fetch Product Details ─────────────────────────────────

async function fetchProductDetails(products) {
    const detailed = await Promise.allSettled(
        products.map(p => fetchSingleProduct(p))
    );

    return detailed
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
}

async function fetchSingleProduct(product) {
    try {
        const url = product.url || `https://www.amazon.com/dp/${product.asin}`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (!response.ok) return product;

        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Extract more detailed info
        const enriched = { ...product };

        // Better price from detail page
        if (!enriched.price) {
            const priceEl = doc.querySelector('.a-price .a-offscreen, #priceblock_ourprice');
            if (priceEl) {
                const match = priceEl.textContent.match(/[\d,]+\.?\d*/);
                if (match) enriched.price = parseFloat(match[0].replace(/,/g, ''));
            }
        }

        // Reviews text for AI analysis
        enriched.reviewTexts = [];
        const reviewEls = doc.querySelectorAll('[data-hook="review-body"] span, #cm-cr-dp-review-list .review-text-content span');
        reviewEls.forEach((el, i) => {
            if (i < 8) {
                const text = el.textContent.trim();
                if (text.length > 20) enriched.reviewTexts.push(text);
            }
        });

        return enriched;
    } catch (err) {
        console.warn('[BG] Failed to fetch details for', product.asin, err);
        return product;
    }
}

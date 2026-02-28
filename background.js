// ============================================================
// background.js — Service Worker (Orchestrator)
// Coordinates search, scraping, scoring, and AI analysis.
// ============================================================

console.log('[BG] Optimizer v1.0.1 started');

// Import scoring and AI modules
importScripts('scoring.js', 'ai.js');

// ─── State ─────────────────────────────────────────────────

let lastResults = null;    // Cache last results for popup
let isOptimizing = false;  // Track active optimization

// ─── Message Handler ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'optimize') {
        isOptimizing = true;
        handleOptimize(msg.product, sender.tab?.id)
            .then(results => {
                lastResults = results;
                isOptimizing = false;
                sendResponse({ success: true });
            })
            .catch(err => {
                isOptimizing = false;
                console.error('[BG] Optimize failed:', err);
                sendResponse({ error: err.message });
            });
        return true; // Keep channel open for async
    }

    if (msg.action === 'getResults') {
        sendResponse({ results: lastResults, isOptimizing: isOptimizing });
        return false;
    }

    if (msg.action === 'clearResults') {
        lastResults = null;
        isOptimizing = false;
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
    if (tabId && typeof tabId === 'number') {
        try {
            chrome.tabs.sendMessage(tabId, { action: 'optimizeStatus', status: 'loading' });
        } catch (e) {
            console.warn('[BG] Failed to send loading status:', e.message);
        }
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
        const searchResults = await searchAmazon(searchQuery, product.asin, tabId);
        console.log('[BG] Found', searchResults.length, 'potential candidates');

        if (searchResults.length === 0) {
            console.warn('[BG] No similar products found on Amazon search.');
            return buildResults(product, [], {}, {}, '', aiAvailable);
        }

        // Step 3: Fetch detail pages for top results (parallel)
        console.log('[BG] Fetching details for top', Math.min(8, searchResults.length), 'products...');
        const detailedProducts = await fetchProductDetails(searchResults.slice(0, 8), tabId);
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
        if (tabId && typeof tabId === 'number') {
            try {
                chrome.tabs.sendMessage(tabId, { action: 'optimizeStatus', status: 'done' });
            } catch (e) {
                console.warn('[BG] Failed to send done status:', e.message);
            }
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

async function searchAmazon(query, excludeAsin, tabId) {
    if (!tabId || typeof tabId !== 'number') {
        console.warn('[BG] Invalid or missing tabId, cannot perform Amazon search');
        return [];
    }

    return new Promise(resolve => {
        try {
            chrome.tabs.sendMessage(tabId, { action: 'performSearch', query, excludeAsin }, (res) => {
                if (chrome.runtime.lastError) {
                    console.warn('[BG] Content script performSearch failed:', chrome.runtime.lastError.message);
                    resolve([]);
                } else {
                    resolve(res?.results || []);
                }
            });
        } catch (err) {
            console.warn('[BG] tabs.sendMessage sync error during search:', err.message);
            resolve([]);
        }
    });
}

// ─── Fetch Product Details ─────────────────────────────────

async function fetchProductDetails(products, tabId) {
    if (!tabId || typeof tabId !== 'number') {
        console.warn(`[BG] Invalid tabId, cannot fetch details for ${products.length} products`);
        return products;
    }

    return new Promise(resolve => {
        try {
            chrome.tabs.sendMessage(tabId, { action: 'fetchProductDetails', products }, (res) => {
                if (chrome.runtime.lastError) {
                    console.warn(`[BG] Content script fetchProductDetails failed:`, chrome.runtime.lastError.message);
                    resolve(products);
                } else {
                    resolve(res?.products || products);
                }
            });
        } catch (err) {
            console.warn(`[BG] tabs.sendMessage sync error during detail fetch:`, err.message);
            resolve(products);
        }
    });
}

// ============================================================
// scoring.js — Deterministic Scoring Engine
// Pure utility module, no AI dependencies.
// ============================================================

/**
 * Weights for the composite score (0-100).
 * When AI is available, Review Sentiment gets 15%.
 * When AI is unavailable, its weight is redistributed.
 */
const WEIGHTS_WITH_AI = {
    unitPrice: 0.30,
    rating: 0.20,
    reviewSentiment: 0.15,
    reviewCount: 0.10,
    shipping: 0.15,
    price: 0.10,
};

const WEIGHTS_WITHOUT_AI = {
    unitPrice: 0.35,
    rating: 0.25,
    reviewSentiment: 0,
    reviewCount: 0.15,
    shipping: 0.15,
    price: 0.10,
};

// ─── Quantity Extraction ─────────────────────────────────────

const QUANTITY_PATTERNS = [
    /(\d+)\s*[-–]?\s*(count|ct|pack|pk|pcs|pieces|units|ea|each|capsules|tablets|pods|sheets|rolls|bags|bars|cans|bottles)/i,
    /pack\s*of\s*(\d+)/i,
    /(\d+)\s*per\s*(box|case|pack|bag)/i,
    /set\s*of\s*(\d+)/i,
    /(\d+)\s*x\s*\d/i,  // e.g., "24 x 500ml"
];

/**
 * Extract quantity from product title.
 * @param {string} title
 * @returns {number} quantity (defaults to 1 if not found)
 */
function extractQuantity(title) {
    if (!title) return 1;
    for (const pattern of QUANTITY_PATTERNS) {
        const match = title.match(pattern);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > 0 && num < 10000) return num;
        }
    }
    return 1;
}

// ─── Unit Price ──────────────────────────────────────────────

/**
 * Calculate price per unit.
 * @param {number} price
 * @param {number} quantity
 * @returns {number}
 */
function calculateUnitPrice(price, quantity) {
    if (!price || price <= 0) return Infinity;
    return price / Math.max(quantity, 1);
}

// ─── Fallback Search Query Builder ───────────────────────────

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
    'new', 'latest', 'best', 'top', 'premium', 'ultra', 'super', 'mega',
    'max', 'plus', 'pro', 'advanced', 'original', 'classic', 'edition',
]);

const UNIT_WORDS = new Set([
    'count', 'ct', 'pack', 'pk', 'pcs', 'pieces', 'units', 'ea', 'each',
    'oz', 'fl', 'ml', 'liter', 'litre', 'gallon', 'gal', 'lb', 'lbs',
    'kg', 'gram', 'grams', 'mg', 'inch', 'inches', 'ft', 'feet', 'cm', 'mm',
]);

/**
 * Build search query by extracting meaningful keywords from a product title.
 * Used as fallback when AI is unavailable.
 * @param {string} title
 * @returns {string}
 */
function buildSearchQueryFallback(title) {
    if (!title) return '';

    const words = title
        .replace(/[,\-–—|()[\]{}]/g, ' ')
        .split(/\s+/)
        .map(w => w.toLowerCase().trim())
        .filter(w => w.length > 1);

    const keywords = words.filter(w => {
        if (STOP_WORDS.has(w)) return false;
        if (UNIT_WORDS.has(w)) return false;
        if (/^\d+$/.test(w)) return false;           // pure numbers
        if (/^\d+[x×]\d*$/.test(w)) return false;    // dimensions like 4x
        return true;
    });

    // Take first 5 meaningful keywords to keep query focused
    return keywords.slice(0, 5).join(' ');
}

// ─── Shipping Score ──────────────────────────────────────────

/**
 * Get shipping score (0-100).
 * @param {object} shipping - { isPrime, isFree, cost }
 * @returns {number}
 */
function getShippingScore(shipping) {
    if (!shipping) return 25;
    if (shipping.isPrime || shipping.isFree) return 100;
    if (shipping.cost === 0) return 100;
    if (shipping.cost && shipping.cost > 0) return 50;
    return 25;
}

// ─── Main Scoring Function ───────────────────────────────────

/**
 * Get the appropriate weights based on AI availability.
 * @param {boolean} hasAI
 * @returns {object}
 */
function getWeights(hasAI) {
    return hasAI ? { ...WEIGHTS_WITH_AI } : { ...WEIGHTS_WITHOUT_AI };
}

/**
 * Score and rank an array of products.
 *
 * @param {Array} products - Array of product objects with:
 *   { title, price, rating, reviewCount, shipping, imageUrl, url, asin }
 * @param {Object|null} aiSentiments - Map of ASIN → sentimentScore (0-100), or null
 * @returns {Array} products sorted by score descending, each with .score and .breakdown
 */
function scoreProducts(products, aiSentiments = null) {
    if (!products || products.length === 0) return [];

    const hasAI = aiSentiments && Object.keys(aiSentiments).length > 0;
    const weights = getWeights(hasAI);

    // Pre-calculate derived values
    const enriched = products.map(p => ({
        ...p,
        quantity: extractQuantity(p.title),
        unitPrice: 0,
    }));

    enriched.forEach(p => {
        p.unitPrice = calculateUnitPrice(p.price, p.quantity);
    });

    // Find max values for normalization (only from finite values)
    const finitePrices = enriched.filter(p => isFinite(p.price) && p.price > 0);
    const finiteUnitPrices = enriched.filter(p => isFinite(p.unitPrice));

    const maxPrice = Math.max(...finitePrices.map(p => p.price), 1);
    const maxUnitPrice = Math.max(...finiteUnitPrices.map(p => p.unitPrice), 1);
    const maxReviews = Math.max(...enriched.map(p => p.reviewCount || 0), 1);

    // Score each product
    enriched.forEach(p => {
        const breakdown = {};

        // Unit Price score (lower is better)
        breakdown.unitPrice = isFinite(p.unitPrice)
            ? (1 - p.unitPrice / maxUnitPrice) * 100
            : 0;

        // Rating score
        breakdown.rating = ((p.rating || 0) / 5) * 100;

        // Review Count score (log scale)
        breakdown.reviewCount = maxReviews > 1
            ? (Math.log(Math.max(p.reviewCount || 1, 1)) / Math.log(maxReviews)) * 100
            : 50;

        // Shipping score
        breakdown.shipping = getShippingScore(p.shipping);

        // Price score (lower is better)
        breakdown.price = isFinite(p.price) && p.price > 0
            ? (1 - p.price / maxPrice) * 100
            : 0;

        // AI Review Sentiment score
        breakdown.reviewSentiment = hasAI && aiSentiments[p.asin]
            ? aiSentiments[p.asin]
            : 0;

        // Weighted composite
        p.score = Object.keys(weights).reduce((sum, key) => {
            return sum + (breakdown[key] || 0) * weights[key];
        }, 0);

        // Clamp to 0-100
        p.score = Math.round(Math.max(0, Math.min(100, p.score)));
        p.breakdown = breakdown;
    });

    // Sort by score descending
    enriched.sort((a, b) => b.score - a.score);

    // Tag the winner
    if (enriched.length > 0) {
        enriched[0].isBestValue = true;
    }

    return enriched;
}

// ─── Template Summary (Fallback when AI unavailable) ─────────

/**
 * Generate a simple template-based summary.
 * @param {Array} rankedProducts
 * @returns {string}
 */
function generateFallbackSummary(rankedProducts) {
    if (!rankedProducts || rankedProducts.length === 0) return '';

    const best = rankedProducts[0];
    const parts = [];

    parts.push(`**${best.title}** is the top pick with a score of ${best.score}/100.`);

    if (best.quantity > 1) {
        parts.push(`At $${best.unitPrice.toFixed(2)} per unit (${best.quantity}-pack), it offers strong value.`);
    }

    if (best.breakdown.shipping === 100) {
        parts.push('Ships free with Prime.');
    }

    if (best.rating >= 4.5) {
        parts.push(`Rated ${best.rating}/5 stars with ${(best.reviewCount || 0).toLocaleString()} reviews.`);
    }

    if (rankedProducts.length > 1) {
        const runner = rankedProducts[1];
        parts.push(`Runner-up: ${runner.title} (${runner.score}/100).`);
    }

    return parts.join(' ');
}

// Export for use in background.js
if (typeof globalThis !== 'undefined') {
    globalThis.ScoringEngine = {
        extractQuantity,
        calculateUnitPrice,
        buildSearchQueryFallback,
        getShippingScore,
        scoreProducts,
        generateFallbackSummary,
        getWeights,
        WEIGHTS_WITH_AI,
        WEIGHTS_WITHOUT_AI,
    };
}

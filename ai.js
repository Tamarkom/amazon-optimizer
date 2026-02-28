// ============================================================
// ai.js — AI Layer (Google Gemini 2.0 Flash)
// Handles smart search queries, review analysis, decision review.
// Supports dev mode (direct API) and production mode (backend proxy).
// ============================================================

// Use v1 (Stable) endpoint for maximum compatibility
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent';

// ─── Configuration ───────────────────────────────────────────

/**
 * Get AI configuration from storage.
 * @returns {Promise<{mode: string, apiKey: string, backendUrl: string, authToken: string, model: string, endpoint: string}>}
 */
async function getAIConfig() {
    return new Promise(resolve => {
        chrome.storage.local.get(
            ['aiMode', 'geminiApiKey', 'backendUrl', 'authToken', 'detectedModel', 'detectedEndpoint'],
            (result) => {
                const apiKey = result.geminiApiKey || '';
                const isPlaceholder = apiKey.startsWith('AIzaSy') && apiKey.length < 30;

                resolve({
                    mode: result.aiMode || 'dev',
                    apiKey: isPlaceholder ? '' : apiKey,
                    backendUrl: result.backendUrl || '',
                    authToken: result.authToken || '',
                    model: result.detectedModel || 'gemini-1.5-flash',
                    endpoint: result.detectedEndpoint || 'v1'
                });
            }
        );
    });
}

/**
 * Check if AI features are available.
 * @returns {Promise<boolean>}
 */
async function isAIAvailable() {
    const config = await getAIConfig();
    if (config.mode === 'dev') return !!config.apiKey;
    if (config.mode === 'production') return !!config.authToken;
    return false;
}

// ─── Gemini API Call with Retry Logic ────────────────────────

/**
 * Call the Gemini API with automatic retries for 429 errors.
 */
async function callAI(prompt, options = {}, retries = 3, delay = 2000) {
    const config = await getAIConfig();
    const { temperature = 0.3, maxTokens = 1024 } = options;

    try {
        if (config.mode === 'dev') {
            if (!config.apiKey) {
                throw new Error('MISSING_API_KEY');
            }

            const url = `https://generativelanguage.googleapis.com/${config.endpoint}/models/${config.model}:generateContent?key=${config.apiKey}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature,
                        maxOutputTokens: maxTokens,
                        responseMimeType: 'application/json',
                    },
                }),
            });

            if (response.status === 429 || response.status === 503) {
                if (retries > 0) {
                    console.warn(`[AI] Rate limited (${response.status}). Retrying in ${delay / 1000}s... (${retries} left)`);
                    await new Promise(r => setTimeout(r, delay));
                    return callAI(prompt, options, retries - 1, delay * 1.5);
                }
                throw new Error('QUOTA_EXCEEDED');
            }

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Gemini API error: ${response.status}`);
            }

            const data = await response.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        } else if (config.mode === 'production') {
            // Production logic (backend proxy)
            const response = await fetch(`${config.backendUrl}/api/ai`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.authToken}`,
                },
                body: JSON.stringify({ prompt, temperature, maxTokens }),
            });

            if (response.status === 429) {
                if (retries > 0) {
                    await new Promise(r => setTimeout(r, delay));
                    return callAI(prompt, options, retries - 1, delay * 1.5);
                }
                throw new Error('QUOTA_EXCEEDED');
            }

            if (!response.ok) throw new Error(`Backend error: ${response.status}`);

            const data = await response.json();
            return data.text || '';
        }
    } catch (err) {
        if (err.message === 'MISSING_API_KEY') {
            throw new Error('Please enter a valid Gemini API key in Settings.');
        }
        if (err.message === 'QUOTA_EXCEEDED') {
            throw new Error('Rate limit exceeded. Please wait a moment and try again.');
        }
        throw err;
    }

    throw new Error('Unknown AI mode');
}

// ─── Smart Search Query Building ─────────────────────────────

/**
 * Use AI to build an optimized search query from a product title.
 * @param {string} title - The full Amazon product title
 * @returns {Promise<string>} search query
 */
async function buildSearchQuery(title) {
    const prompt = `You are a product search expert. Given this Amazon product title, extract the CORE product type and key attributes for finding equivalent/similar products. 

RULES:
- Remove the brand name
- Remove marketing terms (Max, Ultra, Premium, etc.)
- Remove quantity/count info
- Keep the product category and essential specs
- Return a short, focused search query (3-6 words)
- Return ONLY a JSON object: {"query": "your search terms here"}

Product title: "${title}"`;

    try {
        const response = await callAI(prompt, { temperature: 0.1, maxTokens: 100 });
        const parsed = JSON.parse(response);
        return parsed.query || '';
    } catch (err) {
        console.warn('[AI] Search query generation failed, using fallback:', err.message);
        return '';
    }
}

// ─── Review Analysis ─────────────────────────────────────────

/**
 * Analyze product reviews using AI.
 * @param {string} productTitle
 * @param {Array<string>} reviews - Array of review text strings
 * @returns {Promise<{sentimentScore: number, pros: string[], cons: string[], qualityFlag: string, summary: string}>}
 */
async function analyzeReviews(productTitle, reviews) {
    if (!reviews || reviews.length === 0) {
        return {
            sentimentScore: 50,
            pros: [],
            cons: [],
            qualityFlag: 'unknown',
            summary: 'No reviews available for analysis.',
        };
    }

    const reviewsText = reviews
        .slice(0, 8)
        .map((r, i) => `Review ${i + 1}: ${r}`)
        .join('\n\n');

    const prompt = `Analyze these Amazon product reviews and return a structured assessment.

Product: "${productTitle}"

${reviewsText}

Return ONLY a JSON object with this exact structure:
{
  "sentimentScore": <number 0-100, where 100 is overwhelmingly positive>,
  "pros": [<top 3 positive themes, as short strings>],
  "cons": [<top 3 negative themes, as short strings>],
  "qualityFlag": <one of: "excellent", "reliable", "mixed", "concerning", "poor">,
  "summary": <1-2 sentence summary of overall review sentiment>
}`;

    try {
        const response = await callAI(prompt, { temperature: 0.2, maxTokens: 500 });
        const parsed = JSON.parse(response);
        return {
            sentimentScore: Math.max(0, Math.min(100, parsed.sentimentScore || 50)),
            pros: parsed.pros || [],
            cons: parsed.cons || [],
            qualityFlag: parsed.qualityFlag || 'unknown',
            summary: parsed.summary || '',
        };
    } catch (err) {
        console.warn('[AI] Review analysis failed:', err.message);
        return {
            sentimentScore: 50,
            pros: [],
            cons: [],
            qualityFlag: 'unknown',
            summary: 'Review analysis unavailable.',
        };
    }
}

/**
 * Batch analyze reviews for multiple products in one call to stay under 15 RPM.
 * @param {Array<object>} products - Array of product objects with .title, .asin, and .reviewTexts
 * @returns {Promise<object>} map of ASIN -> results
 */
async function analyzeReviewsBatch(products) {
    const validProducts = products.filter(p => p.reviewTexts && p.reviewTexts.length > 0);
    if (!validProducts.length) return {};

    const batchText = validProducts
        .map((p, i) => `PROD ${i + 1} (${p.asin}): "${p.title}"\nReviews:\n${p.reviewTexts.slice(0, 5).join('\n---\n')}`)
        .join('\n\n====================\n\n');

    const prompt = `Analyze these products' reviews and return a structured assessment for EACH product.

${batchText}

Return ONLY a JSON map with ASINs as keys:
{
  "ASIN_123": {
    "sentimentScore": <number 0-100>,
    "pros": [<top 2 positive themes>],
    "cons": [<top 1 negative theme>],
    "qualityFlag": <one of: "excellent", "reliable", "mixed", "concerning", "poor">,
    "summary": <1 sentence summary>
  },
  ...
}`;

    try {
        const response = await callAI(prompt, { temperature: 0.2, maxTokens: 1024 });
        const parsed = JSON.parse(response);

        // Clean up response objects to ensure they have the correct keys
        const results = {};
        Object.entries(parsed).forEach(([asin, data]) => {
            results[asin] = {
                sentimentScore: Math.max(0, Math.min(100, data.sentimentScore || 50)),
                pros: data.pros || [],
                cons: data.cons || [],
                qualityFlag: data.qualityFlag || 'unknown',
                summary: data.summary || '',
            };
        });
        return results;
    } catch (err) {
        console.warn('[AI] Batch review analysis failed:', err.message);
        return {};
    }
}

// ─── Decision Review ─────────────────────────────────────────

/**
 * Generate a natural-language decision review explaining the recommendation.
 * @param {Array} rankedProducts - Products sorted by score, with .score and .breakdown
 * @param {Object} reviewAnalyses - Map of ASIN → review analysis object
 * @returns {Promise<string>} decision review text
 */
async function writeDecisionReview(rankedProducts, reviewAnalyses = {}) {
    if (!rankedProducts || rankedProducts.length === 0) return '';

    const productSummaries = rankedProducts.slice(0, 5).map((p, i) => {
        const analysis = reviewAnalyses[p.asin] || {};
        return `${i + 1}. "${p.title}"
   - Price: $${p.price?.toFixed(2) || 'N/A'} | Unit price: $${p.unitPrice?.toFixed(2) || 'N/A'} (qty: ${p.quantity || 1})
   - Rating: ${p.rating || 'N/A'}/5 (${(p.reviewCount || 0).toLocaleString()} reviews)
   - Shipping: ${p.shipping?.isPrime ? 'Prime' : p.shipping?.isFree ? 'Free' : 'Standard'}
   - Score: ${p.score}/100
   - Review pros: ${(analysis.pros || []).join(', ') || 'N/A'}
   - Review cons: ${(analysis.cons || []).join(', ') || 'N/A'}`;
    }).join('\n\n');

    const prompt = `You are a shopping advisor. Based on these product comparison results, write a concise decision review (3-5 sentences) explaining your recommendation.

Products (ranked by composite score):
${productSummaries}

RULES:
- Start with the winner and WHY it wins
- Mention specific price/value numbers
- Reference what reviewers say (pros and cons)
- Briefly explain why the runner-up didn't win
- Be objective and helpful, like a trusted friend
- Do NOT use markdown formatting
- Return ONLY a JSON object: {"review": "your review text here"}`;

    try {
        const response = await callAI(prompt, { temperature: 0.4, maxTokens: 500 });
        const parsed = JSON.parse(response);
        return parsed.review || '';
    } catch (err) {
        console.warn('[AI] Decision review failed:', err.message);
        return '';
    }
}

// ─── Export ──────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
    globalThis.AIEngine = {
        isAIAvailable,
        getAIConfig,
        buildSearchQuery,
        analyzeReviews,
        analyzeReviewsBatch,
        writeDecisionReview,
    };
}

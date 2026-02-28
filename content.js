// ============================================================
// content.js — Content Script for Amazon Product Pages
// Injects the "Optimize" button and extracts product data.
// ============================================================

(function () {
    'use strict';

    // Prevent double injection
    if (document.getElementById('amz-optimizer-btn')) return;

    // ─── DOM Selectors ───────────────────────────────────────

    const SELECTORS = {
        title: '#productTitle',
        price: [
            '.a-price .a-offscreen',
            '#priceblock_ourprice',
            '#priceblock_dealprice',
            '.a-price-whole',
            '#corePrice_feature_div .a-offscreen',
            '#tp_price_block_total_price_ww .a-offscreen',
        ],
        rating: '#acrPopover span.a-icon-alt',
        reviewCount: '#acrCustomerReviewText',
        shipping: [
            '#deliveryBlockMessage',
            '#mir-layout-DELIVERY_BLOCK',
            '#delivery-message',
        ],
        primeBadge: [
            '#prime-badge',
            '.a-icon-prime',
            '#deliveryBlockMessage .a-icon-prime',
        ],
        image: '#landingImage, #imgBlkFront',
        buyBox: [
            '#addToCart_feature_div',
            '#buybox',
            '#desktop_buybox',
            '#rightCol',
        ],
        reviews: [
            '#cm-cr-dp-review-list .review-text-content span',
            '[data-hook="review-body"] span',
        ],
        asin: () => {
            // Try multiple methods to get ASIN
            const urlMatch = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/);
            if (urlMatch) return urlMatch[1];
            const el = document.querySelector('[data-asin]');
            if (el) return el.getAttribute('data-asin');
            const input = document.querySelector('input[name="ASIN"]');
            if (input) return input.value;
            return null;
        },
    };

    // ─── Data Extraction ─────────────────────────────────────

    function extractProductData() {
        // Title
        const titleEl = document.querySelector(SELECTORS.title);
        const title = titleEl ? titleEl.textContent.trim() : '';

        // Price
        let price = null;
        for (const sel of SELECTORS.price) {
            const el = document.querySelector(sel);
            if (el) {
                const text = el.textContent.trim();
                const match = text.match(/[\d,]+\.?\d*/);
                if (match) {
                    price = parseFloat(match[0].replace(/,/g, ''));
                    break;
                }
            }
        }

        // Rating
        let rating = null;
        const ratingEl = document.querySelector(SELECTORS.rating);
        if (ratingEl) {
            const match = ratingEl.textContent.match(/([\d.]+)\s*out\s*of\s*5/);
            if (match) rating = parseFloat(match[1]);
        }

        // Review count
        let reviewCount = 0;
        const reviewEl = document.querySelector(SELECTORS.reviewCount);
        if (reviewEl) {
            const match = reviewEl.textContent.match(/([\d,]+)/);
            if (match) reviewCount = parseInt(match[1].replace(/,/g, ''), 10);
        }

        // Shipping / Prime
        let shipping = { isPrime: false, isFree: false, cost: null };
        for (const sel of SELECTORS.primeBadge) {
            if (document.querySelector(sel)) {
                shipping.isPrime = true;
                shipping.isFree = true;
                break;
            }
        }
        if (!shipping.isPrime) {
            for (const sel of SELECTORS.shipping) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = el.textContent.toLowerCase();
                    if (text.includes('free')) {
                        shipping.isFree = true;
                    }
                    break;
                }
            }
        }

        // Image
        const imgEl = document.querySelector(SELECTORS.image);
        const imageUrl = imgEl ? (imgEl.getAttribute('data-old-hires') || imgEl.src) : '';

        // ASIN
        const asin = SELECTORS.asin();

        // Reviews text (for AI analysis)
        const reviewTexts = [];
        const reviewEls = document.querySelectorAll(SELECTORS.reviews.join(', '));
        reviewEls.forEach((el, i) => {
            if (i < 8) {
                const text = el.textContent.trim();
                if (text.length > 20) reviewTexts.push(text);
            }
        });

        return {
            title,
            price,
            rating,
            reviewCount,
            shipping,
            imageUrl,
            asin,
            url: window.location.href,
            reviewTexts,
        };
    }

    // ─── Inject Optimize Button ──────────────────────────────

    function injectButton() {
        let container = null;
        for (const sel of SELECTORS.buyBox) {
            container = document.querySelector(sel);
            if (container) break;
        }
        if (!container) {
            // Fallback: inject after title
            container = document.querySelector(SELECTORS.title)?.parentElement;
        }
        if (!container) return;

        const btn = document.createElement('button');
        btn.id = 'amz-optimizer-btn';
        btn.innerHTML = `
      <span class="amz-opt-icon">🔍</span>
      <span class="amz-opt-text">Optimize</span>
    `;
        btn.title = 'Find better deals for this product';

        btn.addEventListener('click', handleOptimize);

        // Insert at the top of the container
        container.insertBefore(btn, container.firstChild);
    }

    // ─── Loading State ───────────────────────────────────────

    function showLoading() {
        const btn = document.getElementById('amz-optimizer-btn');
        if (btn) {
            btn.disabled = true;
            btn.classList.add('amz-opt-loading');
            btn.querySelector('.amz-opt-text').textContent = 'Optimizing...';
        }
    }

    function hideLoading() {
        const btn = document.getElementById('amz-optimizer-btn');
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('amz-opt-loading');
            btn.querySelector('.amz-opt-text').textContent = 'Optimize';
        }
    }

    // ─── Handle Optimize Click ───────────────────────────────

    async function handleOptimize() {
        showLoading();

        try {
            const productData = extractProductData();

            if (!productData.title) {
                showNotification('Could not extract product data. Please try refreshing.', 'error');
                hideLoading();
                return;
            }

            // Send to background script for processing
            chrome.runtime.sendMessage(
                { action: 'optimize', product: productData },
                (response) => {
                    hideLoading();
                    if (response?.error) {
                        showNotification(response.error, 'error');
                    } else if (response?.success) {
                        showNotification('Optimization complete! Click the ⚡ extension icon in your toolbar to see the best deals.', 'success');
                    }
                }
            );
        } catch (err) {
            hideLoading();
            showNotification('Something went wrong. Please try again.', 'error');
            console.error('[Optimizer]', err);
        }
    }

    // ─── In-page Notification ────────────────────────────────

    function showNotification(message, type = 'info') {
        const existing = document.getElementById('amz-opt-notification');
        if (existing) existing.remove();

        const notif = document.createElement('div');
        notif.id = 'amz-opt-notification';
        notif.className = `amz-opt-notif amz-opt-notif-${type}`;
        notif.textContent = message;
        document.body.appendChild(notif);

        setTimeout(() => {
            notif.classList.add('amz-opt-notif-hide');
            setTimeout(() => notif.remove(), 300);
        }, 4000);
    }

    // ─── Listen for messages from background/popup ───────────

    // ─── Listen for messages from background/popup ───────────

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'getProductData') {
            sendResponse(extractProductData());
            return false;
        }
        if (msg.action === 'optimizeStatus') {
            if (msg.status === 'loading') showLoading();
            else hideLoading();
            return false;
        }
        if (msg.action === 'parseSearchHTML') {
            const results = parseSearchResults(msg.html, msg.excludeAsin);
            sendResponse({ results });
            return false;
        }
        if (msg.action === 'parseProductHTML') {
            const product = parseProductHTML(msg.html, msg.product);
            sendResponse({ product });
            return false;
        }
    });

    // ─── Background HTML Parsing Helpers ─────────────────────
    // Parses HTML fetched by the background script, since DOMParser
    // is not available in Manifest V3 service workers.

    function parseSearchResults(html, excludeAsin) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const results = [];
        const cards = doc.querySelectorAll('[data-component-type="s-search-result"]');

        cards.forEach(card => {
            const asin = card.getAttribute('data-asin');
            if (!asin || asin === excludeAsin) return;

            const titleEl = card.querySelector('h2 span, .a-text-normal, h2 a span');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (!title) return;

            const linkEl = card.querySelector('h2 a, a.a-link-normal[href*="/dp/"]');
            const href = linkEl ? linkEl.getAttribute('href') : '';
            const url = href ? (href.startsWith('http') ? href : `https://www.amazon.com${href}`) : '';

            let price = null;
            const priceEl = card.querySelector('.a-price .a-offscreen');
            if (priceEl) {
                const match = priceEl.textContent.match(/[\d,]+\.?\d*/);
                if (match) price = parseFloat(match[0].replace(/,/g, ''));
            }

            let rating = null;
            const ratingEl = card.querySelector('.a-icon-star-small .a-icon-alt, .a-icon-star .a-icon-alt');
            if (ratingEl) {
                const match = ratingEl.textContent.match(/([\d.]+)/);
                if (match) rating = parseFloat(match[1]);
            }

            let reviewCount = 0;
            const reviewEl = card.querySelector('.a-size-base.s-underline-text, [aria-label*="stars"] + span');
            if (reviewEl) {
                const match = reviewEl.textContent.match(/([\d,]+)/);
                if (match) reviewCount = parseInt(match[1].replace(/,/g, ''), 10);
            }

            const imgEl = card.querySelector('.s-image');
            const imageUrl = imgEl ? imgEl.getAttribute('src') : '';
            const isPrime = !!card.querySelector('.a-icon-prime, .s-prime');

            results.push({
                asin, title, price, rating, reviewCount,
                shipping: { isPrime, isFree: isPrime, cost: null },
                imageUrl, url,
            });
        });
        return results.filter(r => r.price !== null).slice(0, 12);
    }

    function parseProductHTML(html, baseProduct) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const enriched = { ...baseProduct };

        if (!enriched.price) {
            const priceEl = doc.querySelector('.a-price .a-offscreen, #priceblock_ourprice');
            if (priceEl) {
                const match = priceEl.textContent.match(/[\d,]+\.?\d*/);
                if (match) enriched.price = parseFloat(match[0].replace(/,/g, ''));
            }
        }

        enriched.reviewTexts = [];
        const reviewEls = doc.querySelectorAll('[data-hook="review-body"] span, #cm-cr-dp-review-list .review-text-content span');
        reviewEls.forEach((el, i) => {
            if (i < 8) {
                const text = el.textContent.trim();
                if (text.length > 20) enriched.reviewTexts.push(text);
            }
        });

        return enriched;
    }

    // ─── Initialize ──────────────────────────────────────────

    injectButton();
})();

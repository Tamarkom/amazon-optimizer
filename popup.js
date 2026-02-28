// ============================================================
// popup.js — Popup UI Logic
// Fetches results from background and renders the comparison.
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    const elements = {
        emptyState: document.getElementById('emptyState'),
        loadingState: document.getElementById('loadingState'),
        resultsState: document.getElementById('resultsState'),
        errorState: document.getElementById('errorState'),
        aiStatus: document.getElementById('aiStatus'),
        aiLabel: document.querySelector('.ai-label'),
        decisionReview: document.getElementById('decisionReview'),
        reviewText: document.getElementById('reviewText'),
        savingsBanner: document.getElementById('savingsBanner'),
        savingsText: document.getElementById('savingsText'),
        productList: document.getElementById('productList'),
        errorMessage: document.getElementById('errorMessage'),
        settingsBtn: document.getElementById('settingsBtn'),
        retryBtn: document.getElementById('retryBtn'),
        loadingStep: document.getElementById('loadingStep'),
    };

    // ─── Settings Button ──────────────────────────────────

    elements.settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // ─── Retry Button ─────────────────────────────────────

    elements.retryBtn?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'clearResults' });
        showState('empty');
    });

    // ─── Check AI Status ──────────────────────────────────

    try {
        const config = await new Promise(resolve => {
            chrome.storage.local.get(['aiMode', 'geminiApiKey', 'authToken'], resolve);
        });
        const aiActive = !!(config.geminiApiKey || config.authToken);
        elements.aiStatus.classList.toggle('active', aiActive);
        elements.aiLabel.textContent = aiActive ? 'AI Active (Gemini Flash)' : 'AI Inactive — Set API key in Settings';
    } catch (e) {
        // Not critical
    }

    // ─── Load Results ─────────────────────────────────────

    try {
        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'getResults' }, (res) => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                else resolve(res);
            });
        });

        if (response?.results) {
            renderResults(response.results);
        } else {
            showState('empty');
        }
    } catch (err) {
        showState('empty');
    }

    // ─── State Management ─────────────────────────────────

    function showState(state) {
        elements.emptyState.classList.toggle('hidden', state !== 'empty');
        elements.loadingState.classList.toggle('hidden', state !== 'loading');
        elements.resultsState.classList.toggle('hidden', state !== 'results');
        elements.errorState.classList.toggle('hidden', state !== 'error');
    }

    // ─── Render Results ───────────────────────────────────

    function renderResults(results) {
        showState('results');

        // AI Decision Review
        if (results.decisionReview) {
            elements.decisionReview.classList.remove('hidden');
            elements.reviewText.textContent = results.decisionReview;
        } else {
            elements.decisionReview.classList.add('hidden');
        }

        // Savings Banner
        renderSavingsBanner(results.products);

        // Product cards
        elements.productList.innerHTML = '';
        if (!results.products || results.products.length === 0) {
            elements.productList.innerHTML = `
        <div class="empty-state" style="padding: 30px;">
          <p style="color: var(--text-secondary)">No similar products found. Try a different product.</p>
        </div>
      `;
            return;
        }

        results.products.forEach((product, index) => {
            const card = createProductCard(product, index);
            elements.productList.appendChild(card);
        });
    }

    // ─── Create Product Card ──────────────────────────────

    function createProductCard(product, index) {
        const card = document.createElement('div');
        card.className = 'product-card';
        card.style.animationDelay = `${index * 0.05}s`;

        if (product.isBestValue) card.classList.add('best-value');
        if (product.isOriginal) card.classList.add('is-original');

        // Score color
        const scoreColor = product.score >= 70 ? 'var(--green)'
            : product.score >= 50 ? 'var(--yellow)'
                : 'var(--red)';

        // Badges HTML
        let badgesHtml = '';
        if (product.isBestValue) badgesHtml += '<span class="badge badge-best">🏆 Best Value</span>';
        if (product.isOriginal) badgesHtml += '<span class="badge badge-original">📍 Current</span>';

        // Review tags HTML
        let reviewTagsHtml = '';
        if (product.reviewAnalysis) {
            const { pros, cons } = product.reviewAnalysis;
            (pros || []).slice(0, 2).forEach(p => {
                reviewTagsHtml += `<span class="review-tag pro">✓ ${p}</span>`;
            });
            (cons || []).slice(0, 1).forEach(c => {
                reviewTagsHtml += `<span class="review-tag con">✗ ${c}</span>`;
            });
        }

        // Unit price text
        const unitText = product.quantity > 1
            ? `$${product.unitPrice?.toFixed(2)}/ea · ${product.quantity} units`
            : '';

        // Breakdown bar segments
        const breakdown = product.breakdown || {};
        const breakdownEntries = [
            { key: 'unitPrice', color: 'var(--accent)', val: breakdown.unitPrice || 0 },
            { key: 'rating', color: 'var(--yellow)', val: breakdown.rating || 0 },
            { key: 'reviewCount', color: 'var(--blue)', val: breakdown.reviewCount || 0 },
            { key: 'shipping', color: 'var(--green)', val: breakdown.shipping || 0 },
            { key: 'price', color: 'var(--text-muted)', val: breakdown.price || 0 },
        ];

        const breakdownBarHtml = breakdownEntries
            .map(b => `<div class="breakdown-segment" style="width:${b.val}%;background:${b.color};opacity:0.7" title="${b.key}: ${Math.round(b.val)}"></div>`)
            .join('');

        card.innerHTML = `
      ${product.imageUrl ? `<img class="card-image" src="${product.imageUrl}" alt="" loading="lazy">` : ''}
      <div class="card-content">
        ${badgesHtml ? `<div class="card-badges">${badgesHtml}</div>` : ''}
        <div class="card-title">${escapeHtml(product.title || 'Unknown Product')}</div>
        <div class="card-meta">
          ${product.price ? `<span class="meta-price">$${product.price.toFixed(2)}</span>` : ''}
          ${unitText ? `<span class="meta-unit">${unitText}</span>` : ''}
          ${product.rating ? `<span class="meta-rating">★ ${product.rating}</span>` : ''}
          ${product.reviewCount ? `<span class="meta-reviews">(${product.reviewCount.toLocaleString()})</span>` : ''}
          ${product.shipping?.isPrime ? '<span class="meta-prime">Prime</span>' : ''}
        </div>
        ${reviewTagsHtml ? `<div class="card-review-tags">${reviewTagsHtml}</div>` : ''}
        <div class="breakdown-bar">${breakdownBarHtml}</div>
      </div>
      <div class="card-score">
        <div class="score-circle" style="--score-color:${scoreColor};--score-pct:${product.score}">
          ${product.score}
        </div>
        <span class="score-label">Score</span>
      </div>
    `;

        // Click to open product page
        card.addEventListener('click', () => {
            if (product.url) {
                chrome.tabs.create({ url: product.url });
            }
        });

        return card;
    }

    // ─── Savings Banner ──────────────────────────────────

    function renderSavingsBanner(products) {
        if (!products || products.length < 2) {
            elements.savingsBanner.classList.add('hidden');
            return;
        }

        const original = products.find(p => p.isOriginal);
        const bestValue = products.find(p => p.isBestValue);

        if (!original || !bestValue) {
            elements.savingsBanner.classList.add('hidden');
            return;
        }

        // If the original IS the best value
        if (original.asin === bestValue.asin) {
            elements.savingsBanner.classList.remove('hidden');
            elements.savingsBanner.classList.add('no-savings');
            elements.savingsText.innerHTML = '✓ You already picked the best deal! No better option found.';
            return;
        }

        elements.savingsBanner.classList.remove('no-savings');

        // Compare by unit price if both have quantities
        const useUnitPrice = original.quantity > 1 || bestValue.quantity > 1;

        if (useUnitPrice && original.unitPrice && bestValue.unitPrice && isFinite(original.unitPrice) && isFinite(bestValue.unitPrice)) {
            const savedPerUnit = original.unitPrice - bestValue.unitPrice;
            if (savedPerUnit > 0) {
                const pctSaved = Math.round((savedPerUnit / original.unitPrice) * 100);
                const totalSaved = savedPerUnit * (original.quantity || 1);
                elements.savingsBanner.classList.remove('hidden');
                elements.savingsText.innerHTML = `Save <span class="savings-amount">$${savedPerUnit.toFixed(2)}/unit (${pctSaved}%)</span> by switching — that's <span class="savings-amount">$${totalSaved.toFixed(2)} saved</span> on this purchase!`;
            } else {
                // Best value is better on overall score but not cheaper per unit
                const scoreDiff = bestValue.score - original.score;
                elements.savingsBanner.classList.remove('hidden');
                elements.savingsText.innerHTML = `Better deal found — <span class="savings-amount">+${scoreDiff} points</span> higher score with better reviews and shipping.`;
            }
        } else if (original.price && bestValue.price) {
            const saved = original.price - bestValue.price;
            if (saved > 0) {
                const pctSaved = Math.round((saved / original.price) * 100);
                elements.savingsBanner.classList.remove('hidden');
                elements.savingsText.innerHTML = `Save <span class="savings-amount">$${saved.toFixed(2)} (${pctSaved}%)</span> by switching to the top-rated option!`;
            } else {
                const scoreDiff = bestValue.score - original.score;
                elements.savingsBanner.classList.remove('hidden');
                elements.savingsText.innerHTML = `Better deal found — <span class="savings-amount">+${scoreDiff} points</span> higher score with better reviews and shipping.`;
            }
        } else {
            elements.savingsBanner.classList.add('hidden');
        }
    }

    // ─── Helpers ──────────────────────────────────────────

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
});

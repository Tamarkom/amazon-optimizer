// ============================================================
// settings.js — Settings Page Logic
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    const els = {
        modeDevBtn: document.getElementById('modeDevBtn'),
        modeProdBtn: document.getElementById('modeProdBtn'),
        devSettings: document.getElementById('devSettings'),
        prodSettings: document.getElementById('prodSettings'),
        apiKey: document.getElementById('apiKey'),
        backendUrl: document.getElementById('backendUrl'),
        authToken: document.getElementById('authToken'),
        testKeyBtn: document.getElementById('testKeyBtn'),
        testResult: document.getElementById('testResult'),
        saveBtn: document.getElementById('saveBtn'),
        saveStatus: document.getElementById('saveStatus'),
    };

    let currentMode = 'dev';

    // ─── Load Saved Settings ──────────────────────────────

    chrome.storage.local.get(
        ['aiMode', 'geminiApiKey', 'backendUrl', 'authToken'],
        (data) => {
            currentMode = data.aiMode || 'dev';
            els.apiKey.value = data.geminiApiKey || '';
            els.backendUrl.value = data.backendUrl || '';
            els.authToken.value = data.authToken || '';
            setMode(currentMode);
        }
    );

    // ─── Mode Toggle ──────────────────────────────────────

    els.modeDevBtn.addEventListener('click', () => setMode('dev'));
    els.modeProdBtn.addEventListener('click', () => setMode('production'));

    function setMode(mode) {
        currentMode = mode;
        els.modeDevBtn.classList.toggle('active', mode === 'dev');
        els.modeProdBtn.classList.toggle('active', mode === 'production');
        els.devSettings.style.display = mode === 'dev' ? 'block' : 'none';
        els.prodSettings.style.display = mode === 'production' ? 'block' : 'none';
    }

    // ─── Test API Key ─────────────────────────────────────

    els.testKeyBtn.addEventListener('click', async () => {
        const key = els.apiKey.value.trim();
        if (!key) {
            showResult(els.testResult, 'Please enter an API key first.', 'err');
            return;
        }

        showResult(els.testResult, 'Detecting working model for your key...', 'neutral');

        // List of models to try (Google varies these by region/account)
        const modelsToTry = [
            'gemini-1.5-flash',
            'gemini-1.5-flash-latest',
            'gemini-2.0-flash-001',
            'gemini-pro'
        ];

        const endpoints = ['v1', 'v1beta'];
        let workingModel = null;
        let workingEndpoint = null;
        let lastError = '';

        for (const endpoint of endpoints) {
            for (const model of modelsToTry) {
                try {
                    const url = `https://generativelanguage.googleapis.com/${endpoint}/models/${model}:generateContent?key=${key}`;
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: 'a' }] }],
                            generationConfig: { maxOutputTokens: 2 },
                        }),
                    });

                    if (response.ok) {
                        workingModel = model;
                        workingEndpoint = endpoint;
                        break;
                    } else {
                        const data = await response.json().catch(() => ({}));
                        lastError = data.error?.message || `Status: ${response.status}`;
                    }
                } catch (e) {
                    lastError = e.message;
                }
            }
            if (workingModel) break;
        }

        if (workingModel) {
            // Save the detected working model and endpoint
            chrome.storage.local.set({
                detectedModel: workingModel,
                detectedEndpoint: workingEndpoint
            });
            showResult(els.testResult, `✓ Success! Found working model: ${workingModel} (${workingEndpoint})`, 'ok');
        } else {
            showResult(els.testResult, `✗ All models failed. Google's reason: ${lastError}`, 'err');
        }
    });

    // ─── Save ─────────────────────────────────────────────

    els.saveBtn.addEventListener('click', () => {
        const data = {
            aiMode: currentMode,
            geminiApiKey: els.apiKey.value.trim(),
            backendUrl: els.backendUrl.value.trim(),
            authToken: els.authToken.value.trim(),
        };

        chrome.storage.local.set(data, () => {
            showResult(els.saveStatus, '✓ Settings saved!', 'ok');
            setTimeout(() => { els.saveStatus.innerHTML = ''; }, 3000);
        });
    });

    // ─── Helpers ──────────────────────────────────────────

    function showResult(container, message, type) {
        container.innerHTML = `<div class="status ${type}">${message}</div>`;
    }
});

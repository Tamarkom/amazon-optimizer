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

        showResult(els.testResult, 'Testing...', 'neutral');

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'Say "connected" and nothing else.' }] }],
                    generationConfig: { maxOutputTokens: 10 },
                }),
            });

            if (response.ok) {
                showResult(els.testResult, '✓ Connected successfully! Gemini 2.0 Flash is ready.', 'ok');
            } else {
                const errText = await response.text();
                showResult(els.testResult, `✗ Connection failed: ${response.status}. Check your API key.`, 'err');
            }
        } catch (err) {
            showResult(els.testResult, `✗ Network error: ${err.message}`, 'err');
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

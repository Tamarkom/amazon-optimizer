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

        showResult(els.testResult, 'Fetching available models from Google...', 'neutral');

        let workingModel = null;
        let workingEndpoint = 'v1beta';
        let lastError = '';

        try {
            // Ask Google what models this specific API key is actually allowed to use
            const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
            const listRes = await fetch(listUrl);

            if (!listRes.ok) {
                const errData = await listRes.json().catch(() => ({}));
                throw new Error(errData.error?.message || `API Key rejected (Status: ${listRes.status})`);
            }

            const listData = await listRes.json();

            // Find a valid flash model that supports text generation
            const validModels = listData.models || [];
            const flashModels = validModels.filter(m =>
                m.supportedGenerationMethods?.includes('generateContent') &&
                m.name.includes('flash')
            );

            if (flashModels.length > 0) {
                // Prefer 1.5 flash, or take the first one available
                const preferred = flashModels.find(m => m.name.includes('1.5-flash')) || flashModels[0];
                // The name comes back as "models/gemini-1.5-flash", we need to strip "models/"
                workingModel = preferred.name.replace('models/', '');
            } else {
                // Fallback to pro if flash isn't available
                const proModels = validModels.filter(m =>
                    m.supportedGenerationMethods?.includes('generateContent') &&
                    m.name.includes('pro')
                );

                if (proModels.length > 0) {
                    workingModel = proModels[0].name.replace('models/', '');
                } else {
                    throw new Error('Your API key has no access to Gemini Flash or Pro models for generation.');
                }
            }

            // Test the specific model we found just to be absolutely sure
            showResult(els.testResult, `Found approved model: ${workingModel}. Testing it...`, 'neutral');

            const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${workingModel}:generateContent?key=${key}`;
            const testRes = await fetch(testUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'a' }] }],
                    generationConfig: { maxOutputTokens: 2 },
                }),
            });

            if (!testRes.ok) {
                const errData = await testRes.json().catch(() => ({}));
                throw new Error(errData.error?.message || `Test failed with status ${testRes.status}`);
            }

        } catch (e) {
            lastError = e.message;
            workingModel = null;
        }

        if (workingModel) {
            // Save the detected working model and endpoint
            chrome.storage.local.set({
                detectedModel: workingModel,
                detectedEndpoint: workingEndpoint
            });
            showResult(els.testResult, `✓ Success! Auto-configured to your approved model: ${workingModel}`, 'ok');
        } else {
            showResult(els.testResult, `✗ Error: ${lastError}`, 'err');
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

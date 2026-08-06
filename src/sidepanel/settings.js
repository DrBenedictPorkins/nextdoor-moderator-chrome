/**
 * Settings tab — ported from src/popup/popup.js. Logic is unchanged (it only ever
 * talked to browser.storage.local and the saveConfig message, never anything
 * tab-specific), just re-pointed at the sidepanel.html element ids.
 */
import browser from 'webextension-polyfill';

// Model configuration for each provider
// Model IDs are aliases (undated) so they always resolve to the latest snapshot.
export const PROVIDER_MODELS = {
  'openai': [
    { value: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol (flagship)' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (balanced)' },
    { value: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna (cost-efficient)' },
    { value: 'gpt-4o',        label: 'GPT-4o' },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini' },
    { value: 'o3',            label: 'o3' },
    { value: 'o4-mini',       label: 'o4-mini (retiring Oct 23, 2026)' },
  ],
  'anthropic': [
    { value: 'claude-opus-5',     label: 'Claude Opus 5 (flagship)' },
    { value: 'claude-sonnet-5',   label: 'Claude Sonnet 5 (balanced)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 (cost-efficient)' },
  ]
};

// Endpoint configuration for each provider
const PROVIDER_ENDPOINTS = {
  'openai': 'https://api.openai.com/v1/chat/completions',
  'anthropic': 'https://api.anthropic.com/v1/messages'
};

export const PROVIDER_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic' };

/**
 * Drops the parenthetical tier note from the dropdown label — "Claude Opus 5
 * (flagship)" is useful when choosing a model, noise once it is the active one.
 * Falls back to the raw id so an unrecognised/legacy model still shows something
 * true rather than nothing.
 */
export function getModelLabel(provider, model) {
  if (!model) return '';
  const entry = PROVIDER_MODELS[provider]?.find(m => m.value === model);
  return (entry?.label || model).replace(/\s*\(.*\)$/, '');
}

export function initSettings() {
  const apiProviderSelect = document.getElementById('sp-api-provider');
  const apiKeyInput = document.getElementById('sp-api-key');
  const modelSelect = document.getElementById('sp-model');
  const saveConfigBtn = document.getElementById('sp-save-config');
  const statusDot = document.getElementById('sp-status-dot');
  const statusText = document.getElementById('sp-status-text');
  const validationStatus = document.getElementById('sp-validation-status');

  let isConfigSaved = false;

  function populateModels(provider) {
    modelSelect.innerHTML = '';

    if (!provider || !PROVIDER_MODELS[provider]) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Select a provider first...';
      modelSelect.appendChild(option);
      modelSelect.disabled = true;
      return;
    }

    modelSelect.disabled = false;

    const models = PROVIDER_MODELS[provider];
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.value;
      option.textContent = model.label;
      modelSelect.appendChild(option);
    });
  }

  function apiKeyStorageKey(provider) {
    return `apiKey_${provider}`;
  }

  function modelStorageKey(provider) {
    return `model_${provider}`;
  }

  async function loadConfig() {
    try {
      const result = await browser.storage.local.get(null);

      let provider = result.apiProvider;
      if (!provider && result.apiEndpoint) {
        if (result.apiEndpoint.includes('openai.com')) provider = 'openai';
        else if (result.apiEndpoint.includes('anthropic.com')) provider = 'anthropic';
      }

      if (provider) {
        apiProviderSelect.value = provider;
        populateModels(provider);

        const storedKey = result[apiKeyStorageKey(provider)] || result.apiKey || '';
        apiKeyInput.value = storedKey;

        const storedModel = result[modelStorageKey(provider)] || result.model || '';
        if (storedModel) modelSelect.value = storedModel;

        if (storedKey) isConfigSaved = true;
      }

      updateButtonState();
      updateStatus();
    } catch (error) {
      console.error('Error loading config:', error);
      showValidationStatus('Error loading configuration', 'error');
    }
  }

  async function validateApiKey(endpoint, apiKey, model) {
    const isAnthropicEndpoint = endpoint.includes('anthropic.com');

    // OpenAI deprecated max_tokens for Chat Completions and rejects it outright on
    // the GPT-5 and o-series models; Anthropic still requires max_tokens. Mirrors
    // openAiMaxTokens() in background.js — the real calls already did this, only
    // this validation request was left behind.
    const requestBody = {
      model: model,
      ...(isAnthropicEndpoint ? { max_tokens: 10 } : { max_completion_tokens: 16 }),
      messages: [{ role: 'user', content: 'test' }]
    };

    const headers = {
      'Content-Type': 'application/json',
    };

    if (isAnthropicEndpoint) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorJson.error || response.statusText;
        } catch {
          errorMessage = response.statusText;
        }

        if (response.status === 401 || response.status === 403) {
          throw new Error('Invalid API key');
        } else if (response.status === 404) {
          throw new Error('Invalid API endpoint URL');
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded - but API key is valid');
        } else {
          throw new Error(`API error: ${errorMessage}`);
        }
      }

      const data = await response.json();

      if (isAnthropicEndpoint && !data.content) {
        throw new Error('Invalid API response format');
      } else if (!isAnthropicEndpoint && !data.choices) {
        throw new Error('Invalid API response format');
      }

      return { success: true };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout - check your network connection');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function showValidationStatus(message, type) {
    validationStatus.className = 'sp-validation-status show ' + type;

    if (type === 'loading') {
      validationStatus.innerHTML = `<div class="sp-spinner"></div><span>${message}</span>`;
    } else {
      validationStatus.textContent = message;
    }

    if (type !== 'loading') {
      setTimeout(() => {
        validationStatus.classList.remove('show');
      }, 5000);
    }
  }

  function updateButtonState() {
    saveConfigBtn.textContent = isConfigSaved ? 'Re-configure' : 'Save Configuration';
  }

  async function saveConfig() {
    if (isConfigSaved && saveConfigBtn.textContent === 'Re-configure') {
      isConfigSaved = false;
      updateButtonState();
      return;
    }

    try {
      const provider = apiProviderSelect.value;

      if (!provider) {
        showValidationStatus('Please select an API provider', 'error');
        return;
      }

      if (!apiKeyInput.value.trim()) {
        showValidationStatus('Please enter an API key', 'error');
        return;
      }

      if (!modelSelect.value) {
        showValidationStatus('Please select a model', 'error');
        return;
      }

      const endpoint = PROVIDER_ENDPOINTS[provider];

      const config = {
        apiProvider: provider,
        apiEndpoint: endpoint,
        [apiKeyStorageKey(provider)]: apiKeyInput.value.trim(),
        [modelStorageKey(provider)]: modelSelect.value,
        // legacy key kept for background script compatibility
        apiKey: apiKeyInput.value.trim(),
        model: modelSelect.value,
      };

      saveConfigBtn.disabled = true;
      showValidationStatus('Validating API key...', 'loading');

      try {
        await validateApiKey(config.apiEndpoint, config.apiKey, config.model);

        await browser.storage.local.set(config);

        await browser.runtime.sendMessage({
          action: 'saveConfig',
          config: config,
        });

        showValidationStatus('Configuration validated and saved successfully', 'success');
        isConfigSaved = true;
        updateButtonState();
        updateStatus();
      } catch (validationError) {
        console.error('Validation error:', validationError);
        // Nothing was written — the set() above is only reached on success. But
        // the form still shows the rejected provider/key/model, which reads as
        // "applied", so name what is actually still in effect.
        const stored = await browser.storage.local.get(['apiProvider', 'model']).catch(() => ({}));
        const inEffect = stored?.apiProvider && stored?.model
          ? `Not saved — still using ${PROVIDER_LABELS[stored.apiProvider] || stored.apiProvider} · ${getModelLabel(stored.apiProvider, stored.model)}.`
          : 'Not saved — no working configuration is set.';
        showValidationStatus(`Validation failed: ${validationError.message} ${inEffect}`, 'error');
      } finally {
        saveConfigBtn.disabled = false;
      }
    } catch (error) {
      console.error('Error saving config:', error);
      showValidationStatus('Error saving configuration', 'error');
      saveConfigBtn.disabled = false;
    }
  }

  function updateStatus() {
    const hasProvider = apiProviderSelect.value;
    const hasApiKey = apiKeyInput.value.trim().length > 0;
    const hasModel = modelSelect.value;

    if (isConfigSaved && hasProvider && hasApiKey && hasModel) {
      statusDot.classList.add('active');
      statusText.textContent = 'Configured and ready';
    } else if (hasProvider && hasApiKey && hasModel) {
      statusDot.classList.remove('active');
      statusText.textContent = 'Ready to validate';
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = 'Not configured';
    }
  }

  apiProviderSelect.addEventListener('change', async () => {
    const provider = apiProviderSelect.value;
    populateModels(provider);

    if (provider) {
      const result = await browser.storage.local.get([apiKeyStorageKey(provider), modelStorageKey(provider)]);
      apiKeyInput.value = result[apiKeyStorageKey(provider)] || '';
      const storedModel = result[modelStorageKey(provider)] || '';
      if (storedModel) modelSelect.value = storedModel;
    } else {
      apiKeyInput.value = '';
    }

    isConfigSaved = false;
    updateButtonState();
    updateStatus();
  });

  apiKeyInput.addEventListener('input', () => {
    isConfigSaved = false;
    updateButtonState();
    updateStatus();
  });

  modelSelect.addEventListener('change', () => {
    isConfigSaved = false;
    updateButtonState();
    updateStatus();
  });

  saveConfigBtn.addEventListener('click', saveConfig);

  apiKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveConfig();
    }
  });

  async function loadVersion() {
    try {
      const buildInfoUrl = browser.runtime.getURL('build-info.json');
      const response = await fetch(buildInfoUrl);
      const buildInfo = await response.json();

      const versionElement = document.querySelector('.sp-version');
      if (versionElement && buildInfo.version) {
        let versionText = `Version ${buildInfo.version}`;

        if (buildInfo.buildTime) {
          const buildDate = new Date(buildInfo.buildTime);
          const formattedDate = buildDate.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
          versionText += ` • Built: ${formattedDate}`;
        }

        versionElement.textContent = versionText;
      }
    } catch (error) {
      console.error('Error loading build info:', error);
      const manifest = browser.runtime.getManifest();
      const versionElement = document.querySelector('.sp-version');
      if (versionElement && manifest.version) {
        versionElement.textContent = `Version ${manifest.version}`;
      }
    }
  }

  loadConfig();
  loadVersion();

  document.getElementById('sp-view-guidelines')?.addEventListener('click', (e) => {
    e.preventDefault();
    browser.tabs.create({ url: browser.runtime.getURL('src/guidelines/guidelines.html') });
  });

}

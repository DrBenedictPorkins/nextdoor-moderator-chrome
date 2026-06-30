/**
 * Popup UI script for Nextdoor Moderator Extension
 */
import browser from 'webextension-polyfill';

// DOM elements
const apiProviderSelect = document.getElementById('api-provider');
const apiKeyInput = document.getElementById('api-key');
const modelSelect = document.getElementById('model');
const saveConfigBtn = document.getElementById('save-config');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const validationStatus = document.getElementById('validation-status');

// Model configuration for each provider
const PROVIDER_MODELS = {
  'openai': [
    { value: 'gpt-4o',      label: 'GPT-4o (latest)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'o3',          label: 'o3' },
    { value: 'o4-mini',     label: 'o4-mini' },
  ],
  'anthropic': [
    { value: 'claude-sonnet-4-6',           label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5',             label: 'Claude Haiku 4.5' },
  ]
};

// Endpoint configuration for each provider
const PROVIDER_ENDPOINTS = {
  'openai': 'https://api.openai.com/v1/chat/completions',
  'anthropic': 'https://api.anthropic.com/v1/messages'
};

// State management
let isConfigSaved = false;

/**
 * Populate model dropdown based on selected provider
 */
function populateModels(provider) {
  // Clear existing options
  modelSelect.innerHTML = '';

  if (!provider || !PROVIDER_MODELS[provider]) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Select a provider first...';
    modelSelect.appendChild(option);
    modelSelect.disabled = true;
    return;
  }

  // Enable model select
  modelSelect.disabled = false;

  // Add models for selected provider
  const models = PROVIDER_MODELS[provider];
  models.forEach(model => {
    const option = document.createElement('option');
    option.value = model.value;
    option.textContent = model.label;
    modelSelect.appendChild(option);
  });
}

/**
 * Return the storage key for a provider's API key
 */
function apiKeyStorageKey(provider) {
  return `apiKey_${provider}`;
}

/**
 * Return the storage key for a provider's selected model
 */
function modelStorageKey(provider) {
  return `model_${provider}`;
}

/**
 * Load configuration from storage
 */
async function loadConfig() {
  try {
    const result = await browser.storage.local.get(null);

    // Determine provider (with backwards-compat for old single-key storage)
    let provider = result.apiProvider;
    if (!provider && result.apiEndpoint) {
      if (result.apiEndpoint.includes('openai.com')) provider = 'openai';
      else if (result.apiEndpoint.includes('anthropic.com')) provider = 'anthropic';
    }

    if (provider) {
      apiProviderSelect.value = provider;
      populateModels(provider);

      // Load per-provider key; fall back to legacy apiKey for existing installs
      const storedKey = result[apiKeyStorageKey(provider)] || result.apiKey || '';
      apiKeyInput.value = storedKey;

      // Load per-provider model
      const storedModel = result[modelStorageKey(provider)] || result.model || '';
      if (storedModel) modelSelect.value = storedModel;

      if (storedKey) isConfigSaved = true;
    }

    updateButtonState();
    updateStatus();
  } catch (error) {
    console.error('Error loading config:', error);
    showMessage('Error loading configuration', 'error');
  }
}

/**
 * Validate API key by making a test request
 */
async function validateApiKey(endpoint, apiKey, model) {
  const isAnthropicEndpoint = endpoint.includes('anthropic.com');

  const requestBody = isAnthropicEndpoint
    ? {
        model: model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }]
      }
    : {
        model: model,
        max_tokens: 10,
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

/**
 * Show validation status message
 */
function showValidationStatus(message, type) {
  validationStatus.className = 'validation-status show ' + type;

  if (type === 'loading') {
    validationStatus.innerHTML = `<div class="spinner"></div><span>${message}</span>`;
  } else {
    validationStatus.textContent = message;
  }

  if (type !== 'loading') {
    setTimeout(() => {
      validationStatus.classList.remove('show');
    }, 5000);
  }
}

/**
 * Update button state based on configuration status
 */
function updateButtonState() {
  if (isConfigSaved) {
    saveConfigBtn.textContent = 'Re-configure';
  } else {
    saveConfigBtn.textContent = 'Save Configuration';
  }
}

/**
 * Save configuration to storage
 */
async function saveConfig() {
  // If button is in "Re-configure" state, switch to edit mode
  if (isConfigSaved && saveConfigBtn.textContent === 'Re-configure') {
    isConfigSaved = false;
    updateButtonState();
    return;
  }

  try {
    const provider = apiProviderSelect.value;

    if (!provider) {
      showMessage('Please select an API provider', 'error');
      return;
    }

    if (!apiKeyInput.value.trim()) {
      showMessage('Please enter an API key', 'error');
      return;
    }

    if (!modelSelect.value) {
      showMessage('Please select a model', 'error');
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
      showValidationStatus(`Validation failed: ${validationError.message}`, 'error');
    } finally {
      saveConfigBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error saving config:', error);
    showMessage('Error saving configuration', 'error');
    saveConfigBtn.disabled = false;
  }
}

/**
 * Update status indicator
 */
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

/**
 * Show message to user
 */
function showMessage(text, type = 'success') {
  let messageEl = document.querySelector('.message');

  if (!messageEl) {
    messageEl = document.createElement('div');
    messageEl.className = 'message';
    document.querySelector('.config-section').insertBefore(
      messageEl,
      document.querySelector('.config-section h2').nextSibling
    );
  }

  messageEl.textContent = text;
  messageEl.className = `message ${type} show`;

  setTimeout(() => {
    messageEl.classList.remove('show');
  }, 3000);
}

/**
 * Handle provider selection change
 */
apiProviderSelect.addEventListener('change', async () => {
  const provider = apiProviderSelect.value;
  populateModels(provider);

  // Swap in the stored key + model for the newly selected provider (or clear)
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

/**
 * Handle input changes - mark configuration as unsaved
 */
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

/**
 * Handle save button click
 */
saveConfigBtn.addEventListener('click', saveConfig);

/**
 * Handle Enter key in inputs
 */
apiKeyInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    saveConfig();
  }
});

/**
 * Load and display extension version from build-info.json
 */
async function loadVersion() {
  try {
    // Load build info from bundled JSON file
    const buildInfoUrl = browser.runtime.getURL('build-info.json');
    const response = await fetch(buildInfoUrl);
    const buildInfo = await response.json();

    const versionElement = document.querySelector('.version');
    if (versionElement && buildInfo.version) {
      let versionText = `Version ${buildInfo.version}`;

      // Add build time if available
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
    // Fallback to manifest version only
    const manifest = browser.runtime.getManifest();
    const versionElement = document.querySelector('.version');
    if (versionElement && manifest.version) {
      versionElement.textContent = `Version ${manifest.version}`;
    }
  }
}

// Load config and version on popup open
loadConfig();
loadVersion();

document.getElementById('view-guidelines')?.addEventListener('click', (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL('src/guidelines/guidelines.html') });
});

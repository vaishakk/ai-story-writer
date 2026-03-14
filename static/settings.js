const SETTINGS_KEY = "ai_story_writer_settings";
const DEFAULT_SETTINGS = {
  provider: "ollama",
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3.1",
  apiBaseUrl: "https://api.openai.com/v1",
  apiModel: "gpt-4o-mini",
  apiKey: "",
};

const els = {
  provider: document.getElementById("provider"),
  ollamaEndpoint: document.getElementById("ollamaEndpoint"),
  ollamaModel: document.getElementById("ollamaModel"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiModel: document.getElementById("apiModel"),
  apiKey: document.getElementById("apiKey"),
  ollamaFields: document.getElementById("ollamaFields"),
  apiFields: document.getElementById("apiFields"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  settingsStatus: document.getElementById("settingsStatus"),
};

function loadSettingsFromCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsToCache(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures.
  }
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Could not load settings from server.");
    }
    const serverSettings = await res.json();
    const normalized = { ...DEFAULT_SETTINGS, ...(serverSettings || {}) };
    saveSettingsToCache(normalized);
    return normalized;
  } catch {
    return loadSettingsFromCache();
  }
}

async function saveSettings(settings) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Could not save settings.");
  }
  const normalized = { ...DEFAULT_SETTINGS, ...(data.settings || settings) };
  saveSettingsToCache(normalized);
  return normalized;
}

function setStatus(text, isError = false) {
  els.settingsStatus.textContent = text;
  els.settingsStatus.style.color = isError ? "#b43f32" : "";
}

function toggleProviderSections(provider) {
  const useApi = provider === "openai_compatible";
  els.ollamaFields.classList.toggle("hidden", useApi);
  els.apiFields.classList.toggle("hidden", !useApi);
}

function hydrateFormValues(settings) {
  els.provider.value = settings.provider;
  els.ollamaEndpoint.value = settings.ollamaEndpoint;
  els.ollamaModel.value = settings.ollamaModel;
  els.apiBaseUrl.value = settings.apiBaseUrl;
  els.apiModel.value = settings.apiModel;
  els.apiKey.value = settings.apiKey;
  toggleProviderSections(settings.provider);
}

function collectForm() {
  return {
    provider: els.provider.value,
    ollamaEndpoint: els.ollamaEndpoint.value.trim(),
    ollamaModel: els.ollamaModel.value.trim(),
    apiBaseUrl: els.apiBaseUrl.value.trim(),
    apiModel: els.apiModel.value.trim(),
    apiKey: els.apiKey.value.trim(),
  };
}

els.provider.addEventListener("change", () => {
  toggleProviderSections(els.provider.value);
});

els.saveSettingsBtn.addEventListener("click", async () => {
  const settings = collectForm();
  if (settings.provider === "ollama" && (!settings.ollamaEndpoint || !settings.ollamaModel)) {
    setStatus("Ollama endpoint and model are required.", true);
    return;
  }
  if (settings.provider === "openai_compatible" && (!settings.apiBaseUrl || !settings.apiModel)) {
    setStatus("API base URL and model are required.", true);
    return;
  }

  els.saveSettingsBtn.disabled = true;
  try {
    const saved = await saveSettings(settings);
    hydrateFormValues(saved);
    setStatus("Settings saved permanently.");
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    els.saveSettingsBtn.disabled = false;
  }
});

async function init() {
  setStatus("Loading settings...");
  const settings = await loadSettings();
  hydrateFormValues(settings);
  setStatus("Ready.");
}

init();

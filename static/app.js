const STORY_FORMAT = "ai-story-v1";
const SETTINGS_KEY = "ai_story_writer_settings";
const DRAFT_KEY = "ai_story_writer_draft_v1";
const MIN_PARAGRAPHS_FOR_METADATA = 3;
const DEFAULT_SETTINGS = {
  provider: "ollama",
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3.1",
  apiBaseUrl: "https://api.openai.com/v1",
  apiModel: "gpt-4o-mini",
  apiKey: "",
};

const els = {
  title: document.getElementById("title"),
  renderTitle: document.getElementById("renderTitle"),
  storyOverview: document.getElementById("storyOverview"),
  storyArcInstruction: document.getElementById("storyArcInstruction"),
  whatHappensNext: document.getElementById("whatHappensNext"),
  paragraphLimit: document.getElementById("paragraphLimit"),
  generateTitleBtn: document.getElementById("generateTitleBtn"),
  generateArcBtn: document.getElementById("generateArcBtn"),
  generateBtn: document.getElementById("generateBtn"),
  stopBtn: document.getElementById("stopBtn"),
  regenerateBtn: document.getElementById("regenerateBtn"),
  clearNextBtn: document.getElementById("clearNextBtn"),
  saveBtn: document.getElementById("saveBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  newStoryBtn: document.getElementById("newStoryBtn"),
  loadInput: document.getElementById("loadInput"),
  clearStoryBtn: document.getElementById("clearStoryBtn"),
  storySoFar: document.getElementById("storySoFar"),
  status: document.getElementById("status"),
  settingsSummary: document.getElementById("settingsSummary"),
};

const state = {
  storyBase: "",
  generatedParts: [],
  isGenerating: false,
  activeAbortController: null,
  settings: { ...DEFAULT_SETTINGS },
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

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
}

async function refreshSettingsFromServer() {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) {
      return;
    }
    const serverSettings = await res.json();
    state.settings = { ...DEFAULT_SETTINGS, ...(serverSettings || {}) };
    saveSettingsToCache(state.settings);
    els.settingsSummary.textContent = summarizeSettings(getSettings());
  } catch {
    // Use cached settings when server retrieval fails.
  }
}

function summarizeSettings(settings) {
  if (settings.provider === "openai_compatible") {
    return `Using API mode: ${settings.apiModel} @ ${settings.apiBaseUrl}`;
  }
  return `Using local mode: ${settings.ollamaModel} @ ${settings.ollamaEndpoint}`;
}

function buildStoryText(base, parts) {
  return [String(base || "").trim(), ...parts.filter(Boolean)].filter(Boolean).join("\n\n").trim();
}

function getFullStoryText() {
  return buildStoryText(state.storyBase, state.generatedParts);
}

function splitParagraphs(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function countStoryParagraphs() {
  return splitParagraphs(getFullStoryText()).length;
}

function updateActionButtons() {
  const enoughStory = countStoryParagraphs() >= MIN_PARAGRAPHS_FOR_METADATA;
  const hasGeneratedPart = state.generatedParts.length > 0;
  const isGenerating = state.isGenerating;

  els.generateTitleBtn.disabled = isGenerating || !enoughStory;
  els.generateArcBtn.disabled = isGenerating || !enoughStory;
  els.generateBtn.disabled = isGenerating;
  els.stopBtn.disabled = !isGenerating;
  els.regenerateBtn.disabled = isGenerating || !hasGeneratedPart;
  els.clearNextBtn.disabled = isGenerating;
  els.clearStoryBtn.disabled = isGenerating;
  els.newStoryBtn.disabled = isGenerating;
  els.saveBtn.disabled = isGenerating;
  els.downloadBtn.disabled = isGenerating;
  els.storySoFar.disabled = isGenerating;
  els.whatHappensNext.disabled = isGenerating;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.style.color = isError ? "#b43f32" : "";
}

function parseParagraphLimit() {
  const parsed = Number.parseInt(els.paragraphLimit.value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 2;
  }
  return parsed;
}

function getStoryPayload() {
  return {
    format: STORY_FORMAT,
    title: els.title.value.trim(),
    storyOverview: els.storyOverview.value.trim(),
    storySoFar: getFullStoryText(),
    whatHappensNext: els.whatHappensNext.value.trim(),
    storyArcInstruction: els.storyArcInstruction.value.trim(),
    paragraphLimit: parseParagraphLimit(),
  };
}

function saveDraft() {
  try {
    const payload = getStoryPayload();
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        ...payload,
        _storyBase: state.storyBase,
        _generatedParts: state.generatedParts,
      })
    );
  } catch {
    // Ignore storage errors so writing flow is not blocked.
  }
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
    if (data && data.format && String(data.format) !== STORY_FORMAT) {
      return;
    }

    els.title.value = String(data.title || "");
    els.storyOverview.value = String(data.storyOverview || "");
    els.whatHappensNext.value = String(data.whatHappensNext || "");
    els.storyArcInstruction.value = String(data.storyArcInstruction || "");
    const limit = Number.parseInt(String(data.paragraphLimit || "2"), 10);
    els.paragraphLimit.value = Number.isInteger(limit) && limit > 0 ? String(limit) : "2";

    const restoredParts = Array.isArray(data._generatedParts)
      ? data._generatedParts.map((p) => String(p).trim()).filter(Boolean)
      : [];
    if (restoredParts.length) {
      state.storyBase = String(data._storyBase || "").trim();
      state.generatedParts = restoredParts;
      return;
    }

    state.storyBase = String(data.storySoFar || "").trim();
    state.generatedParts = [];
  } catch {
    // Ignore malformed drafts.
  }
}

function scrollStoryToEnd() {
  requestAnimationFrame(() => {
    els.storySoFar.scrollTop = els.storySoFar.scrollHeight;
  });
}

function render({ scrollToEnd = false } = {}) {
  const title = els.title.value.trim() || "Untitled Story";
  els.renderTitle.textContent = title;

  const storyText = getFullStoryText();
  if (els.storySoFar.value !== storyText) {
    els.storySoFar.value = storyText;
  }
  updateActionButtons();
  if (scrollToEnd) {
    scrollStoryToEnd();
  }
}

async function generateMetadataField(field, buttonEl) {
  const payload = getStoryPayload();
  const settings = getSettings();

  if (countStoryParagraphs() < MIN_PARAGRAPHS_FOR_METADATA) {
    setStatus(`Generate at least ${MIN_PARAGRAPHS_FOR_METADATA} story paragraphs first.`, true);
    return;
  }

  const fieldLabel = field === "title" ? "title" : "story arc";
  setStatus(`Generating ${fieldLabel}...`);
  buttonEl.disabled = true;

  try {
    const res = await fetch("/api/generate-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field,
        storyOverview: payload.storyOverview,
        storySoFar: payload.storySoFar,
        whatHappensNext: payload.whatHappensNext,
        settings,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Failed to generate ${fieldLabel}.`);
    }

    const value = String(data.value || "").trim();
    if (!value) {
      throw new Error(`Model returned an empty ${fieldLabel}.`);
    }

    if (field === "title") {
      els.title.value = value;
      render();
    } else {
      els.storyArcInstruction.value = value;
    }
    saveDraft();
    setStatus(`${fieldLabel[0].toUpperCase() + fieldLabel.slice(1)} generated.`);
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    updateActionButtons();
  }
}

function parseSseEventBlock(rawBlock) {
  let event = "message";
  const dataLines = [];
  const lines = rawBlock.split("\n");

  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  });

  const dataText = dataLines.join("\n");
  if (!dataText) {
    return { event, payload: {} };
  }

  try {
    return { event, payload: JSON.parse(dataText) };
  } catch {
    return { event, payload: { text: dataText } };
  }
}

async function requestGeneratedPartStream(storySoFarForRequest, onChunk, signal) {
  const payload = getStoryPayload();
  const settings = getSettings();

  if (!payload.whatHappensNext) {
    throw new Error("Describe what happens next before generating.");
  }
  if (payload.paragraphLimit < 1) {
    throw new Error("Paragraph limit must be at least 1.");
  }

  const res = await fetch("/api/generate-part-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      ...payload,
      storySoFar: storySoFarForRequest,
      settings,
    }),
  });

  if (!res.ok) {
    let errorMessage = "Generation failed.";
    try {
      const data = await res.json();
      errorMessage = data.error || errorMessage;
    } catch {
      // Non-JSON error body.
    }
    throw new Error(errorMessage);
  }
  if (!res.body) {
    throw new Error("Streaming is not available in this browser.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  let finalPartText = "";
  let streamDone = false;

  while (!streamDone) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawBlock = buffer.slice(0, separatorIndex).trim();
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf("\n\n");

      if (!rawBlock) {
        continue;
      }

      const parsed = parseSseEventBlock(rawBlock);
      if (parsed.event === "chunk") {
        const piece = String(parsed.payload.text || "");
        if (piece) {
          streamedText += piece;
          onChunk(streamedText);
        }
        continue;
      }

      if (parsed.event === "done") {
        finalPartText = String(parsed.payload.partText || "").trim() || streamedText.trim();
        if (finalPartText) {
          onChunk(finalPartText);
        }
        streamDone = true;
        break;
      }

      if (parsed.event === "error") {
        const errorMessage = String(parsed.payload.error || "Streaming generation failed.");
        throw new Error(errorMessage);
      }
    }

    if (done) {
      break;
    }
  }

  const trailingBlock = buffer.trim();
  if (!streamDone && trailingBlock) {
    const parsed = parseSseEventBlock(trailingBlock);
    if (parsed.event === "done") {
      finalPartText = String(parsed.payload.partText || "").trim() || streamedText.trim();
      if (finalPartText) {
        onChunk(finalPartText);
      }
      streamDone = true;
    } else if (parsed.event === "error") {
      const errorMessage = String(parsed.payload.error || "Streaming generation failed.");
      throw new Error(errorMessage);
    }
  }

  const output = finalPartText || streamedText.trim();
  if (!output) {
    throw new Error("Model returned no usable content.");
  }
  return output;
}

function isAbortError(err) {
  return Boolean(err && (err.name === "AbortError" || String(err.message || "").includes("aborted")));
}

function stopGeneration() {
  if (!state.isGenerating || !state.activeAbortController) {
    return;
  }
  setStatus("Stopping generation...");
  state.activeAbortController.abort();
}

async function generateNextPart() {
  setStatus("Generating next part...");
  state.isGenerating = true;
  state.activeAbortController = new AbortController();
  updateActionButtons();
  state.generatedParts.push("");
  const partIndex = state.generatedParts.length - 1;
  render({ scrollToEnd: true });

  try {
    const contextBeforeNewPart = buildStoryText(state.storyBase, state.generatedParts.slice(0, -1));
    const newPart = await requestGeneratedPartStream(
      contextBeforeNewPart,
      (partialText) => {
        state.generatedParts[partIndex] = partialText;
        render({ scrollToEnd: true });
      },
      state.activeAbortController.signal
    );
    state.generatedParts[partIndex] = newPart;
    render({ scrollToEnd: true });
    saveDraft();
    setStatus("Added the next story part.");
  } catch (err) {
    const aborted = state.activeAbortController?.signal.aborted || isAbortError(err);
    if (!String(state.generatedParts[partIndex] || "").trim()) {
      state.generatedParts.splice(partIndex, 1);
      render();
    }
    if (aborted) {
      saveDraft();
      setStatus("Generation stopped.");
    } else {
      setStatus(String(err.message || err), true);
    }
  } finally {
    state.activeAbortController = null;
    state.isGenerating = false;
    render();
  }
}

async function regenerateLastPart() {
  if (!state.generatedParts.length) {
    setStatus("No generated part is available to re-generate.", true);
    return;
  }

  const contextWithoutLast = buildStoryText(state.storyBase, state.generatedParts.slice(0, -1));
  const lastPartIndex = state.generatedParts.length - 1;
  const originalPart = state.generatedParts[lastPartIndex];

  setStatus("Re-generating last part...");
  state.isGenerating = true;
  state.activeAbortController = new AbortController();
  state.generatedParts[lastPartIndex] = "";
  render({ scrollToEnd: true });

  try {
    const newPart = await requestGeneratedPartStream(
      contextWithoutLast,
      (partialText) => {
        state.generatedParts[lastPartIndex] = partialText;
        render({ scrollToEnd: true });
      },
      state.activeAbortController.signal
    );
    state.generatedParts[lastPartIndex] = newPart;
    render({ scrollToEnd: true });
    saveDraft();
    setStatus("Last part re-generated.");
  } catch (err) {
    const aborted = state.activeAbortController?.signal.aborted || isAbortError(err);
    if (!String(state.generatedParts[lastPartIndex] || "").trim() || aborted) {
      state.generatedParts[lastPartIndex] = originalPart;
    }
    if (aborted) {
      setStatus("Generation stopped.");
    } else {
      setStatus(String(err.message || err), true);
    }
  } finally {
    state.activeAbortController = null;
    state.isGenerating = false;
    render();
  }
}

async function saveStory() {
  const payload = getStoryPayload();
  const jsonText = JSON.stringify(payload, null, 2);
  const safeTitle = (payload.title || "story").replace(/[^\w\-]+/g, "_");
  const fileName = `${safeTitle}.json`;

  if (!window.isSecureContext || !("showSaveFilePicker" in window)) {
    setStatus(
      "Save picker is not available in this browser/context. Use Chrome or Edge on localhost/https.",
      true
    );
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: fileName,
      types: [
        {
          description: "JSON Story File",
          accept: { "application/json": [".json"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(jsonText);
    await writable.close();
    setStatus("Story saved.");
  } catch (err) {
    if (err && err.name === "AbortError") {
      setStatus("Save canceled.");
      return;
    }
    const reason = err && err.message ? ` (${err.message})` : "";
    setStatus(`Save picker failed${reason}.`, true);
  }
}

function downloadStory() {
  const payload = getStoryPayload();
  const jsonText = JSON.stringify(payload, null, 2);
  const safeTitle = (payload.title || "story").replace(/[^\w\-]+/g, "_");
  const fileName = `${safeTitle}.json`;

  const blob = new Blob([jsonText], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  setStatus("Story downloaded.");
}

function asCleanString(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return "";
}

function toStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        return String(item).trim();
      }
      if (item && typeof item === "object") {
        return asCleanString(item.text || item.content || item.body || item.story || item.paragraph);
      }
      return "";
    })
    .filter(Boolean);
}

function pickFirstString(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") {
      continue;
    }
    for (const key of keys) {
      const value = asCleanString(obj[key]);
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function pickFirstInteger(objects, keys, fallback = 2) {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") {
      continue;
    }
    for (const key of keys) {
      const parsed = Number.parseInt(String(obj[key] ?? ""), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return fallback;
}

function extractStoryText(objects, rawData) {
  const directText = pickFirstString(objects, [
    "storySoFar",
    "story",
    "storyText",
    "story_text",
    "content",
    "text",
    "body",
  ]);
  if (directText) {
    return directText;
  }

  for (const obj of objects) {
    if (!obj || typeof obj !== "object") {
      continue;
    }
    const parts = toStringList(obj.paragraphs || obj.parts || obj.generatedParts || obj.sections || obj.scenes);
    if (!parts.length) {
      continue;
    }
    const base = asCleanString(obj._storyBase || obj.storyBase || obj.baseStory || obj.base || obj.intro);
    return [base, ...parts].filter(Boolean).join("\n\n").trim();
  }

  if (Array.isArray(rawData)) {
    return toStringList(rawData).join("\n\n").trim();
  }

  return "";
}

function normalizeImportedStoryPayload(rawData) {
  const root = rawData && typeof rawData === "object" ? rawData : {};
  const objects = [root];
  if (root && typeof root.data === "object") {
    objects.push(root.data);
  }
  if (root && typeof root.payload === "object") {
    objects.push(root.payload);
  }
  if (root && typeof root.story === "object") {
    objects.push(root.story);
  }

  return {
    title: pickFirstString(objects, ["title", "storyTitle", "name", "heading"]),
    storyOverview: pickFirstString(objects, ["storyOverview", "overview", "summary", "description", "premise"]),
    storySoFar: extractStoryText(objects, rawData),
    whatHappensNext: pickFirstString(objects, [
      "whatHappensNext",
      "next",
      "nextPrompt",
      "next_step",
      "prompt",
      "continuationPrompt",
    ]),
    storyArcInstruction: pickFirstString(objects, [
      "storyArcInstruction",
      "storyArc",
      "arcInstruction",
      "arc",
      "plotInstruction",
      "longTermInstruction",
    ]),
    paragraphLimit: pickFirstInteger(objects, ["paragraphLimit", "paragraphCount", "paragraphsPerPart"], 2),
  };
}

function loadStoryFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      const imported = normalizeImportedStoryPayload(parsed);
      const hasAnyField = Boolean(
        imported.title ||
          imported.storyOverview ||
          imported.storySoFar ||
          imported.whatHappensNext ||
          imported.storyArcInstruction
      );
      if (!hasAnyField) {
        throw new Error("No compatible story fields were found in this JSON file.");
      }

      els.title.value = imported.title;
      els.storyOverview.value = imported.storyOverview;
      els.whatHappensNext.value = imported.whatHappensNext;
      els.storyArcInstruction.value = imported.storyArcInstruction;
      els.paragraphLimit.value = String(imported.paragraphLimit);

      state.storyBase = imported.storySoFar;
      state.generatedParts = [];

      render({ scrollToEnd: true });
      saveDraft();
      setStatus("Story loaded (format auto-detected).");
    } catch (err) {
      setStatus(`Could not load file: ${String(err.message || err)}`, true);
    }
  };
  reader.readAsText(file);
}

function newStory() {
  els.title.value = "";
  els.storyOverview.value = "";
  els.storyArcInstruction.value = "";
  els.whatHappensNext.value = "";
  els.paragraphLimit.value = "2";

  state.storyBase = "";
  state.generatedParts = [];

  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Ignore storage errors.
  }

  render();
  setStatus("Started a new story. All fields cleared.");
}

els.generateBtn.addEventListener("click", generateNextPart);
els.stopBtn.addEventListener("click", stopGeneration);
els.regenerateBtn.addEventListener("click", regenerateLastPart);
els.generateTitleBtn.addEventListener("click", () => {
  generateMetadataField("title", els.generateTitleBtn);
});
els.generateArcBtn.addEventListener("click", () => {
  generateMetadataField("storyArcInstruction", els.generateArcBtn);
});
els.clearNextBtn.addEventListener("click", () => {
  els.whatHappensNext.value = "";
  saveDraft();
  setStatus("Next-part prompt cleared.");
});
els.saveBtn.addEventListener("click", saveStory);
els.downloadBtn.addEventListener("click", downloadStory);
els.newStoryBtn.addEventListener("click", newStory);
els.loadInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) {
    loadStoryFromFile(file);
  }
  event.target.value = "";
});
els.clearStoryBtn.addEventListener("click", () => {
  state.storyBase = "";
  state.generatedParts = [];
  render();
  saveDraft();
  setStatus("Story text cleared.");
});
els.title.addEventListener("input", () => {
  render();
  saveDraft();
});
els.storyOverview.addEventListener("input", saveDraft);
els.storyArcInstruction.addEventListener("input", saveDraft);
els.whatHappensNext.addEventListener("input", saveDraft);
els.paragraphLimit.addEventListener("input", saveDraft);
els.storySoFar.addEventListener("input", () => {
  state.storyBase = els.storySoFar.value;
  state.generatedParts = [];
  updateActionButtons();
  saveDraft();
});

state.settings = loadSettingsFromCache();
els.settingsSummary.textContent = summarizeSettings(getSettings());
refreshSettingsFromServer();
restoreDraft();
render({ scrollToEnd: true });

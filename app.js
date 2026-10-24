const STORAGE_KEY = "visionripe_bare_plan_v1";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const imageInput = document.querySelector("#image-input");
const preview = document.querySelector("#preview");
const analyzeButton = document.querySelector("#analyze-button");
const addButton = document.querySelector("#add-button");
const statusText = document.querySelector("#status");
const resultPanel = document.querySelector("#result");
const planList = document.querySelector("#plan-list");
const emptyPlan = document.querySelector("#empty-plan");
const planCount = document.querySelector("#plan-count");

let selectedFile = null;
let currentResult = null;

function loadPlan() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePlan(plan) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
}

function escapeText(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function normalizeStage(stage) {
  return String(stage || "unknown").replaceAll("_", " ");
}

function isUnsafe(item) {
  return item?.ripenessStage === "not_safe";
}

function recommendation(item) {
  if (isUnsafe(item)) return "Do not eat";
  if (["ripe", "peak_ripe", "overripe"].includes(item.ripenessStage)) {
    return "Use today";
  }
  if (item.ripenessStage === "near_ripe") return "Use soon";
  return "Can wait";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.onload = () => {
      const encoded = String(reader.result).split(",")[1];
      if (!encoded) reject(new Error("The image did not contain readable data."));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

async function analyzeSelectedImage() {
  if (!selectedFile) return;

  analyzeButton.disabled = true;
  statusText.textContent = "Analyzing produce…";
  resultPanel.classList.add("hidden");

  try {
    const imageBase64 = await fileToBase64(selectedFile);
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        responseVersion: 2,
        analysisMode: "home",
      }),
    });
    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      const responseDetail = responseText.trim().slice(0, 200);
      if (!response.ok) {
        throw new Error(
          `Analysis request failed (HTTP ${response.status}): ${responseDetail || response.statusText}. The server returned non-JSON; check that /api/analyze is routed to the VisionRipe server.`,
        );
      }
      throw new Error(
        "The analysis server returned an invalid response. Check that /api/analyze is routed to the VisionRipe server.",
      );
    }

    if (!response.ok) {
      throw new Error(data.message || data.error || "Analysis failed.");
    }
    if (data.error === "not_produce") {
      throw new Error(data.message || "No produce was detected.");
    }

    const item = Array.isArray(data.items) ? data.items[0] : data;
    if (!item?.name || !item?.ripenessStage) {
      throw new Error("The server returned an incomplete analysis.");
    }

    currentResult = item;
    renderResult(item);
    statusText.textContent = "";
  } catch (error) {
    currentResult = null;
    statusText.textContent =
      error instanceof Error ? error.message : "The image could not be analyzed.";
  } finally {
    analyzeButton.disabled = false;
  }
}

function renderResult(item) {
  document.querySelector("#result-name").textContent = item.name;
  document.querySelector("#result-stage").textContent = normalizeStage(
    item.ripenessStage,
  );
  document.querySelector("#result-confidence").textContent =
    `${Math.round(Number(item.confidence) || 0)}%`;
  document.querySelector("#result-status").textContent =
    item.currentStatus || "Not provided";
  document.querySelector("#result-time").textContent =
    item.bestTimeToEat || "Not provided";
  document.querySelector("#result-storage").textContent =
    item.storageTip || "Not provided";

  const warning = document.querySelector("#safety-warning");
  warning.classList.toggle("hidden", !isUnsafe(item));
  document.querySelector("#safety-reason").textContent =
    item.notSafeReason || "Visible condition may be unsafe.";
  addButton.disabled = isUnsafe(item);
  addButton.textContent = isUnsafe(item)
    ? "Unsafe produce cannot be planned"
    : "Add to local Plan";
  resultPanel.classList.remove("hidden");
}

function addCurrentResult() {
  if (!currentResult || isUnsafe(currentResult)) return;

  const plan = loadPlan();
  plan.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: currentResult.name,
    quantity: Math.max(1, Number(currentResult.quantity) || 1),
    ripenessStage: currentResult.ripenessStage,
    currentStatus: currentResult.currentStatus,
    storageTip: currentResult.storageTip,
    status: "planned",
    createdAt: Date.now(),
  });
  savePlan(plan);
  renderPlan();
  showView("plan");
}

function updatePlanItem(id, status) {
  const next = loadPlan().map((item) =>
    item.id === id ? { ...item, status } : item,
  );
  savePlan(next);
  renderPlan();
}

function renderPlan() {
  const plan = loadPlan();
  planCount.textContent = String(plan.filter((item) => item.status === "planned").length);
  planList.replaceChildren();
  emptyPlan.classList.toggle("hidden", plan.length > 0);

  const sorted = [...plan].sort((a, b) => {
    const aActive = a.status === "planned" ? 0 : 1;
    const bActive = b.status === "planned" ? 0 : 1;
    return aActive - bActive || b.createdAt - a.createdAt;
  });

  for (const item of sorted) {
    const article = document.createElement("article");
    article.className = "plan-item";
    const active = item.status === "planned";
    article.innerHTML = `
      <div class="plan-heading">
        <h3>${escapeText(item.name)}</h3>
        <span class="urgency">${escapeText(active ? recommendation(item) : item.status)}</span>
      </div>
      <p>${escapeText(item.quantity)} ${item.quantity === 1 ? "item" : "items"} · ${escapeText(normalizeStage(item.ripenessStage))}</p>
      <p>${escapeText(item.currentStatus || "")}</p>
      <div class="plan-actions">
        ${
          active
            ? `
              <button class="complete" data-id="${escapeText(item.id)}" data-status="eaten">Eaten</button>
              <button data-id="${escapeText(item.id)}" data-status="preserved">Preserved</button>
              <button class="discard" data-id="${escapeText(item.id)}" data-status="discarded">Discarded</button>
            `
            : `<button data-id="${escapeText(item.id)}" data-status="planned">Undo</button>`
        }
      </div>
    `;
    planList.append(article);
  }
}

function showView(viewName) {
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("hidden", view.id !== `${viewName}-view`);
  });
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === viewName);
  });
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0] || null;
  currentResult = null;
  resultPanel.classList.add("hidden");
  statusText.textContent = "";

  if (!file) {
    selectedFile = null;
    preview.classList.add("hidden");
    analyzeButton.disabled = true;
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    selectedFile = null;
    preview.classList.add("hidden");
    analyzeButton.disabled = true;
    statusText.textContent = "Choose an image smaller than 8 MB.";
    return;
  }

  selectedFile = file;
  preview.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");
  analyzeButton.disabled = false;
});

analyzeButton.addEventListener("click", analyzeSelectedImage);
addButton.addEventListener("click", addCurrentResult);

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-view]");
  if (tab) showView(tab.dataset.view);
});

planList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-id][data-status]");
  if (button) updatePlanItem(button.dataset.id, button.dataset.status);
});

renderPlan();
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 11 * 1024 * 1024;
const STAGES = new Set(["unripe", "near_ripe", "ripe", "peak_ripe", "overripe", "not_safe"]);
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function imageMimeType(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Choose an image smaller than 8 MB.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON request.");
    error.status = 400;
    throw error;
  }
}

function validateImage(body) {
  const base64 = body?.imageBase64;
  if (typeof base64 !== "string" || !base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    const error = new Error("A valid Base64 image is required.");
    error.status = 400;
    throw error;
  }
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    const error = new Error("Choose an image smaller than 8 MB.");
    error.status = 413;
    throw error;
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) {
    const error = new Error("Choose an image smaller than 8 MB.");
    error.status = 413;
    throw error;
  }
  const mimeType = imageMimeType(bytes);
  if (!mimeType) {
    const error = new Error("Choose a JPEG, PNG, GIF, or WebP image. Convert HEIC photos to JPEG first.");
    error.status = 400;
    throw error;
  }
  return { base64, mimeType };
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`AI response missing ${name}.`);
  return value.trim();
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid AI response.");
  if (raw.error === "not_produce") {
    return { error: "not_produce", message: "Please choose a clear photo of a fruit or vegetable." };
  }
  const item = Array.isArray(raw.items) ? raw.items[0] : raw;
  if (!item || !STAGES.has(item.ripenessStage)) throw new Error("AI response missing a valid ripeness stage.");
  const unsafe = item.ripenessStage === "not_safe";
  const confidence = Number(item.confidence);
  return {
    items: [{
      name: requireText(item.name, "produce name"),
      quantity: Math.max(1, Math.min(99, Math.round(Number(item.quantity) || 1))),
      ripenessStage: item.ripenessStage,
      confidence: Number.isFinite(confidence) ? Math.round(Math.max(0, Math.min(100, confidence))) : 0,
      currentStatus: requireText(item.currentStatus, "condition"),
      bestTimeToEat: unsafe ? "Do not eat" : requireText(item.bestTimeToEat, "best time to eat"),
      storageTip: unsafe ? "Discard safely; do not eat." : requireText(item.storageTip, "storage tip"),
      notSafeReason: unsafe ? requireText(item.notSafeReason, "safety reason") : null,
    }],
  };
}

async function analyze(image, env = process.env) {
  const key = env.AI_INTEGRATIONS_OPENAI_API_KEY || env.OPENAI_API_KEY;
  if (!key) {
    const error = new Error("AI analysis is not configured. Set OPENAI_API_KEY on the server.");
    error.status = 503;
    throw error;
  }
  const baseUrl = env.AI_INTEGRATIONS_OPENAI_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
    const endpointPath = endpoint.pathname.replace(/\/+$/, "");
    if (!endpointPath.endsWith("/chat/completions")) {
      endpoint.pathname = `${endpointPath}/chat/completions`;
    }
    if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("invalid protocol");
  } catch {
    const error = new Error("The AI endpoint is not configured correctly.");
    error.status = 503;
    throw error;
  }

  const prompt = `Analyze the most prominent fresh fruit or vegetable in this photo. Use visible evidence only. If there is no produce, return {"error":"not_produce"}. If visible mold, rot or severe decay makes it unsafe, use ripenessStage "not_safe" and explain why. Do not claim a photo guarantees food safety. Return ONLY JSON:
{"name":"produce name","quantity":1,"ripenessStage":"unripe|near_ripe|ripe|peak_ripe|overripe|not_safe","confidence":80,"currentStatus":"visible condition","bestTimeToEat":"timeframe or Do not eat","storageTip":"storage or disposal advice","notSafeReason":null}
Use an integer confidence from 0 to 100. Supply notSafeReason as a nonempty string when not_safe.`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-5.1",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "high" } },
            { type: "text", text: prompt },
          ],
        }],
        max_completion_tokens: 1200,
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    const error = new Error("The AI service could not be reached. Please try again.");
    error.status = 502;
    throw error;
  }
  if (!response.ok) {
    const error = new Error("The AI service could not analyze this image. Check your server's AI configuration.");
    error.status = 502;
    throw error;
  }
  try {
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Missing response content");
    let raw;
    try {
      raw = JSON.parse(content);
    } catch {
      const jsonObject = content.match(/\{[\s\S]*\}/);
      if (!jsonObject) throw new Error("Missing JSON response");
      raw = JSON.parse(jsonObject[0]);
    }
    return normalizeResult(raw);
  } catch {
    const error = new Error("The AI service returned an incomplete analysis. Please try another photo.");
    error.status = 502;
    throw error;
  }
}

function createServer({ env = process.env } = {}) {
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && pathname === "/api/analyze") {
      try {
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          return sendJson(res, 415, { message: "Send JSON image data." });
        }
        const body = await readBody(req);
        const image = validateImage(body);
        return sendJson(res, 200, await analyze(image, env));
      } catch (error) {
        return sendJson(res, error.status || 502, { message: error.message });
      }
    }
    const file = FILES[pathname];
    if (req.method === "GET" && file) {
      const data = await fs.readFile(path.join(__dirname, file[0]));
      res.writeHead(200, { "Content-Type": file[1], "X-Content-Type-Options": "nosniff" });
      return res.end(data);
    }
    return sendJson(res, 404, { message: "Not found." });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be a number between 1 and 65535.");
    process.exit(1);
  }
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`VisionRipe basic prototype: http://localhost:${port}`);
  });
}

module.exports = { createServer };
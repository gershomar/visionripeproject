const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer } = require("../server");

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).toString("base64");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(baseUrl, imageBase64 = jpeg) {
  return fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64, responseVersion: 2, analysisMode: "home" }),
  });
}

test("serves the standalone page and analyzes a photo via an AI endpoint", async (t) => {
  let modelRequest;
  const provider = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer test-credential");
    let body = "";
    for await (const chunk of req) body += chunk;
    modelRequest = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        name: "Banana", quantity: 1, ripenessStage: "ripe", confidence: 91,
        currentStatus: "Yellow peel", bestTimeToEat: "Today or tomorrow",
        storageTip: "Store on the counter", notSafeReason: null,
      }) } }],
    }));
  });
  const providerUrl = await listen(provider);
  t.after(() => provider.close());
  const app = createServer({ env: {
    OPENAI_API_KEY: "test-credential",
    OPENAI_BASE_URL: `${providerUrl}/v1`,
  } });
  const appUrl = await listen(app);
  t.after(() => app.close());

  const page = await fetch(appUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /VisionRipe/);
  const script = await fetch(`${appUrl}/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /\/api\/analyze/);

  const response = await request(appUrl);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.items[0].name, "Banana");
  assert.equal(result.items[0].ripenessStage, "ripe");
  assert.equal(modelRequest.model, "gpt-5.1");
  assert.match(modelRequest.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test("accepts an AI base URL that already includes the chat completions path", async (t) => {
  const provider = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        name: "Banana", quantity: 1, ripenessStage: "ripe", confidence: 90,
        currentStatus: "Yellow peel", bestTimeToEat: "Today",
        storageTip: "Store on the counter", notSafeReason: null,
      }) } }],
    }));
  });
  const providerUrl = await listen(provider);
  t.after(() => provider.close());
  const app = createServer({
    env: {
      OPENAI_API_KEY: "test-credential",
      OPENAI_BASE_URL: `${providerUrl}/v1/chat/completions`,
    },
  });
  const appUrl = await listen(app);
  t.after(() => app.close());

  const response = await request(appUrl);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].name, "Banana");
});

test("rejects invalid images and reports missing credentials explicitly", async (t) => {
  const app = createServer({ env: {} });
  const url = await listen(app);
  t.after(() => app.close());

  const invalid = await request(url, Buffer.from("not an image").toString("base64"));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).message, /JPEG, PNG, GIF, or WebP/);
  const unconfigured = await request(url);
  assert.equal(unconfigured.status, 503);
  assert.match((await unconfigured.json()).message, /not configured/);
});

test("unsafe results always advise against eating", async (t) => {
  const provider = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        name: "Strawberry", ripenessStage: "not_safe", confidence: 80,
        currentStatus: "Visible mold", bestTimeToEat: "Tomorrow",
        storageTip: "Refrigerate", notSafeReason: "Visible mold",
      }) } }],
    }));
  });
  const providerUrl = await listen(provider);
  t.after(() => provider.close());
  const app = createServer({ env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: `${providerUrl}/v1` } });
  const url = await listen(app);
  t.after(() => app.close());

  const response = await request(url);
  assert.equal(response.status, 200);
  const item = (await response.json()).items[0];
  assert.equal(item.bestTimeToEat, "Do not eat");
  assert.match(item.storageTip, /Discard safely/);
  assert.equal(item.notSafeReason, "Visible mold");
});
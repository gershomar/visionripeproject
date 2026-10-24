# VisionRipe 1.0 ## What it does

Choose a fruit or vegetable photo, analyze visible ripeness and condition, view a storage recommendation, and add safe produce to a browser-local Plan. Planned items can be marked eaten, preserved, or discarded. No account or full VisionRipe backend is needed.

## Run it

You need Node.js 20 or later and an AI endpoint that supports OpenAI-style chat completions with image inputs. **Real photo analysis needs an AI credential and internet access it does not work offline.**
set `OPENAI_API_KEY` as a secret or environment variable; `OPENAI_BASE_URL` is optional and defaults to `https://api.openai.com/v1`. It can be either the API base URL or the full `/chat/completions` endpoint. The default model is `gpt-5.1`; `OPENAI_MODEL` can override it with a compatible vision-capable model.

From this folder:

```bash
npm start
```

Open `http://localhost:3000`. To use another port, set `PORT` before starting the server. There are **no npm dependencies to install**, and you do not need to start the full VisionRipe app.

The server reads API KEY from the environment and sends the image to the AI provider. Photos are not saved by this server; the browser's Plan remains in that browser's local storage. Your AI provider may have its own data-handling policy.

Run `npm test` for the included local API tests. These use a simulated AI endpoint, so no key or network access is needed for the tests. To demonstrate *real* scanning, configure an actual AI service.

## Files

- `index.html`, `styles.css`, `app.js` — browser interface and local Plan
- `server.js` — static web server and photo-analysis endpoint
- `package.json` — run and test commands (no external dependencies)
- `test/server.test.js` — checks request validation and results

**Safety:** Photo-based predictions are informational, not a guarantee of food safety. Never eat produce that looks or smells unsafe.
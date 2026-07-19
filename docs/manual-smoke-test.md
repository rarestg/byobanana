# Manual smoke test — BYOK key validation + live generation

This project cannot make an authenticated Google call in CI (no API key in the build
environment), so the live wire contract is verified by hand with these steps. Run them
once you have a real Google API key from <https://aistudio.google.com/apikey>.

> **Wire contract verified live (2026-07-16).** Against a real key, the app's request shape
> was confirmed end-to-end: `POST /v1beta/models/gemini-3.1-flash-image:generateContent` with
> `generationConfig.imageConfig: { imageSize, aspectRatio }` and `tools: [{ googleSearch: {} }]`
> returns an image (a 512 request yielded a 512×512 JPEG), and grounded responses carry
> `candidates[].groundingMetadata` ({ searchEntryPoint.renderedContent, groundingChunks[].web,
> webSearchQueries }). **The `/v1` endpoint does NOT work** — it 400s with "Cannot find field"
> on `tools`, `responseModalities`, and `imageConfig` (those live only on `/v1beta`), and it does
> not even expose the Pro image model. `src/core/gemini.ts` uses `/v1beta` accordingly.
>
> An automated version of this exists: `GEMINI_KEY=... node scripts/verify-live.mjs` drives the
> built app through a real grounded generation and screenshots the result (REAL CHARGES).

## Prerequisites

- A Google API key with Gemini API access (image generation entitlement).
- **Real charges apply.** A single image call bills your Google account. Keep the run to
  one image.

## Steps

1. **Start the app.**

   ```bash
   npm run dev
   ```

   Open the workbench at the printed URL plus `/app/` (usually
   <http://localhost:5173/app/>; the bare URL is now the static landing page). Open the browser
   devtools Console — it must stay clean (no red errors) throughout.

2. **Header pill — unconfigured state.** The header shows a grey pill reading
   **"API key not configured"** with a `○` mark. Confirm it is a button (focusable,
   `aria-haspopup="dialog"`).

3. **Open the key modal.** Click the pill. A modal titled **"Google API key"** opens
   with:
   - a privacy line ("sent directly from your browser to Google — never to our servers"),
   - a link to `aistudio.google.com/apikey`,
   - a masked **PasswordInput**,
   - a **"This session only" / "Remember"** segmented control (defaulting to "This session only"),
   - a **"Connect / Validate"** button (disabled while the field is empty).

4. **Persistence choice.** The yellow "Generating images costs real money" alert is always
   visible (not gated on the choice). Select **"Remember"**: the caption discloses the key is
   saved in this browser and to avoid shared computers; **"This session only"** notes it is not
   saved. Leave it on **"This session only"** for now.

5. **Validate (zero-cost).** Paste your key and click **Connect / Validate**. This calls
   `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000` — **no paid
   inference**. Expected within a couple of seconds:
   - a green **"Key validated"** alert listing which of the 3 workbench models the key can
     see (e.g. "Nano Banana 2 · Gemini 3.1 Flash Image"),
   - the header pill flips to **"API key configured"** (teal, `✓` mark).

   In the devtools **Network** tab, confirm the request went to `/v1beta/models`, the key is in
   the **`x-goog-api-key` request header** (NOT the URL), and there is no CORS error.

   - **Bad key check:** clear the field, type a wrong key, Validate → a red
     **"Could not validate"** alert with the friendly "Invalid or unauthorized API key…"
     message; the pill stays grey.

6. **Persist across reload (optional).** Select "Remember", reload the
   page. The remembered key **auto-validates on boot** (a free `GET /v1beta/models`): the
   pill should land in the **configured** state without the onboarding banner appearing.
   Then **Clear key** and confirm localStorage no longer holds
   `nano-banana-web:gemini-key` (Application → Local Storage) — the onboarding banner
   returns.

7. **One live generation through the UI.** With a validated key (there is no mock switch —
   without a key the banner gates the form). In **Set up a run**, set **Variants per style** to `1` (keep one style) so a
   run is a single billed call, enter a subject (e.g. "a single ripe banana, product photo"),
   and click **Generate**. Expected: the contact sheet shows one card that fills with the
   generated image; clicking it opens the inspector with **Status: Succeeded**, a real **Cost**
   (USD), the **Model** version, and the pixel **Size**. Console stays clean.

   - **Grounding (optional, adds search charges):** open **References and generation settings**,
     toggle **Google Search grounding** on, and use a subject that needs current info (e.g. "an
     icon for the current weather in London — search live conditions first"). After it succeeds,
     the inspector shows a **Grounded with Google Search** section: Google's Search Suggestions
     widget plus **Sources** chips. (Grounding attribution is shown for the live run only — it is
     not stored, so it does not reappear after a reload.)

   The automated equivalent of this whole step is `GEMINI_KEY=... node scripts/verify-live.mjs`.

## Wire-contract switches (only if the contract stops working)

The contract is **live-verified on `/v1beta`** (2026-07-16), but Google iterates. If a call
starts failing with a `404`/`NOT_FOUND` on the model, or `imageSize`/`aspectRatio` appear to be
ignored, these are the documented alternates in `src/core/gemini.ts`:

- **Endpoint version:** we use `/v1beta` (required — `/v1` rejects `tools`, `responseModalities`,
  and `imageConfig`). If Google promotes these fields to a stable surface, `API_BASE` can move to
  `/v1`; re-verify with `scripts/verify-live.mjs` before switching.
- **Image config field:** we send `generationConfig.imageConfig: { imageSize, aspectRatio }`
  (verified to honor a 512 request → 512×512 output). If size/aspect are ever ignored, the
  documented alternate is `generationConfig.responseFormat.image: { imageSize, aspectRatio }`.
  Send **one** of the two, never both.
- **Newer Interactions API:** Google also exposes `POST /v1beta/interactions` (a different,
  step-based wire contract with `output_image` and snake_case `usage`). The app deliberately
  stays on the working `:generateContent` path; migrating to Interactions is a larger change
  (new request/response shapes, cost accounting, grounding) tracked as future work, not a
  drop-in switch.

Note: Google is migrating away from standard API keys during 2026 (unrestricted Standard keys
are already being rejected; all Standard keys are slated for rejection in September 2026), so a
future key format may need revisiting.

## Content gates

- **No em/en dashes in public copy** (the site bans them by design, literal and HTML-entity
  forms alike). The gate runs automatically as the last step of `npm run build` (and therefore on
  every `deploy` / `deploy:worker`); run it on its own with:

  ```bash
  npm run check:dashes    # scans dist/; run after a build
  ```

  It scans every built HTML file under `dist/` for literal em/en dashes plus every HTML-entity
  spelling (named, decimal, and hex, with or without the trailing semicolon) and exits non-zero on
  any hit. Rewrite offending copy without a dash (split into two sentences, or use a colon/comma).

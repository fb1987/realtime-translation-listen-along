# Realtime Translation Listen-Along

Private mobile web app for one-way Chinese-to-English live audio translation with OpenAI Realtime Translation.

## What It Does

- Captures phone microphone audio in the browser.
- Mints a short-lived OpenAI Realtime Translation client secret from `/session`.
- Sends the browser SDP offer to `https://api.openai.com/v1/realtime/translations/calls`.
- Plays translated English audio through the browser audio route, including Bluetooth headphones selected at the OS level.
- Keeps the OpenAI API key server-side only.
- Tracks connection and first-audio timing in debug mode.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

Required environment variable:

- `OPENAI_API_KEY`

Optional environment variables:

- `APP_PASSWORD`: shared secret gate for private use.
- `OPENAI_SAFETY_IDENTIFIER`: stable privacy-preserving identifier sent from the server to OpenAI.

## Render

This repo includes `render.yaml`. Create a Render Blueprint or web service and set:

- `OPENAI_API_KEY`
- `APP_PASSWORD`

Use the default build command `npm ci && npm run build` and start command `npm run start`.

## Notes

OpenAI Realtime Translation uses the dedicated `/v1/realtime/translations` endpoint family. Current OpenAI cookbook guidance says `gpt-realtime-translate` does not support custom prompting or fixed voice selection, so the server first attempts the requested Chinese-only instruction and falls back if the API rejects it.

TODO: Add a deterministic Mandarin/Cantonese language-detection gate before creating/sending translation audio if prompt-level filtering is insufficient.

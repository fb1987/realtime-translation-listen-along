import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");

const OPENAI_TRANSLATION_SECRET_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";

const CHINESE_ONLY_INSTRUCTIONS =
  "Only translate Mandarin or Cantonese Chinese into English. If the detected speech is already English or not Chinese, return silence / no translated audio.";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

function requireAppSecret(req, res, next) {
  const configuredSecret = process.env.APP_PASSWORD || process.env.APP_SHARED_SECRET;
  if (!configuredSecret) {
    next();
    return;
  }

  const auth = req.get("authorization") ?? "";
  const headerSecret = req.get("x-app-secret") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

  if (bearer === configuredSecret || headerSecret === configuredSecret) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

function buildTranslationSession({ withInstructions = true } = {}) {
  return {
    session: {
      model: "gpt-realtime-translate",
      ...(withInstructions ? { instructions: CHINESE_ONLY_INSTRUCTIONS } : {}),
      audio: {
        input: {
          transcription: { model: "gpt-realtime-whisper" },
          noise_reduction: { type: "near_field" },
        },
        output: { language: "en" },
      },
    },
    expires_after: {
      anchor: "created_at",
      seconds: 120,
    },
  };
}

function parseOpenAISecret(data) {
  const value = data?.client_secret?.value ?? data?.client_secret ?? data?.value;
  if (!value || typeof value !== "string") {
    throw new Error("OpenAI response did not include a client secret.");
  }
  return {
    client_secret: value,
    expires_at: data?.client_secret?.expires_at ?? data?.expires_at ?? null,
  };
}

async function createTranslationSecret({ withInstructions }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      status: 500,
      text: JSON.stringify({ error: "OPENAI_API_KEY is not configured on the server." }),
    };
  }

  const response = await fetch(OPENAI_TRANSLATION_SECRET_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      ...(process.env.OPENAI_SAFETY_IDENTIFIER
        ? { "OpenAI-Safety-Identifier": process.env.OPENAI_SAFETY_IDENTIFIER }
        : {}),
    },
    body: JSON.stringify(buildTranslationSession({ withInstructions })),
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
  };
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/config", (_req, res) => {
  res.json({
    authRequired: Boolean(process.env.APP_PASSWORD || process.env.APP_SHARED_SECRET),
  });
});

app.post("/session", requireAppSecret, async (_req, res) => {
  try {
    let languageFilterMode = "session_instructions";
    let openAIResponse = await createTranslationSecret({ withInstructions: true });

    if (!openAIResponse.ok && /instructions|unsupported|unknown/i.test(openAIResponse.text)) {
      // TODO: Add a deterministic Mandarin/Cantonese language-detection gate before WebRTC audio reaches OpenAI.
      // Realtime Translation currently may reject or ignore custom instructions, so we fall back to the
      // dedicated translation model's same-language suppression behavior rather than failing startup.
      languageFilterMode = "todo_language_detection_gate";
      openAIResponse = await createTranslationSecret({ withInstructions: false });
    }

    if (!openAIResponse.ok) {
      res.status(openAIResponse.status).type("application/json").send(openAIResponse.text);
      return;
    }

    const data = JSON.parse(openAIResponse.text);
    res.json({
      ...parseOpenAISecret(data),
      language_filter_mode: languageFilterMode,
      target_language: "en",
    });
  } catch (error) {
    console.error("Failed to create translation session", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create translation session.",
    });
  }
});

if (isProduction) {
  const distDir = path.join(rootDir, "dist");
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

const server = app.listen(port, host, () => {
  console.log(`Translation app listening on http://${host}:${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

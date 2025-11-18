import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, watch } from "fs";
import { join } from "path";
import "dotenv/config";

const IN_DIR = "in";
const OCR_DIR = "ocr";
const OUT_DIR = "out";

const AI_API_URL = process.env["AI_API_URL"]!;
const AI_API_KEY = process.env["AI_API_KEY"]!;
const AI_MODEL = process.env["AI_MODEL"]!;

// Ensure folders exist
mkdirSync(IN_DIR, { recursive: true });
mkdirSync(OCR_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

async function runOcrmypdf(input: string, output: string) {
  const proc = Bun.spawn([
    "uvx", "ocrmypdf",
    "-O", "0",              // disable optimization (avoid JPEG crash)
    "--output-type", "pdfa",
    "--redo-ocr",           // redo OCR even if text exists
    input, output
  ]);
  await proc.exited;
  if (!existsSync(output)) {
    throw new Error(`ocrmypdf did not produce output for ${input}`);
  }
}

async function extractText(pdfPath: string): Promise<string> {
  const txtPath = pdfPath.replace(/\.pdf$/i, ".txt");
  const proc = Bun.spawn(["pdftotext", pdfPath, txtPath]);
  await proc.exited;
  if (!existsSync(txtPath)) {
    throw new Error(`pdftotext did not produce output for ${pdfPath}`);
  }
  return await Bun.file(txtPath).text();
}

async function sendToAI(text: string): Promise<string> {
  // Cut off at ~2000 characters
  const truncated = text.length > 2000 ? text.slice(0, 2000) : text;

  const res = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "user",
          content: `From the following OCR text, extract the sender or organization name and the document date. 
Return ONLY a string in the format: YYYY-MM-DD - <Sender/Organization name> - <Sensible Title>. Example: 2020-01-15 - Agentur für Arbeit - Arbeitsuchendmeldung. Umlauts like äöüß are safe.
Do not add any other words or punctuation. Instead of using nonsense like Arbeitsuntähnigkeitsbescheinigung, use Arbeitsunfähigkeitsbescheinigung (fix spelling).\n\n${truncated}`
        }
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI API error: ${res.statusText}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "Untitled";
}

async function retrySendToAI(text: string, delayMs = 30000): Promise<string> {
  while (true) {
    try {
      return await sendToAI(text);
    } catch (err) {
      console.error("AI request failed:", err);
      console.log(`Retrying in ${delayMs / 1000} seconds...`);
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
}

function sanitizeFilename(name: string): string {
  // Allow all Unicode letters, numbers, spaces, underscores, and dashes
  return name.replace(/[^\p{L}\p{N} _-]/gu, "_");
}

function getUniqueOutPath(baseName: string): string {
  let counter = 1;
  let outPath = join(OUT_DIR, `${baseName}.pdf`);
  while (existsSync(outPath)) {
    outPath = join(OUT_DIR, `${baseName}_${counter}.pdf`);
    counter++;
  }
  return outPath;
}

async function processPdf(file: string) {
  const inputPath = join(IN_DIR, file);
  const ocrPath = join(OCR_DIR, file);

  try {
    console.log(`Preprocessing ${inputPath} with ocrmypdf...`);
    await runOcrmypdf(inputPath, ocrPath);

    console.log(`Extracting text from ${ocrPath}...`);
    const text = await extractText(ocrPath);

    console.log(`Sending text to AI API...`);
    const title = await retrySendToAI(text);
    const safeTitle = sanitizeFilename(title);

    const outPath = getUniqueOutPath(safeTitle);

    renameSync(ocrPath, outPath);
    console.log(`Renamed and moved to: ${outPath}`);

    // Delete original input file
    unlinkSync(inputPath);
    console.log(`Deleted original input file: ${inputPath}`);
  } catch (err) {
    console.error(`Error processing ${file}:`, err);
  }
}

async function processAllPdfs() {
  const files = readdirSync(IN_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  for (const file of files) {
    await processPdf(file);
  }
}

// Run once on startup
processAllPdfs().catch(err => console.error("Startup error:", err));

// Watch for new files
watch(IN_DIR, { persistent: true }, (eventType, filename) => {
  if (filename && filename.toLowerCase().endsWith(".pdf") && eventType === "rename") {
    const inputPath = join(IN_DIR, filename);
    if (existsSync(inputPath)) {
      console.log(`New file detected: ${filename}`);
      processPdf(filename);
    }
  }
});

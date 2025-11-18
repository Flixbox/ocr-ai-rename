import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "fs";
import { join } from "path";
import "dotenv/config";

const IN_DIR = "in";
const FORCE_DIR = "force-processing";
const CLEANED_DIR = "cleaned";
const OCR_DIR = "ocr";
const OUT_DIR = "out";
const TITLES_FILE = "titles.json";

const AI_API_URL = process.env["AI_API_URL"]!;
const AI_API_KEY = process.env["AI_API_KEY"]!;
const AI_MODEL = process.env["AI_MODEL"]!;

// Ensure folders exist
mkdirSync(IN_DIR, { recursive: true });
mkdirSync(FORCE_DIR, { recursive: true });
mkdirSync(CLEANED_DIR, { recursive: true });
mkdirSync(OCR_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// --- Global processing queue ---
type QueueItem = { file: string; force: boolean };
const queue: QueueItem[] = [];
let processing = false;

function enqueue(file: string, force = false) {
  queue.push({ file, force });
  if (!processing) {
    processQueue();
  }
}

async function processQueue() {
  processing = true;
  while (queue.length > 0) {
    const { file, force } = queue.shift()!;
    await processPdf(file, force);
  }
  processing = false;
}

// --- Title persistence helpers ---
function ensureTitlesFile() {
  if (!existsSync(TITLES_FILE)) {
    writeFileSync(TITLES_FILE, JSON.stringify([]));
  }
}

function readTitles(): string[] {
  ensureTitlesFile();
  try {
    const raw = readFileSync(TITLES_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeTitles(titles: string[]) {
  writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
}

function addTitle(title: string) {
  const titles = readTitles();
  titles.push(title);
  writeTitles(titles);
}

// --- Ghostscript cleaning step ---
async function runGhostscript(input: string, output: string) {
  const proc = Bun.spawn([
    "gs",
    "-o", output,
    "-sDEVICE=pdfwrite",
    "-dPDFSETTINGS=/prepress",
    input
  ]);
  await proc.exited;
  if (!existsSync(output)) {
    throw new Error(`Ghostscript did not produce output for ${input}`);
  }
}

// --- OCR + AI pipeline ---

async function hasTextLayer(pdfPath: string): Promise<boolean> {
  const txtPath = pdfPath.replace(/\.pdf$/i, ".check.txt");
  const proc = Bun.spawn(["pdftotext", pdfPath, txtPath]);
  await proc.exited;

  if (!existsSync(txtPath)) return false;
  const text = await Bun.file(txtPath).text();
  unlinkSync(txtPath); // cleanup

  return text.trim().length > 0;
}

async function runOcrmypdf(input: string, output: string) {
  const proc = Bun.spawn([
    "uvx", "ocrmypdf",

    // disable optimization (avoid JPEG crash)
    "-O", "0",

    "--output-type", "pdfa",

    "--rotate-pages",
    "--rotate-pages-threshold", "7",

    // redo OCR even if text exists
    "--redo-ocr",

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
          content: `From the following OCR text, extract the sender or organization name and the document date [if any date part unknown: replace with zeroes]. 
Return ONLY a string in the format: YYYY-MM-DD - <Sender/Organization name> - <Sensible Title>. Example: 2020-01-15 - Agentur für Arbeit - Arbeitsuchendmeldung. Umlauts like äöüß are safe.
Do not add any other words or punctuation. Instead of using nonsense like Arbeitsuntähnigkeitsbescheinigung, use Arbeitsunfähigkeitsbescheinigung (fix spelling). Add labeled identifying numbers to the title, like billing IDs.\n\n${truncated}`
        }
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI API error: ${res.statusText}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "Untitled";
}

async function retrySendToAI(
  text: string,
  delayMs = 61_000
): Promise<string> {
  try {
    // Always wait at least delayMs
    await new Promise(res => setTimeout(res, delayMs));
    return await sendToAI(text);
  } catch (err) {
    console.error("AI request failed:", err);
    console.log(`Retrying in ${Math.round(delayMs / 1000)} seconds...`);

    await new Promise(res => setTimeout(res, delayMs));

    // recurse with doubled delay, capped
    const nextDelay = Math.min(delayMs * 2);
    return retrySendToAI(text, nextDelay);
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N} _-]/gu, "_");
}

// --- Updated unique path logic using titles.json ---
function getUniqueOutPath(baseName: string): string {
  let counter = 1;
  let candidate = baseName;
  let outPath = join(OUT_DIR, `${candidate}.pdf`);

  // Always re-read titles.json to avoid race conditions
  let titles = readTitles();

  while (existsSync(outPath) || titles.includes(candidate)) {
    candidate = `${baseName}_${counter}`;
    outPath = join(OUT_DIR, `${candidate}.pdf`);
    counter++;
  }

  // Persist the chosen title
  addTitle(candidate);

  return outPath;
}

// --- Main processing ---
async function processPdf(file: string, force: boolean) {
  const inputPath = force ? join(FORCE_DIR, file) : join(IN_DIR, file);
  const cleanedPath = join(CLEANED_DIR, file);
  const ocrPath = join(OCR_DIR, file);

  try {
    console.log(`Cleaning ${inputPath} with Ghostscript...`);
    await runGhostscript(inputPath, cleanedPath);

    if (force) {
      console.log(`Force-processing enabled: always running OCR on ${cleanedPath}...`);
      await runOcrmypdf(cleanedPath, ocrPath);
      unlinkSync(cleanedPath);
    } else {
      const alreadyHasText = await hasTextLayer(cleanedPath);

      if (alreadyHasText) {
        console.log(`Skipping OCR for ${cleanedPath}, text layer already present.`);
        // Just copy cleaned file into OCR_DIR for consistency
        renameSync(cleanedPath, ocrPath);
      } else {
        console.log(`Running OCR on ${cleanedPath}...`);
        await runOcrmypdf(cleanedPath, ocrPath);
        unlinkSync(cleanedPath);
      }
    }
    
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

// --- Startup scan ---
(async () => {
  const files = readdirSync(IN_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  for (const file of files) enqueue(file, false);

  const forceFiles = readdirSync(FORCE_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  for (const file of forceFiles) enqueue(file, true);
})();

// --- Watchers ---
watch(IN_DIR, { persistent: true }, (eventType, filename) => {
  if (filename?.toLowerCase().endsWith(".pdf") && eventType === "rename") {
    const inputPath = join(IN_DIR, filename);
    if (existsSync(inputPath)) {
      console.log(`New file detected in IN_DIR: ${filename}, waiting 10 seconds before enqueue...`);
      setTimeout(() => {
        if (existsSync(inputPath)) enqueue(filename, false);
      }, 10_000);
    }
  }
});

watch(FORCE_DIR, { persistent: true }, (eventType, filename) => {
  if (filename?.toLowerCase().endsWith(".pdf") && eventType === "rename") {
    const inputPath = join(FORCE_DIR, filename);
    if (existsSync(inputPath)) {
      console.log(`New file detected in FORCE_DIR: ${filename}, waiting 10 seconds before enqueue...`);
      setTimeout(() => {
        if (existsSync(inputPath)) enqueue(filename, true);
      }, 10_000);
    }
  }
});
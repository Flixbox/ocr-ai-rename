import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "fs";
import { join } from "path";
import "dotenv/config";

const IN_DIR = "in";
const CLEANED_DIR = "cleaned";
const OCR_DIR = "ocr";
const OUT_DIR = "out";
const TITLES_FILE = "titles.json";

const AI_API_URL = process.env["AI_API_URL"]!;
const AI_API_KEY = process.env["AI_API_KEY"]!;
const AI_MODEL = process.env["AI_MODEL"]!;

// Ensure folders exist
mkdirSync(IN_DIR, { recursive: true });
mkdirSync(CLEANED_DIR, { recursive: true });
mkdirSync(OCR_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

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
async function processPdf(file: string) {
  const inputPath = join(IN_DIR, file);
  const cleanedPath = join(CLEANED_DIR, file);
  const ocrPath = join(OCR_DIR, file);

  try {
    console.log(`Cleaning ${inputPath} with Ghostscript...`);
    await runGhostscript(inputPath, cleanedPath);

    // Check if cleaned PDF already has text
    const alreadyHasText = await hasTextLayer(cleanedPath);

    if (alreadyHasText) {
      console.log(`Skipping OCR for ${cleanedPath}, text layer already present.`);
      // Just copy cleaned file into OCR_DIR for consistency
      renameSync(cleanedPath, ocrPath);
    } else {
      console.log(`Running OCR on ${cleanedPath}...`);
      await runOcrmypdf(cleanedPath, ocrPath);
      unlinkSync(cleanedPath); // cleanup only if OCR was run
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
      console.log(`New file detected: ${filename}, waiting 10 seconds before processing...`);
      setTimeout(() => {
        if (existsSync(inputPath)) {
          processPdf(filename);
        } else {
          console.warn(`File ${filename} no longer exists after delay.`);
        }
      }, 10_000);  // 10 second delay to avoid permission issues during download/sync
    }
  }
});

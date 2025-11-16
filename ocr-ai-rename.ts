// ocr-rename.ts
import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import "dotenv/config";

const IN_DIR = "in";
const OCR_DIR = "ocr";
const OUT_DIR = "out";

const AI_API_URL = process.env.AI_API_URL!;
const AI_API_KEY = process.env.AI_API_KEY!;

// Ensure folders exist
mkdirSync(IN_DIR, { recursive: true });
mkdirSync(OCR_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

async function runOcrmypdf(input: string, output: string) {
  const proc = Bun.spawn(["uvx", "ocrmypdf", input, output]);
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
  const model = process.env.AI_MODEL!;
  const res = await fetch(process.env.AI_API_URL!, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { 
          role: "user", 
          content: `From the following OCR text, extract the sender or organization name and the document date. 
Return ONLY a string in the format: YYYY-MM-DD - <Sender/Organization name> - <Sensible Title>. Example: 2020-01-15 - Agentur für Arbeit - Arbeitsuchendmeldung. Umlauts like äöüß are safe.
Do not add any other words or punctuation.\n\n${text}` 
        }
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI API error: ${res.statusText}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "Untitled";
}

function sanitizeFilename(name: string): string {
  // Allow all Unicode letters, numbers, spaces, underscores, and dashes
  return name.replace(/[^\p{L}\p{N} _-]/gu, "_");
}

async function processPdfs() {
  const files = readdirSync(IN_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  for (const file of files) {
    const inputPath = join(IN_DIR, file);
    const ocrPath = join(OCR_DIR, file);

    console.log(`Preprocessing ${inputPath} with ocrmypdf...`);
    await runOcrmypdf(inputPath, ocrPath);

    console.log(`Extracting text from ${ocrPath}...`);
    const text = await extractText(ocrPath);

    console.log(`Sending text to AI API...`);
    const title = await sendToAI(text);
    const safeTitle = sanitizeFilename(title);

    const outPath = join(OUT_DIR, `${safeTitle}.pdf`);
    renameSync(ocrPath, outPath);
    console.log(`Renamed and moved to: ${outPath}`);
  }
}

processPdfs().catch(err => {
  console.error("Error:", err);
});

Renames PDF files to `YYYY-MM-DD - <Sender/Organization name> - <Sensible Title>`.

Also applies auto-rotation and OCR to the file.

Includes a file watcher. Files placed in `in` will be automatically renamed. Your renamed files will be placed in `out`, you can stop the script once it's done or leave it running and place new files in `in`.

I recommend using Groq with openai/gpt-oss-120b. It has rate limits, but the script will automatically wait in order to comply.

# Installation

- Requires:
  - scoop
  - `scoop bucket add extras`
  - `scoop install bun uv poppler tesseract qpdf ghostscript`
  - pdftotext, ocrmypdf

- Navigate to this folder
- Run `bun i`
- Rename `.env.example` to `.env`
- Fill it with your data

# Start

- Run `bun start`
- This creates some folders
- Place documents in `in`


Auto rotation will only be applied if the PDF does *not* already have an OCR layer.

If you want to force auto rotation and OCR, place the file in the `force-processing` folder.
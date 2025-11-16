Renames PDF files to `YYYY-MM-DD - <Sender/Organization name> - <Sensible Title>`.

Includes a file watcher. Files placed in `in` will be automatically renamed. Your renamed files will be placed in `out`, you can stop the script once it's done or leave it running and place new files in `in`.

# Installation

- Requires:
  - scoop
  - `scoop install bun uv poppler tesseract`

- Run `bun i`
- Rename `.env.example` to `.env`
- Fill it with your data

# Start

- Run `bun start`
- This creates some folders
- Place documents in `in`
- Run `bun start`
# Prompt and Fix Log

## 2026-08-05

### User prompt
- "เพิ่ม ไฟล์ ที่บันทึกการ promt และ ผลการแอก้ไขไปด้วย"

### Action taken
- Created `PROMPT_LOG.md` to store the prompt and fix summary.
- Added `.env.example` for environment configuration.
- Added `.gitignore` to exclude `node_modules/`, `.env`, and npm log files.
- Updated `package.json` start scripts to use `server.js`.
- Updated `config/db.js` to support `DATABASE_URL` or individual `PG*` env variables.
- Updated `app/server.js` to start the server only after a successful database connection and provide better database error guidance.

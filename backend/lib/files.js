// Shared upload handling for sales imports (routes/data.js) and stock-count
// files (routes/inventory.js): multer storage plus CSV / JSON / Excel parsing.
const multer = require('multer');
const csvParser = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ─── Multer Configuration ────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'text/csv',
    'application/json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ];
  const allowedExts = ['.csv', '.json', '.xlsx', '.xls'];
  const ext = path.extname(file.originalname).toLowerCase();
  (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext))
    ? cb(null, true)
    : cb(new Error('Only CSV, JSON, and Excel (.xlsx) files are supported'), false);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── File Parsers ────────────────────────────────────────────────────────────

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', (err) => reject(err));
  });
}

function parseJSON(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      resolve(Array.isArray(data) ? data : [data]);
    } catch (err) { reject(err); }
  });
}

function parseExcel(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      resolve(XLSX.utils.sheet_to_json(sheet));
    } catch (err) { reject(err); }
  });
}

async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.csv':  return parseCSV(filePath);
    case '.json': return parseJSON(filePath);
    case '.xlsx':
    case '.xls':  return parseExcel(filePath);
    default: throw new Error(`Unsupported file format: ${ext}`);
  }
}

module.exports = { upload, parseFile, uploadsDir };

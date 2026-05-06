import { readFileSync } from "fs";
import { google } from "googleapis";
import { withRetry } from "./retry.js";

export function normalizeHeader(header) {
  return String(header || "").trim().toLowerCase().replace(/\s+/g, "_");
}

export function columnLetter(index) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export async function getSheetsClient({ credentialsPath }) {
  const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function ensureSheet(sheets, spreadsheetId, title) {
  const meta = await withRetry(`Sheets metadata for ${title}`, () =>
    sheets.spreadsheets.get({ spreadsheetId })
  );
  const exists = meta.data.sheets.some((s) => s.properties.title === title);
  if (!exists) {
    await withRetry(`Create ${title} sheet`, () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      })
    );
  }
}

export async function readSheetTab(sheets, spreadsheetId, range) {
  try {
    return await readSheetTabStrict(sheets, spreadsheetId, range);
  } catch {
    return [];
  }
}

export async function readSheetTabStrict(sheets, spreadsheetId, range) {
  const res = await withRetry(`Read ${range}`, () =>
    sheets.spreadsheets.values.get({ spreadsheetId, range })
  );
  return res.data.values || [];
}

export function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map(normalizeHeader);
  return rows.slice(1).map((row, index) => {
    const obj = { __rowNumber: index + 2 };
    header.forEach((key, i) => {
      obj[key] = (row[i] || "").trim();
    });
    return obj;
  });
}

export async function ensureHeaderRow(sheets, spreadsheetId, sheetName, requiredHeaders) {
  await ensureSheet(sheets, spreadsheetId, sheetName);
  const existingRows = await readSheetTabStrict(sheets, spreadsheetId, `${sheetName}!A1:AZ1`);
  const existing = existingRows[0] || [];
  const existingKeys = new Set(existing.map(normalizeHeader));
  const merged = [...existing];

  for (const header of requiredHeaders) {
    if (!existingKeys.has(normalizeHeader(header))) {
      merged.push(header);
      existingKeys.add(normalizeHeader(header));
    }
  }

  if (!existing.length || merged.length !== existing.length) {
    await withRetry(`Write ${sheetName} header`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [merged] },
      })
    );
  }

  return merged;
}

export async function appendObjectRow(sheets, spreadsheetId, sheetName, requiredHeaders, object) {
  const header = await ensureHeaderRow(sheets, spreadsheetId, sheetName, requiredHeaders);
  const row = header.map((column) => object[normalizeHeader(column)] ?? "");
  const lastCol = columnLetter(header.length - 1);
  await withRetry(`Append ${sheetName} row`, () =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:${lastCol}`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    })
  );
}

export async function readObjects(sheets, spreadsheetId, sheetName, requiredHeaders, maxRows = 1000) {
  const header = await ensureHeaderRow(sheets, spreadsheetId, sheetName, requiredHeaders);
  const lastCol = columnLetter(header.length - 1);
  const rows = await readSheetTab(sheets, spreadsheetId, `${sheetName}!A1:${lastCol}${maxRows}`);
  return { header, rows, objects: rowsToObjects(rows) };
}

export async function updateObjectRow(sheets, spreadsheetId, sheetName, header, rowNumber, object) {
  const values = header.map((column) => object[normalizeHeader(column)] ?? "");
  const lastCol = columnLetter(header.length - 1);
  await withRetry(`Update ${sheetName} row ${rowNumber}`, () =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    })
  );
}

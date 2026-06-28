/**
 * Google Apps Script — Keg Updater (BrewPlanner)
 *
 * The keg inventory is a published, read-only Google Sheet, so the desktop
 * dashboard's keg edits can't write to the CSV directly. This web app provides
 * the write path: BrewPlanner's server POSTs to it (PUT /api/kegs/:number →
 * updateKeg), and it patches the matching row.
 *
 * Setup:
 *   1. Open the Keg Status spreadsheet → Extensions → Apps Script.
 *   2. Paste this file in, save.
 *   3. Deploy → New deployment → Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   4. Copy the deployment URL (…/exec) into KEG_SHEET_WRITE_URL on the server
 *      (see deploy/brewplanner.env.example).
 *
 * Expects a JSON POST body: { number, contents, date, note, abv, recipeId }
 * where `number` (column B) selects the row. `volume` (column F) is intentionally
 * never sent, so it's left untouched. `recipeId` (column H) is the linked Brewer's
 * Friend recipe id (blank unlinks). The reply is always HTTP 200 (Apps Script
 * can't set status codes); success/failure is signalled in the JSON body, and the
 * server keys off `error` / `success`.
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var kegNumber = String(data.number).trim();

    if (!kegNumber) {
      return response({ error: 'Missing keg number' });
    }

    var sheet =
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1') ||
      SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var rows = sheet.getDataRange().getValues();

    // Find the row where column B (index 1) matches the keg number.
    // Data starts at row 3 (index 2) — row 1 is a banner, row 2 is headers.
    var targetRow = -1;
    for (var i = 2; i < rows.length; i++) {
      if (String(rows[i][1]).trim() === kegNumber) {
        targetRow = i + 1; // 1-based row index for the sheet API
        break;
      }
    }

    if (targetRow === -1) {
      return response({ error: 'Keg #' + kegNumber + ' not found' });
    }

    // Update columns C–H (1-based): C = Contents, D = Date, E = Note,
    // F = Volume, G = ABV, H = Recipe id. Only fields present in the body are
    // written.
    if (data.contents !== undefined) sheet.getRange(targetRow, 3).setValue(data.contents);
    if (data.date !== undefined) sheet.getRange(targetRow, 4).setValue(data.date);
    if (data.note !== undefined) sheet.getRange(targetRow, 5).setValue(data.note);
    if (data.volume !== undefined) sheet.getRange(targetRow, 6).setValue(data.volume);
    if (data.abv !== undefined) sheet.getRange(targetRow, 7).setValue(data.abv);
    if (data.recipeId !== undefined) sheet.getRange(targetRow, 8).setValue(data.recipeId);

    SpreadsheetApp.flush();

    return response({ success: true, row: targetRow });
  } catch (err) {
    return response({ error: err.message });
  }
}

function response(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', info: 'Use POST to update kegs.' }),
  ).setMimeType(ContentService.MimeType.JSON);
}

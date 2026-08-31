/*
 * Google Apps Script backend for the donor-poster page.
 *
 * Spreadsheet tabs required:
 *   Settings: A1 = OPENROUTER_API_KEY, B1 = your OpenRouter API key
 *   Donations: created automatically if it does not exist
 */

const SETTINGS_TAB = 'Settings';
const DONATIONS_TAB = 'Donations';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function doPost(event) {
  try {
    const payload = JSON.parse(event.postData && event.postData.contents || '{}');
    const donorName = String(payload.donorName || '').trim();
    const donationDetail = String(payload.donationDetail || '').trim();
    const imagePrompt = String(payload.prompt || '').trim();

    if (!donorName || !donationDetail || !imagePrompt) {
      throw new Error('Missing donor name, donation detail, or prompt.');
    }

    const apiKey = getSetting_('OPENROUTER_API_KEY');
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing from the Settings tab.');

    const instruction = `Write a polite, engaging, and professional Facebook caption in Thai to thank the donor for supporting the school sports day. Donor: "${donorName}". Donation: "${donationDetail}". Include relevant hashtags. Return a raw JSON object with exactly one key: "facebook_caption". Do not include Markdown formatting in the JSON output.`;
    const openRouterResponse = UrlFetchApp.fetch(OPENROUTER_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: instruction }],
        response_format: { type: 'json_object' }
      }),
      muteHttpExceptions: true
    });

    const openRouterData = JSON.parse(openRouterResponse.getContentText());
    if (openRouterResponse.getResponseCode() >= 300) {
      throw new Error(openRouterData.error && openRouterData.error.message || 'OpenRouter request failed.');
    }

    const generated = JSON.parse(openRouterData.choices[0].message.content.replace(/```json|```/g, '').trim());
    const caption = generated.facebook_caption;
    appendDonation_([new Date(), donorName, donationDetail, imagePrompt, caption, payload.hasPortrait ? 'Yes' : 'No']);

    return json_({ success: true, facebook_caption: caption });
  } catch (error) {
    console.error(error);
    return json_({ success: false, error: error.message || String(error) });
  }
}

function getSetting_(key) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_TAB);
  if (!sheet) throw new Error(`Missing required tab: ${SETTINGS_TAB}`);
  const values = sheet.getDataRange().getDisplayValues();
  const row = values.find(([setting]) => setting === key);
  return row ? row[1] : '';
}

function appendDonation_(row) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(DONATIONS_TAB);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(DONATIONS_TAB);
    sheet.appendRow(['Timestamp', 'Donor name', 'Donation', 'Image prompt', 'Facebook caption', 'Portrait supplied']);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow(row);
}

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/*
 * Google Apps Script backend for the donor-poster page.
 *
 * Spreadsheet tabs required:
 *   Settings: A1 = OPENROUTER_API_KEY, B1 = your OpenRouter API key
 *   Donations: created automatically if it does not exist
 */

const SETTINGS_TAB = 'Settings';
const DONATIONS_TAB = 'Donations';
const DONATION_IMAGES_FOLDER = 'Donation Images';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function doGet(event) {
  const callback = String(event.parameter && event.parameter.callback || '');
  try {
    return jsonp_(callback, processRequest_(event.parameter || {}));
  } catch (error) {
    console.error(error);
    return jsonp_(callback, { success: false, error: error.message || String(error) });
  }
}

function doPost(event) {
  try {
    const payload = event.parameter && event.parameter.action === 'uploadImage'
      ? event.parameter
      : JSON.parse(event.postData && event.postData.contents || '{}');
    if (payload.action === 'uploadImage') return uploadImageResponse_(payload);
    return json_(processRequest_(payload));
  } catch (error) {
    console.error(error);
    return json_({ success: false, error: error.message || String(error) });
  }
}

// Run this once from the Apps Script editor to approve Drive access and
// create the folder used for uploaded donor images.
function authorizeDrive() {
  return getDonationImagesFolder_().getUrl();
}

function processRequest_(payload) {
    if (payload.action === 'health') {
      return { success: true, service: 'donor-caption' };
    }

    const donorName = String(payload.donorName || '').trim();
    const donationDetail = String(payload.donationDetail || '').trim();
    const imagePrompt = String(payload.prompt || 'Generated locally from prompt_template.txt').trim();

    if (!donorName || !donationDetail || !imagePrompt) {
      throw new Error('Missing donor name, donation detail, or prompt.');
    }

    const apiKey = getSetting_('OPENROUTER_API_KEY');
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing from the Settings tab.');

    const instruction = `Create a Thai Facebook appreciation caption in the following warm, formal school-post style. Return a raw JSON object with exactly one key: "facebook_caption". Do not include Markdown formatting outside the JSON.

Use these exact values:
- Donor name: "${donorName}"
- Donation amount/detail: "${donationDetail}"
- School: โรงเรียนบ้านโพนแท่น
- Event: สนับสนุนกีฬาสีภายใน “โพนแท่นเกมส์ ครั้งที่ 31” ประจำปีการศึกษา 2569
- Bank: เลขบัญชี ธนาคารออมสิน 020172956318
- Account: โรงเรียนบ้านโพนแท่น (เงินรายได้สถานศึกษา)
- Tax message: การบริจาคเพื่อการศึกษาลดหย่อนภาษีได้ 2 เท่า

Follow this structure closely, using tasteful emojis and line breaks:
1. Announce the school and a thank-you heading.
2. Thank the donor by name.
3. State the event and donation amount/detail.
4. Include the exact bank and account information.
5. Include the exact tax-deduction message.
6. Add a short paragraph saying every contribution encourages students to compete fully and make good memories.
7. Close with a sincere blessing for the donor and family: happiness, prosperity, good health, and lasting wellbeing.
8. End with relevant Thai hashtags, including #กีฬาสีภายใน #โพนแท่นเกมส์ #การบริจาคเพื่อสถานศึกษาสามารถลดหย่อนภาษีได้2เท่า #ผู้ให้การสนับสนุน #ผู้ใหญ่ใจดี.

Use correct Thai spelling. Do not invent facts, omit any fixed information, or add unrelated hashtags.`;
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
    appendDonation_([
      new Date(), donorName, donationDetail, imagePrompt, caption,
      payload.hasPortrait ? 'Yes' : 'No', String(payload.imageUrl || '')
    ]);

    return { success: true, facebook_caption: caption };
}

function uploadImageResponse_(payload) {
  const nonce = String(payload.nonce || '');
  const origin = String(payload.origin || '');
  let result;
  try {
    if (!nonce || !origin) throw new Error('Missing upload nonce or origin.');
    const imageData = String(payload.imageBase64 || '');
    if (!imageData) throw new Error('Missing image data.');

    const fileName = sanitizeFileName_(payload.imageName || 'donation-image.jpg');
    const blob = Utilities.newBlob(
      Utilities.base64Decode(imageData),
      String(payload.imageMimeType || 'image/jpeg'),
      fileName
    );
    const file = getDonationImagesFolder_().createFile(blob);
    result = { success: true, imageUrl: file.getUrl(), imageId: file.getId() };
  } catch (error) {
    console.error(error);
    result = { success: false, error: error.message || String(error) };
  }

  const message = JSON.stringify({ type: 'donation-image-upload', nonce, result })
    .replace(/</g, '\\u003c');
  const targetOrigin = JSON.stringify(origin).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput(
    `<script>window.top.postMessage(${message}, ${targetOrigin});</script>`
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
    sheet.appendRow(['Timestamp', 'Donor name', 'Donation', 'Image prompt', 'Facebook caption', 'Portrait supplied', 'Image URL']);
    sheet.setFrozenRows(1);
  } else if (!sheet.getRange(1, 7).getDisplayValue()) {
    sheet.getRange(1, 7).setValue('Image URL');
  }
  sheet.appendRow(row);
}

function getDonationImagesFolder_() {
  const folders = DriveApp.getFoldersByName(DONATION_IMAGES_FOLDER);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DONATION_IMAGES_FOLDER);
}

function sanitizeFileName_(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'donation-image.jpg';
}

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonp_(callback, data) {
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return json_({ success: false, error: 'Invalid callback.' });
  }
  return ContentService
    .createTextOutput(`${callback}(${JSON.stringify(data)});`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

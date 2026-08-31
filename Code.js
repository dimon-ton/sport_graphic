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
    return json_(processRequest_(JSON.parse(event.postData && event.postData.contents || '{}')));
  } catch (error) {
    console.error(error);
    return json_({ success: false, error: error.message || String(error) });
  }
}

function processRequest_(payload) {
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
    appendDonation_([new Date(), donorName, donationDetail, imagePrompt, caption, payload.hasPortrait ? 'Yes' : 'No']);

    return { success: true, facebook_caption: caption };
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

function jsonp_(callback, data) {
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) {
    return json_({ success: false, error: 'Invalid callback.' });
  }
  return ContentService
    .createTextOutput(`${callback}(${JSON.stringify(data)});`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

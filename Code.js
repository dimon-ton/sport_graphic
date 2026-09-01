/* Google Apps Script backend for the donation content manager.
 * Script Properties: ADMIN_ACCESS_KEY, FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN and
 * optional FACEBOOK_GRAPH_API_VERSION (defaults to v26.0).
 */
const DONATIONS_TAB = 'Donations';
const DONOR_IMAGES_FOLDER = 'Donation Donor Images';
const GENERATED_IMAGES_FOLDER = 'Donation Generated Images';
const DEFAULT_GRAPH_API_VERSION = 'v26.0';
const DONATION_HEADERS = [
  'id', 'createdAt', 'updatedAt', 'donorName', 'donationType', 'donationDetail',
  'donorImageUrl', 'donorImageId', 'generatedImageUrl', 'generatedImageId',
  'generatedPrompt', 'caption', 'facebookPostId', 'facebookPostUrl',
  'facebookPublishedAt', 'publishingStatus', 'notes', 'requestId'
];

function doGet(event) {
  const parameters = event && event.parameter || {};
  try {
    return jsonp_(String(parameters.callback || ''), route_(parameters));
  } catch (error) {
    console.error(error);
    return jsonp_(String(parameters.callback || ''), errorResult_(error));
  }
}

function doPost(event) {
  const parameters = event && event.parameter || {};
  try {
    const payload = event.postData && event.postData.type === 'application/json'
      ? JSON.parse(event.postData.contents || '{}') : parameters;
    const result = route_(payload);
    return payload.nonce && payload.origin ? postMessageResponse_(payload, result) : json_(result);
  } catch (error) {
    console.error(error);
    const result = errorResult_(error);
    return parameters.nonce && parameters.origin
      ? postMessageResponse_(parameters, result) : json_(result);
  }
}

function route_(payload) {
  const action = String(payload.action || 'health');
  if (action === 'health') return { success: true, service: 'donation-content-manager' };
  verifyAccess_(payload.accessKey);
  if (action === 'listDonations') return { success: true, donations: listDonations_(payload) };
  if (action === 'getDonation') return { success: true, donation: getDonationById_(payload.id) };
  if (action === 'createDonation') return createDonation_(payload);
  if (action === 'updateDonation') return updateDonation_(payload);
  if (action === 'deleteDonation') return deleteDonation_(payload.id);
  if (action === 'uploadImage') return uploadImage_(payload);
  if (action === 'publishFacebook') return publishFacebook_(payload);
  throw new Error('Unknown action.');
}

function verifyAccess_(suppliedValue) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_ACCESS_KEY');
  const supplied = String(suppliedValue || '');
  if (!expected) throw new Error('ADMIN_ACCESS_KEY is not configured in Script Properties.');
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < Math.max(expected.length, supplied.length); index += 1) {
    difference |= (expected.charCodeAt(index) || 0) ^ (supplied.charCodeAt(index) || 0);
  }
  if (difference !== 0) throw new Error('Access denied. Check the admin access key.');
}

function createDonation_(payload) {
  const normalized = validateDonation_(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getDonationsSheet_();
    const duplicate = readDonationRows_(sheet).find(function (record) {
      return record.id === normalized.id ||
        (normalized.requestId && record.requestId === normalized.requestId);
    });
    if (duplicate) return { success: true, donation: duplicate, duplicate: true };
    const now = new Date().toISOString();
    const donation = Object.assign(emptyDonation_(), normalized, {
      createdAt: now, updatedAt: now, publishingStatus: 'draft'
    });
    sheet.appendRow(DONATION_HEADERS.map(function (header) { return donation[header] || ''; }));
    return { success: true, donation: donation };
  } finally {
    lock.releaseLock();
  }
}

function updateDonation_(payload) {
  const id = requiredString_(payload.id, 'id');
  return mutateDonation_(id, function (donation) {
    ['donorName', 'donationDetail', 'generatedPrompt', 'caption', 'notes'].forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) {
        const value = String(payload[field] == null ? '' : payload[field]);
        if (field !== 'caption' && field !== 'notes' && !value.trim()) {
          throw new Error('Missing required field: ' + field);
        }
        donation[field] = value;
      }
    });
    if (Object.prototype.hasOwnProperty.call(payload, 'donationType')) {
      const donationType = String(payload.donationType || '');
      if (donationType !== 'money' && donationType !== 'in-kind') throw new Error('Invalid donation type.');
      donation.donationType = donationType;
    }
    if (donation.generatedImageId && donation.caption && donation.publishingStatus !== 'published') {
      donation.publishingStatus = 'ready';
    }
    return donation;
  });
}

function uploadImage_(payload) {
  const donationId = requiredString_(payload.donationId, 'donationId');
  const imageKind = String(payload.imageKind || 'donor');
  if (imageKind !== 'donor' && imageKind !== 'generated') throw new Error('Invalid image kind.');
  const imageData = requiredString_(payload.imageBase64, 'imageBase64');
  const mimeType = String(payload.imageMimeType || 'image/jpeg');
  if (!/^image\/(jpeg|png|webp|gif)$/i.test(mimeType)) throw new Error('Unsupported image type.');
  const decodedImage = Utilities.base64Decode(imageData);
  if (decodedImage.length > 10 * 1024 * 1024) throw new Error('Image is too large. Maximum size is 10 MB.');
  const file = getImageFolder_(imageKind).createFile(Utilities.newBlob(
    decodedImage, mimeType,
    sanitizeFileName_(payload.imageName || imageKind + '-image.jpg')
  ));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const imageUrl = driveImageUrl_(file.getId());
  if (imageKind === 'donor' && String(payload.createPending || '') === 'true') {
    return { success: true, imageUrl: imageUrl, imageId: file.getId() };
  }
  try {
    const result = mutateDonation_(donationId, function (donation) {
      if (imageKind === 'generated') {
        donation.generatedImageId = file.getId();
        donation.generatedImageUrl = imageUrl;
        donation.publishingStatus = donation.caption ? 'ready' : 'draft';
      } else {
        donation.donorImageId = file.getId();
        donation.donorImageUrl = imageUrl;
      }
      return donation;
    });
    result.imageUrl = imageUrl;
    result.imageId = file.getId();
    return result;
  } catch (error) {
    file.setTrashed(true);
    throw error;
  }
}

function publishFacebook_(payload) {
  const id = requiredString_(payload.id, 'id');
  const existing = getDonationById_(id);
  if (existing.facebookPostId || existing.publishingStatus === 'published') {
    return { success: true, donation: existing, duplicate: true };
  }
  const claimed = mutateDonation_(id, function (donation) {
    if (donation.facebookPostId || donation.publishingStatus === 'published') {
      throw new Error('This donation has already been published.');
    }
    if (donation.publishingStatus === 'publishing') throw new Error('This donation is already being published.');
    if (!donation.generatedImageId) throw new Error('A generated image is required before publishing.');
    if (!String(donation.caption || '').trim()) throw new Error('A caption is required before publishing.');
    donation.publishingStatus = 'publishing';
    return donation;
  }).donation;
  try {
    const result = publishPhotoToFacebook_(claimed);
    const postId = String(result.post_id || result.id || '');
    return setDonationFields_(id, {
      facebookPostId: postId,
      facebookPostUrl: result.post_id
        ? 'https://www.facebook.com/' + encodeURIComponent(result.post_id)
        : 'https://www.facebook.com/photo/?fbid=' + encodeURIComponent(result.id || ''),
      facebookPublishedAt: new Date().toISOString(), publishingStatus: 'published'
    });
  } catch (error) {
    setDonationFields_(id, { publishingStatus: 'publish_failed' });
    throw error;
  }
}

// Isolated Facebook service. Page Photos accepts an image source and message.
function publishPhotoToFacebook_(donation) {
  const properties = PropertiesService.getScriptProperties();
  const pageId = properties.getProperty('FACEBOOK_PAGE_ID');
  const accessToken = properties.getProperty('FACEBOOK_PAGE_ACCESS_TOKEN');
  const version = properties.getProperty('FACEBOOK_GRAPH_API_VERSION') || DEFAULT_GRAPH_API_VERSION;
  if (!pageId || !accessToken) throw new Error('Facebook Page configuration is incomplete.');
  const response = UrlFetchApp.fetch(
    'https://graph.facebook.com/' + encodeURIComponent(version) + '/' + encodeURIComponent(pageId) + '/photos',
    {
      method: 'post',
      payload: {
        source: DriveApp.getFileById(donation.generatedImageId).getBlob(),
        message: donation.caption, published: 'true', access_token: accessToken
      },
      muteHttpExceptions: true
    }
  );
  const body = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() >= 300 || body.error) {
    throw new Error(body.error && body.error.message || 'Facebook publishing failed.');
  }
  if (!body.id && !body.post_id) throw new Error('Facebook returned no photo or post ID.');
  return body;
}

function listDonations_(payload) {
  const search = String(payload.search || '').trim().toLocaleLowerCase();
  const type = String(payload.donationType || '');
  const status = String(payload.publishingStatus || '');
  const limit = Math.min(Math.max(Number(payload.limit) || 100, 1), 300);
  return readDonationRows_(getDonationsSheet_()).filter(function (record) {
    const haystack = [record.donorName, record.donationDetail, record.id].join(' ').toLocaleLowerCase();
    return (!search || haystack.indexOf(search) !== -1) &&
      (!type || record.donationType === type) && (!status || record.publishingStatus === status);
  }).sort(function (a, b) {
    return String(b.createdAt).localeCompare(String(a.createdAt));
  }).slice(0, limit);
}

function getDonationById_(id) {
  const value = requiredString_(id, 'id');
  const donation = readDonationRows_(getDonationsSheet_()).find(function (record) {
    return record.id === value;
  });
  if (!donation) throw new Error('Donation record not found.');
  return donation;
}

function deleteDonation_(id) {
  const value = requiredString_(id, 'id');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getDonationsSheet_();
    const values = sheet.getDataRange().getDisplayValues();
    const rowIndex = values.findIndex(function (row, index) {
      return index > 0 && row[0] === value;
    });
    if (rowIndex < 1) throw new Error('Donation record not found.');
    sheet.deleteRow(rowIndex + 1);
    return { success: true, deletedId: value };
  } finally {
    lock.releaseLock();
  }
}

function mutateDonation_(id, callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getDonationsSheet_();
    const values = sheet.getDataRange().getDisplayValues();
    const rowIndex = values.findIndex(function (row, index) { return index > 0 && row[0] === id; });
    if (rowIndex < 1) throw new Error('Donation record not found.');
    const updated = callback(rowToDonation_(values[rowIndex]));
    updated.updatedAt = new Date().toISOString();
    sheet.getRange(rowIndex + 1, 1, 1, DONATION_HEADERS.length)
      .setValues([DONATION_HEADERS.map(function (header) { return updated[header] || ''; })]);
    return { success: true, donation: updated };
  } finally {
    lock.releaseLock();
  }
}

function setDonationFields_(id, fields) {
  return mutateDonation_(id, function (donation) {
    Object.keys(fields).forEach(function (key) { donation[key] = fields[key]; });
    return donation;
  });
}

function validateDonation_(payload) {
  const donationType = requiredString_(payload.donationType, 'donationType');
  if (donationType !== 'money' && donationType !== 'in-kind') throw new Error('Invalid donation type.');
  const result = {
    id: requiredString_(payload.id, 'id'),
    donorName: requiredLiteral_(payload.donorName, 'donorName'), donationType: donationType,
    donationDetail: requiredLiteral_(payload.donationDetail, 'donationDetail'),
    donorImageUrl: String(payload.donorImageUrl || ''), donorImageId: String(payload.donorImageId || ''),
    generatedPrompt: requiredLiteral_(payload.generatedPrompt, 'generatedPrompt'),
    caption: requiredLiteral_(payload.caption, 'caption'), notes: String(payload.notes || ''),
    requestId: String(payload.requestId || '')
  };
  if (result.id.length > 100 || result.requestId.length > 100) throw new Error('Identifier is too long.');
  return result;
}

function getDonationsSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(DONATIONS_TAB);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(DONATIONS_TAB);
    sheet.getRange(1, 1, 1, DONATION_HEADERS.length).setValues([DONATION_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const firstRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  if (firstRow[0] !== 'id') migrateLegacySheet_(sheet, firstRow);
  if (sheet.getLastColumn() < DONATION_HEADERS.length) {
    sheet.getRange(1, 1, 1, DONATION_HEADERS.length).setValues([DONATION_HEADERS]);
  }
  return sheet;
}

function migrateLegacySheet_(sheet, firstRow) {
  const rows = sheet.getDataRange().getDisplayValues().slice(1);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, DONATION_HEADERS.length).setValues([DONATION_HEADERS]);
  if (!rows.length || firstRow[0] !== 'Timestamp') return;
  const migrated = rows.filter(function (row) { return row.some(String); }).map(function (row) {
    let createdAt;
    try { createdAt = row[0] ? new Date(row[0]).toISOString() : new Date().toISOString(); }
    catch (error) { createdAt = new Date().toISOString(); }
    const legacy = {
      id: Utilities.getUuid(), createdAt: createdAt, updatedAt: createdAt,
      donorName: row[1], donationType: 'money', donationDetail: row[2],
      donorImageUrl: row[6], generatedPrompt: row[3], caption: row[4],
      publishingStatus: 'draft', notes: 'Migrated from legacy sheet'
    };
    return DONATION_HEADERS.map(function (header) { return legacy[header] || ''; });
  });
  if (migrated.length) sheet.getRange(2, 1, migrated.length, DONATION_HEADERS.length).setValues(migrated);
}

function readDonationRows_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, DONATION_HEADERS.length)
    .getDisplayValues().filter(function (row) { return row[0]; }).map(rowToDonation_);
}

function rowToDonation_(row) {
  const donation = {};
  DONATION_HEADERS.forEach(function (header, index) { donation[header] = row[index] || ''; });
  return donation;
}

function emptyDonation_() {
  const donation = {};
  DONATION_HEADERS.forEach(function (header) { donation[header] = ''; });
  return donation;
}

function getImageFolder_(kind) {
  const name = kind === 'generated' ? GENERATED_IMAGES_FOLDER : DONOR_IMAGES_FOLDER;
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function driveImageUrl_(id) {
  return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1600';
}

function requiredString_(value, field) {
  const result = String(value || '').trim();
  if (!result) throw new Error('Missing required field: ' + field);
  return result;
}

// Literal display values are validated but never normalized.
function requiredLiteral_(value, field) {
  const result = String(value == null ? '' : value);
  if (!result.trim()) throw new Error('Missing required field: ' + field);
  return result;
}

function sanitizeFileName_(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'donation-image.jpg';
}

function postMessageResponse_(payload, result) {
  const message = JSON.stringify({ type: 'donation-api-response', nonce: String(payload.nonce), result: result })
    .replace(/</g, '\\u003c');
  const targetOrigin = JSON.stringify(String(payload.origin)).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput(
    '<script>window.top.postMessage(' + message + ', ' + targetOrigin + ');</script>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function errorResult_(error) { return { success: false, error: error && error.message || String(error) }; }
function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function jsonp_(callback, data) {
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) return json_({ success: false, error: 'Invalid callback.' });
  return ContentService.createTextOutput(callback + '(' + JSON.stringify(data) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// Run once in the editor to create the folders and approve Drive access.
function authorizeDrive() {
  return [getImageFolder_('donor').getUrl(), getImageFolder_('generated').getUrl()];
}

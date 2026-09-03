/* Google Apps Script backend for the donation content manager.
 * Script Properties: ADMIN_ACCESS_KEY, KIE_API_KEY, FACEBOOK_PAGE_ID,
 * FACEBOOK_PAGE_ACCESS_TOKEN and optional provider settings documented in
 * CONFIGURATION.md.
 */
const DONATIONS_TAB = 'Donations';
const DONOR_IMAGES_FOLDER = 'Donation Donor Images';
const GENERATED_IMAGES_FOLDER = 'Donation Generated Images';
const DEFAULT_GRAPH_API_VERSION = 'v26.0';
const KIE_API_BASE_URL = 'https://api.kie.ai/api/v1';
const DEFAULT_KIE_MODEL = 'gpt-image-2-image-to-image';
const DEFAULT_SCHOOL_LOGO_URL = 'https://raw.githubusercontent.com/dimon-ton/sport_graphic/main/school_logo.png';
const DONATION_HEADERS = [
  'id', 'createdAt', 'updatedAt', 'donorName', 'donationType', 'donationDetail',
  'donorImageUrl', 'donorImageId', 'generatedImageUrl', 'generatedImageId',
  'generatedPrompt', 'caption', 'facebookPostId', 'facebookPostUrl',
  'facebookPublishedAt', 'publishingStatus', 'notes', 'requestId',
  'kieTaskId', 'kieTaskState', 'kieTaskProgress', 'kieTaskError', 'kieTaskUpdatedAt',
  'kieOutputCropped', 'kieSourceImageUrl'
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
  if (action === 'startKieGeneration') return startKieGeneration_(payload);
  if (action === 'checkKieGeneration') return checkKieGeneration_(payload);
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
    const contentChanged = ['donorName', 'donationDetail', 'donationType'].some(function (field) {
      return Object.prototype.hasOwnProperty.call(payload, field) && String(payload[field] == null ? '' : payload[field]) !== String(donation[field] || '');
    });
    if (contentChanged && donation.publishingStatus === 'publishing') {
      throw new Error('Donation data cannot be edited while Facebook publishing is in progress.');
    }
    if (contentChanged && (!Object.prototype.hasOwnProperty.call(payload, 'generatedPrompt') || !Object.prototype.hasOwnProperty.call(payload, 'caption') || !String(payload.generatedPrompt || '').trim() || !String(payload.caption || '').trim())) {
      throw new Error('Updated prompt and caption are required when donation data changes.');
    }
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
    if (contentChanged && donation.publishingStatus !== 'published') {
      donation.generatedImageId = '';
      donation.generatedImageUrl = '';
      clearKieTask_(donation);
      donation.publishingStatus = 'draft';
    } else if (donation.publishingStatus !== 'published' && donation.publishingStatus !== 'publishing') {
      donation.publishingStatus = donation.generatedImageId && String(donation.caption || '').trim() ? 'ready' : 'draft';
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
        if (String(payload.kieCrop || '') === 'true' && donation.kieTaskState === 'success') {
          donation.kieOutputCropped = 'true';
        } else {
          clearKieTask_(donation);
        }
        donation.publishingStatus = donation.caption ? 'ready' : 'draft';
      } else {
        donation.donorImageId = file.getId();
        donation.donorImageUrl = imageUrl;
        if (Object.prototype.hasOwnProperty.call(payload, 'generatedPrompt')) {
          donation.generatedPrompt = requiredLiteral_(payload.generatedPrompt, 'generatedPrompt');
        }
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

function startKieGeneration_(payload) {
  const donationId = requiredString_(payload.id, 'id');
  const donation = getDonationById_(donationId);
  if (donation.facebookPostId || donation.publishingStatus === 'published') {
    throw new Error('Cannot replace a poster after it has been published.');
  }
  if (isActiveKieState_(donation.kieTaskState) && donation.kieTaskId) {
    return { success: true, donation: donation, taskId: donation.kieTaskId, duplicate: true };
  }

  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('KIE_API_KEY');
  if (!apiKey) throw new Error('KIE_API_KEY is not configured in Script Properties.');
  const logoUrl = properties.getProperty('KIE_SCHOOL_LOGO_URL') || DEFAULT_SCHOOL_LOGO_URL;
  if (!/^https:\/\//i.test(logoUrl)) {
    throw new Error('The school logo must have a public HTTPS URL.');
  }
  const imageInputs = [logoUrl];
  if (donation.donorImageUrl) imageInputs.push(donation.donorImageUrl);
  const generationPrompt = Object.prototype.hasOwnProperty.call(payload, 'generatedPrompt')
    ? requiredLiteral_(payload.generatedPrompt, 'generatedPrompt')
    : requiredLiteral_(donation.generatedPrompt, 'generatedPrompt');
  const requestBody = {
    model: properties.getProperty('KIE_IMAGE_MODEL') || DEFAULT_KIE_MODEL,
    input: {
      prompt: generationPrompt,
      input_urls: imageInputs,
      aspect_ratio: properties.getProperty('KIE_IMAGE_ASPECT_RATIO') || '3:4',
      resolution: properties.getProperty('KIE_IMAGE_RESOLUTION') || '2K'
    }
  };
  const response = kieRequest_('/jobs/createTask', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(requestBody)
  });
  const taskId = response.data && response.data.taskId;
  if (!taskId) throw new Error('Kie AI returned no task ID.');
  return mutateDonation_(donationId, function (record) {
    record.kieTaskId = String(taskId);
    record.kieTaskState = 'waiting';
    record.kieTaskProgress = '0';
    record.kieTaskError = '';
    record.kieTaskUpdatedAt = new Date().toISOString();
    record.kieOutputCropped = '';
    record.kieSourceImageUrl = '';
    record.generatedPrompt = generationPrompt;
    return record;
  });
}

function checkKieGeneration_(payload) {
  const donationId = requiredString_(payload.id, 'id');
  const donation = getDonationById_(donationId);
  const taskId = requiredString_(donation.kieTaskId, 'kieTaskId');
  if (donation.kieTaskState === 'success' && donation.generatedImageId) {
    if (donation.kieSourceImageUrl) {
      return { success: true, donation: donation, complete: true };
    }
    const completedResponse = kieRequest_('/jobs/recordInfo?taskId=' + encodeURIComponent(taskId), { method: 'get' });
    const completedTask = completedResponse.data || {};
    const completedResult = parseKieResult_(completedTask.resultJson);
    const completedResultUrl = completedResult.resultUrls && completedResult.resultUrls[0];
    if (!completedResultUrl) throw new Error('Kie AI completed without an image URL.');
    const recovered = mutateDonation_(donationId, function (record) {
      ensureCurrentKieTask_(record, taskId);
      record.kieSourceImageUrl = completedResultUrl;
      return record;
    });
    recovered.complete = true;
    return recovered;
  }
  const response = kieRequest_('/jobs/recordInfo?taskId=' + encodeURIComponent(taskId), { method: 'get' });
  const task = response.data || {};
  const state = String(task.state || 'waiting').toLowerCase();
  if (state === 'fail') {
    return mutateDonation_(donationId, function (record) {
      ensureCurrentKieTask_(record, taskId);
      record.kieTaskState = 'fail';
      record.kieTaskProgress = String(task.progress || '');
      record.kieTaskError = String(task.failMsg || task.failCode || 'Kie AI image generation failed.');
      record.kieTaskUpdatedAt = new Date().toISOString();
      record.kieOutputCropped = '';
      return record;
    });
  }
  if (state !== 'success') {
    return mutateDonation_(donationId, function (record) {
      ensureCurrentKieTask_(record, taskId);
      record.kieTaskState = isActiveKieState_(state) ? state : 'waiting';
      record.kieTaskProgress = String(task.progress || '');
      record.kieTaskError = '';
      record.kieTaskUpdatedAt = new Date().toISOString();
      record.kieOutputCropped = '';
      return record;
    });
  }

  const result = parseKieResult_(task.resultJson);
  const resultUrl = result.resultUrls && result.resultUrls[0];
  if (!resultUrl) throw new Error('Kie AI completed without an image URL.');
  const imageResponse = UrlFetchApp.fetch(resultUrl, { muteHttpExceptions: true });
  if (imageResponse.getResponseCode() >= 300) throw new Error('Could not download the generated Kie AI image.');
  const blob = imageResponse.getBlob();
  const contentType = String(blob.getContentType() || '').toLowerCase();
  if (contentType.indexOf('image/') !== 0) throw new Error('Kie AI returned a non-image result.');
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  blob.setName('kie-source-' + sanitizeFileName_(donationId) + '.' + extension);
  if (blob.getBytes().length > 20 * 1024 * 1024) throw new Error('The generated Kie AI image is larger than 20 MB.');
  const file = getImageFolder_('generated').createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  try {
    const resultRecord = mutateDonation_(donationId, function (record) {
      ensureCurrentKieTask_(record, taskId);
      record.generatedImageId = file.getId();
      record.generatedImageUrl = driveImageUrl_(file.getId());
      record.kieTaskState = 'success';
      record.kieTaskProgress = '100';
      record.kieTaskError = '';
      record.kieTaskUpdatedAt = new Date().toISOString();
      record.kieOutputCropped = '';
      record.kieSourceImageUrl = resultUrl;
      record.publishingStatus = 'draft';
      return record;
    });
    resultRecord.complete = true;
    return resultRecord;
  } catch (error) {
    file.setTrashed(true);
    throw error;
  }
}

function kieRequest_(path, options) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('KIE_API_KEY');
  if (!apiKey) throw new Error('KIE_API_KEY is not configured in Script Properties.');
  const requestOptions = Object.assign({}, options || {}, {
    headers: { Authorization: 'Bearer ' + apiKey }, muteHttpExceptions: true
  });
  const response = UrlFetchApp.fetch(KIE_API_BASE_URL + path, requestOptions);
  let body;
  try { body = JSON.parse(response.getContentText() || '{}'); }
  catch (error) { throw new Error('Kie AI returned an invalid response.'); }
  if (response.getResponseCode() >= 300 || Number(body.code) !== 200) {
    throw new Error(String(body.msg || body.message || 'Kie AI request failed.'));
  }
  return body;
}

function parseKieResult_(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); }
  catch (error) { throw new Error('Kie AI returned invalid image result data.'); }
}

function isActiveKieState_(state) {
  return ['waiting', 'queuing', 'generating'].indexOf(String(state || '').toLowerCase()) !== -1;
}

function ensureCurrentKieTask_(donation, taskId) {
  if (String(donation.kieTaskId || '') !== String(taskId)) {
    throw new Error('A newer Kie AI generation task has replaced this task.');
  }
}

function clearKieTask_(donation) {
  donation.kieTaskId = '';
  donation.kieTaskState = '';
  donation.kieTaskProgress = '';
  donation.kieTaskError = '';
  donation.kieTaskUpdatedAt = '';
  donation.kieOutputCropped = '';
  donation.kieSourceImageUrl = '';
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
    if (isActiveKieState_(donation.kieTaskState)) throw new Error('Kie AI is still generating this poster.');
    if (!donation.generatedImageId) throw new Error('A generated image is required before publishing.');
    if (!String(donation.caption || '').trim()) throw new Error('A caption is required before publishing.');
    donation.publishingStatus = 'publishing';
    return donation;
  }).donation;
  try {
    const result = publishPhotoToFacebook_(claimed, payload.facebookPageAccessToken);
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
function publishPhotoToFacebook_(donation, suppliedAccessToken) {
  const properties = PropertiesService.getScriptProperties();
  const accessToken = String(suppliedAccessToken || '').trim() || properties.getProperty('FACEBOOK_PAGE_ACCESS_TOKEN');
  const version = properties.getProperty('FACEBOOK_GRAPH_API_VERSION') || DEFAULT_GRAPH_API_VERSION;
  if (!accessToken) throw new Error('Facebook Page Access Token is not configured.');
  const identityResponse = UrlFetchApp.fetch(
    'https://graph.facebook.com/' + encodeURIComponent(version) + '/me?fields=id',
    { headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true }
  );
  const identity = parseFacebookResponse_(identityResponse);
  if (identityResponse.getResponseCode() >= 300 || identity.error || !identity.id) {
    throw new Error(facebookErrorMessage_(identity, 'Could not identify the Facebook Page from the access token.'));
  }
  const pageId = String(identity.id);
  const response = UrlFetchApp.fetch(
    'https://graph.facebook.com/' + encodeURIComponent(version) + '/' + encodeURIComponent(pageId) + '/photos',
    {
      method: 'post',
      headers: { Authorization: 'Bearer ' + accessToken },
      payload: {
        source: DriveApp.getFileById(donation.generatedImageId).getBlob(),
        message: donation.caption, published: 'true'
      },
      muteHttpExceptions: true
    }
  );
  const body = parseFacebookResponse_(response);
  if (response.getResponseCode() >= 300 || body.error) {
    throw new Error(facebookErrorMessage_(body, 'Facebook publishing failed.'));
  }
  if (!body.id && !body.post_id) throw new Error('Facebook returned no photo or post ID.');
  return body;
}

function parseFacebookResponse_(response) {
  try { return JSON.parse(response.getContentText() || '{}'); }
  catch (error) { throw new Error('Facebook returned an invalid response.'); }
}

function facebookErrorMessage_(body, fallback) {
  const error = body && body.error || {};
  const details = [];
  if (error.code != null) details.push('code ' + error.code);
  if (error.error_subcode != null) details.push('subcode ' + error.error_subcode);
  return String(error.message || fallback) + (details.length ? ' (Facebook ' + details.join(', ') + ')' : '');
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

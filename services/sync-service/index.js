const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');

const storage = new Storage();
const bucketName = process.env.GCS_BUCKET_NAME || 'default-sync-bucket';

/**
 * Cloud Function to be triggered via HTTP.
 * Receives a fileId, fetches the file from Google Drive, and uploads it to GCS.
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.syncService = async (req, res) => {
  try {
    // 1. Webhook receiver logic
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed. Expected POST.');
    }
    
    // Expecting fileId in the body (JSON) or query string
    const fileId = req.body.fileId || req.query.fileId;
    if (!fileId) {
      return res.status(400).send('Bad Request: Missing "fileId" parameter.');
    }

    console.log(`Received webhook trigger for Drive fileId: ${fileId}`);

    // 2. Drive fetch logic (using Application Default Credentials)
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    const drive = google.drive({ version: 'v3', auth });

    // Fetch metadata to get original filename and mime type
    console.log(`Fetching metadata for fileId: ${fileId}`);
    let metadata;
    try {
      metadata = await drive.files.get({
        fileId: fileId,
        fields: 'name, mimeType'
      });
    } catch (err) {
      if (err.code === 404 || err.status === 404) {
        console.log(`File ${fileId} not found in Drive (404). It may have been deleted.`);
        return res.status(200).json({ message: 'File not found, skipping sync', fileId });
      }
      throw err;
    }
    
    const fileName = metadata.data.name;
    let mimeType = metadata.data.mimeType;
    if (fileName.toLowerCase().endsWith('.html')) {
      mimeType = 'text/html';
    }

    // Fetch the actual file contents as a stream
    console.log(`Fetching content for ${fileName}`);
    const driveResponse = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    // 3. GCS upload logic
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);
    
    console.log(`Uploading ${fileName} to gs://${bucketName}/...`);

    await new Promise((resolve, reject) => {
      driveResponse.data
        .pipe(file.createWriteStream({
          resumable: false,
          metadata: {
            contentType: mimeType
          }
        }))
        .on('error', reject)
        .on('finish', resolve);
    });

    console.log(`Successfully synced ${fileName} to GCS.`);
    res.status(200).json({
      message: 'Sync successful',
      file: fileName,
      bucket: bucketName
    });

  } catch (error) {
    console.error('Error in syncService:', error);
    res.status(500).send(`Internal Server Error: ${error.message}`);
  }
};

/**
 * Cloud Function to sync an entire Drive folder.
 * Recursively walks the Drive folder, preserves relative paths for GCS uploads,
 * and ignores files located in the root Drive folder.
 */
exports.syncAll = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed. Expected POST.');
    }

    const resourceState = req.headers['x-goog-resource-state'];
    if (resourceState === 'sync') {
      console.log('Received Drive webhook sync handshake, acknowledging.');
      return res.status(200).send('OK');
    } else if (resourceState) {
      console.log(`Received Drive webhook resource change event: ${resourceState}`);
    }
    
    // For Drive webhooks, the folderId is typically passed in the channel token
    const folderId = req.body.folderId || req.query.folderId || req.headers['x-goog-channel-token'] || process.env.DRIVE_FOLDER_ID;
    if (!folderId) {
      return res.status(400).send('Bad Request: Missing "folderId" parameter.');
    }

    console.log(`Received sync-all trigger for Drive folderId: ${folderId}`);

    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    const drive = google.drive({ version: 'v3', auth });
    const bucket = storage.bucket(bucketName);

    const syncedFiles = [];
    const ignoredFiles = [];

    async function traverse(currentFolderId, pathPrefix) {
      let pageToken = null;
      let items = [];
      
      do {
        const resList = await drive.files.list({
          q: `'${currentFolderId}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id, name, mimeType)',
          pageToken: pageToken,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true
        });
        if (resList.data.files) {
          items.push(...resList.data.files);
        }
        pageToken = resList.data.nextPageToken;
      } while (pageToken);

      for (const item of items) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          const nextPrefix = pathPrefix + item.name + '/';
          await traverse(item.id, nextPrefix);
        } else {
          // Ignore files located in the root Drive folder
          if (currentFolderId === folderId) {
            console.log(`Ignoring root file: ${item.name}`);
            ignoredFiles.push(item.name);
            continue;
          }

          const fullPath = pathPrefix + item.name;
          console.log(`Syncing ${fullPath}`);
          
          let uploadMimeType = item.mimeType;
          if (item.name.toLowerCase().endsWith('.html')) {
            uploadMimeType = 'text/html';
          }
          
          try {
            const driveResponse = await drive.files.get(
              { fileId: item.id, alt: 'media' },
              { responseType: 'stream' }
            );
            
            const file = bucket.file(fullPath);
            await new Promise((resolve, reject) => {
              driveResponse.data
                .pipe(file.createWriteStream({
                  resumable: false,
                  metadata: {
                    contentType: uploadMimeType
                  }
                }))
                .on('error', reject)
                .on('finish', resolve);
            });
            syncedFiles.push(fullPath);
          } catch (err) {
            console.error(`Error syncing ${fullPath}:`, err.message);
          }
        }
      }
    }

    await traverse(folderId, '');

    // Deletion reconciliation
    console.log('Reconciling deleted files in GCS...');
    const [allGcsFiles] = await bucket.getFiles();
    const syncedSet = new Set(syncedFiles);
    const deletedFiles = [];

    for (const file of allGcsFiles) {
      if (!syncedSet.has(file.name)) {
        console.log(`Deleting orphaned file in GCS: ${file.name}`);
        try {
          await file.delete();
          deletedFiles.push(file.name);
        } catch (err) {
          console.error(`Error deleting ${file.name}:`, err.message);
        }
      }
    }

    console.log(`Sync-all completed for folderId: ${folderId}`);
    res.status(200).json({
      message: 'Sync-all completed',
      syncedFiles,
      ignoredFiles,
      deletedFiles,
      bucket: bucketName
    });

  } catch (error) {
    console.error('Error in syncAll:', error);
    res.status(500).send(`Internal Server Error: ${error.message}`);
  }
};

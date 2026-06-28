const { google } = require('googleapis');
const crypto = require('crypto');

async function watchFolder() {
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });

    const folderId = process.env.DRIVE_FOLDER_ID;
    if (!folderId) throw new Error('DRIVE_FOLDER_ID env var is required');
    const serviceUrl = process.env.SERVICE_URL;
    if (!serviceUrl) throw new Error('SERVICE_URL env var is required');
    const channelId = crypto.randomUUID();

    console.log(`Registering watch for folder: ${folderId}`);
    console.log(`Using channel ID: ${channelId}`);

    const response = await drive.files.watch({
      fileId: folderId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: `${serviceUrl}/sync-all`,
        token: folderId
      }
    });

    console.log('Success:', response.data);
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
  }
}

watchFolder();
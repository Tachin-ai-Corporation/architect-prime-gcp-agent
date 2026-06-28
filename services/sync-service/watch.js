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

    console.log(`Setting up watch for folder ID: ${folderId}`);
    console.log(`Using Channel ID: ${channelId}`);
    console.log(`Target URL: ${serviceUrl}`);

    const response = await drive.files.watch({
      fileId: folderId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: serviceUrl,
        payload: true
      }
    });

    console.log('Watch channel created successfully!');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error creating watch channel:', error.message);
    if (error.response) {
      console.error(error.response.data);
    }
  }
}

watchFolder();
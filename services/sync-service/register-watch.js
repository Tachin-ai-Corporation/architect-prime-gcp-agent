const { google } = require('googleapis');
const crypto = require('crypto');

async function watchFolder() {
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });

    const folderId = '1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV';
    const channelId = crypto.randomUUID();

    console.log(`Registering watch for folder: ${folderId}`);
    console.log(`Using channel ID: ${channelId}`);

    const response = await drive.files.watch({
      fileId: folderId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: 'https://sync-service-85486025845.us-central1.run.app/sync-all',
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
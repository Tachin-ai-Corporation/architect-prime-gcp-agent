const { google } = require('googleapis');
const crypto = require('crypto');

async function watchFolder() {
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });

    // Use the folder created or the target Drive folder
    const folderId = '1NmUo6DK4H7HB_EhG77pJZyjND2JCxylf';
    const channelId = crypto.randomUUID();

    console.log(`Setting up watch for folder ID: ${folderId}`);
    console.log(`Using Channel ID: ${channelId}`);
    console.log(`Target URL: https://sync-service-85486025845.us-central1.run.app`);

    const response = await drive.files.watch({
      fileId: folderId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: 'https://sync-service-85486025845.us-central1.run.app',
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
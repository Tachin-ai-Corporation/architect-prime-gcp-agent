const { google } = require('googleapis');
const crypto = require('crypto');

async function registerWatch(req, res) {
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });

    const folderId = process.env.DRIVE_FOLDER_ID || '1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV';
    const channelId = crypto.randomUUID();
    // Drive files.watch() sends raw HTTP POST notifications to the address.
    // Must point to the sync-service's own /sync-all endpoint (NOT a Pub/Sub topic URL).
    const serviceUrl = process.env.SERVICE_URL || 'https://sync-service-m32774wz2q-uc.a.run.app';
    const address = `${serviceUrl}/sync-all`;

    console.log(`Registering watch for folder: ${folderId}`);
    console.log(`Using channel ID: ${channelId}`);
    console.log(`Using webhook address: ${address}`);

    const response = await drive.files.watch({
      fileId: folderId,
      supportsAllDrives: true,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: address,
        token: folderId
      }
    });

    console.log('Success:', response.data);
    res.status(200).send(response.data);
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response && error.response.data) {
      console.error(JSON.stringify(error.response.data, null, 2));
      res.status(500).send(error.response.data);
    } else {
      res.status(500).send({ error: error.message });
    }
  }
}

module.exports = { registerWatch };

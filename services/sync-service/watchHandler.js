const { google } = require('googleapis');
const crypto = require('crypto');

const PUBLIC_FOLDER_ID = process.env.DRIVE_PUBLIC_FOLDER_ID;
if (!PUBLIC_FOLDER_ID) throw new Error('DRIVE_PUBLIC_FOLDER_ID env var is required');
const ROOT_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
if (!ROOT_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID env var is required');

async function registerWatch(req, res) {
  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });

    const serviceUrl = process.env.SERVICE_URL;
    if (!serviceUrl) throw new Error('SERVICE_URL env var is required');
    const address = `${serviceUrl}/sync-all`;

    // Register watches on BOTH the root folder AND the public subfolder.
    // files.watch() only detects changes to the watched item itself, NOT its children.
    // Watching the public subfolder ensures notifications fire when files are added to /public/.
    const foldersToWatch = [
      { id: ROOT_FOLDER_ID, label: 'root' },
      { id: PUBLIC_FOLDER_ID, label: 'public' }
    ];

    const results = [];
    for (const folder of foldersToWatch) {
      const channelId = crypto.randomUUID();
      console.log(`Registering watch for ${folder.label} folder: ${folder.id}`);
      console.log(`Using channel ID: ${channelId}`);
      console.log(`Using webhook address: ${address}`);

      try {
        const response = await drive.files.watch({
          fileId: folder.id,
          supportsAllDrives: true,
          requestBody: {
            id: channelId,
            type: 'web_hook',
            address: address,
            // Pass ROOT folder ID as token so sync-all traverses from root
            token: ROOT_FOLDER_ID
          }
        });
        console.log(`Watch registered for ${folder.label}:`, response.data);
        results.push({ folder: folder.label, ...response.data });
      } catch (err) {
        console.error(`Watch registration failed for ${folder.label}:`, err.message);
        results.push({ folder: folder.label, error: err.message });
      }
    }

    res.status(200).send(results);
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

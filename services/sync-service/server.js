const express = require('express');
const { syncService, syncAll } = require('./index');
const { registerWatch } = require('./watchHandler');

const app = express();
app.use(express.json());

const FOLDER_ID = process.env.DRIVE_FOLDER_ID;
if (!FOLDER_ID) throw new Error('DRIVE_FOLDER_ID env var is required');

// Legacy routes
app.post('/', syncService);
app.post('/syncService', syncService);
app.post('/sync-all', syncAll);

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Pub/Sub push handler — receives messages from the drive-events topic
app.post('/pubsub/drive-event', async (req, res) => {
  console.log('Received Pub/Sub push event');
  try {
    res.status(204).send();
    // Create a mock request with the folderId so syncAll can process it
    const mockReq = { method: 'POST', body: { folderId: FOLDER_ID }, headers: {} };
    const mockRes = { send: () => {}, status: () => ({ send: () => {}, json: () => {} }), json: () => {} };
    await syncAll(mockReq, mockRes);
  } catch (error) {
    console.error('Error handling pubsub event:', error);
  }
});

app.post('/renew-watch', registerWatch);

// Auto-register watch on startup
(async () => {
  try {
    console.log('Auto-registering Drive watch on startup...');
    const mockReq = {};
    const mockRes = {
      status: (code) => ({ send: (data) => console.log(`Watch registration returned ${code}:`, JSON.stringify(data)) }),
      send: (data) => console.log('Watch registration:', JSON.stringify(data))
    };
    await registerWatch(mockReq, mockRes);
  } catch (error) {
    console.error('Auto-register watch failed:', error.message);
  }
})();

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
